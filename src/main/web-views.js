'use strict';

/**
 * 内嵌网页视图：每个「网页预览」是一个 WebContentsView，叠在主窗口内容区上。
 *
 * 渲染进程不直接创建视图，只通过 web:sync 声明「现在需要哪些地址、占哪块矩形」，
 * 这里负责增删、导航与几何同步。键是规范化后的地址而不是窗格 id：固定一列时
 * 窗格会换一个，但地址不变，视图就能原地留下（滚动位置与登录态都不丢）。
 *
 * 安全边界（与 docs/agents/security.md 保持一致）：
 *   - 只接受 http(s)，地址一律过 normalizeWebUrl；
 *   - 独立 persist:web-docs 会话，不挂 preload，sandbox + contextIsolation；
 *   - 权限默认拒绝（只放行复制用的 clipboard-sanitized-write）；
 *   - 页面里的新窗口交给系统浏览器，下载一律拦截；
 *   - file: / javascript: / 自定义协议不能导航。
 */

const { WebContentsView, session, shell, Menu } = require('electron');
const { normalizeWebUrl } = require('./web-url');

const PARTITION = 'persist:web-docs';
/** 同时存在的网页视图上限（临时列 + 3 个固定列，留一点余量） */
const MAX_VIEWS = 8;

let win = null;
let sessionConfigured = false;
/** url -> { url, view, wc, rect, visible, loaded, failed, crashed } */
const views = new Map();

function send(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('web:state', payload);
}

function configureSession() {
  if (sessionConfigured) return;
  sessionConfigured = true;
  const ses = session.fromPartition(PARTITION);
  // 在线文档的「复制」按钮走 clipboard-sanitized-write；其余（摄像头、定位、
  // 通知、剪贴板读取…）一律拒绝
  const allow = (permission) => permission === 'clipboard-sanitized-write';
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allow(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allow(permission));
  // 网页视图与宿主不是同一个会话，pv:// 处理器不会挂到这里；再显式拦一次，
  // 防止将来有人把协议处理器挪到共享会话后，远程页面能顺着它读工作区
  ses.webRequest.onBeforeRequest({ urls: ['pv://*/*', 'file://*/*'] }, (_details, callback) => {
    callback({ cancel: true });
  });
  ses.on('will-download', (event) => {
    event.preventDefault();
    send({ status: 'download-blocked' });
  });
}

function scrubbedUserAgent(wc) {
  return wc.getUserAgent()
    .replace(/\sElectron\/[\d.]+/g, '')
    .replace(/\s(?:lit[- ]explorer|Lit Explorer)\/[\d.]+/gi, '');
}

function clampRect(raw) {
  if (!raw || typeof raw !== 'object' || !win || win.isDestroyed()) return null;
  const size = win.getContentSize();
  const cw = size[0];
  const ch = size[1];
  let x = Number(raw.x);
  let y = Number(raw.y);
  let width = Number(raw.width);
  let height = Number(raw.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  x = Math.round(x);
  y = Math.round(y);
  width = Math.round(width);
  height = Math.round(height);
  if (width < 2 || height < 2) return null;
  x = Math.max(0, Math.min(x, cw - 2));
  y = Math.max(0, Math.min(y, ch - 2));
  width = Math.max(2, Math.min(width, cw - x));
  height = Math.max(2, Math.min(height, ch - y));
  return { x: x, y: y, width: width, height: height };
}

/** 只有「已加载完成、没失败、渲染进程要求显示」同时成立才真正露出来 */
function apply(rec) {
  if (!rec || !win || win.isDestroyed()) return;
  const show = !!rec.visible && rec.loaded && !rec.failed;
  if (rec.rect) rec.view.setBounds(rec.rect);
  if (show && rec.rect) {
    rec.view.setVisible(true);
    return;
  }
  // 视图藏起来时，如果焦点还在它身上，要把焦点还给宿主界面，
  // 否则弹层里的输入框收不到键盘（网页表单就是这样打开的）
  let hadFocus = false;
  try { hadFocus = rec.wc.isFocused(); } catch { /* 已销毁 */ }
  rec.view.setVisible(false);
  if (hadFocus && !win.webContents.isDestroyed()) win.webContents.focus();
}

function destroyRec(rec) {
  if (!rec) return;
  views.delete(rec.url);
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(rec.view);
  } catch { /* 窗口已经没了 */ }
  try {
    rec.wc.close();
  } catch { /* 已经关闭 */ }
}

function destroyAll() {
  for (const rec of Array.from(views.values())) destroyRec(rec);
  views.clear();
}

function create(url) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      spellcheck: false,
      webviewTag: false,
      safeDialogs: true
    }
  });
  const wc = view.webContents;
  const rec = {
    url: url,
    view: view,
    wc: wc,
    rect: null,
    visible: false,
    loaded: false,
    failed: false,
    crashed: false
  };
  views.set(url, rec);

  win.contentView.addChildView(view);
  view.setBackgroundColor('#ffffff');
  view.setBounds({ x: 0, y: 0, width: 2, height: 2 });
  view.setVisible(false);
  wc.setUserAgent(scrubbedUserAgent(wc));

  // 页面里的 target=_blank / window.open 一律交给系统浏览器；
  // mailto: 这类也走系统默认程序，其余协议直接丢掉
  wc.setWindowOpenHandler(({ url: target }) => {
    const safe = normalizeWebUrl(target);
    if (safe) shell.openExternal(safe);
    else if (/^mailto:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, target) => {
    if (normalizeWebUrl(target)) return;
    event.preventDefault();
    if (/^mailto:/i.test(target)) shell.openExternal(target);
  });
  wc.on('will-redirect', (event, target) => {
    if (!normalizeWebUrl(target)) event.preventDefault();
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());

  // 页面里的右键菜单：复制文档文字、编辑输入框、前进后退、重新加载、外开
  wc.on('context-menu', (_event, params) => {
    if (!win || win.isDestroyed()) return;
    const items = [];
    if (params.isEditable) {
      items.push({ role: 'cut', label: '剪切' });
      items.push({ role: 'copy', label: '复制' });
      items.push({ role: 'paste', label: '粘贴' });
      items.push({ role: 'selectAll', label: '全选' });
      items.push({ type: 'separator' });
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: '复制' });
      items.push({ type: 'separator' });
    }
    const history = wc.navigationHistory;
    items.push({ label: '后退', enabled: history.canGoBack(), click: () => history.goBack() });
    items.push({ label: '前进', enabled: history.canGoForward(), click: () => history.goForward() });
    items.push({ label: '重新加载', click: () => beginReload(rec) });
    const current = normalizeWebUrl(wc.getURL());
    if (current) {
      items.push({ label: '在浏览器中打开', click: () => shell.openExternal(current) });
    }
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  wc.on('did-start-loading', () => {
    // 子框架的加载也会让这个事件触发；只有主框架开始加载才把视图收起来，
    // 否则页面里的一个 iframe 就能让已加载的视图在下次同步时被藏掉
    if (!wc.isLoadingMainFrame()) return;
    rec.loaded = false;
    if (!rec.failed) send({ url: url, status: 'loading' });
  });
  wc.on('did-finish-load', () => {
    rec.loaded = true;
    rec.failed = false;
    rec.crashed = false;
    send({ url: url, status: 'loaded', currentUrl: wc.getURL(), title: wc.getTitle() });
    apply(rec);
  });
  wc.on('did-fail-load', (_event, code, desc, failedUrl, isMainFrame) => {
    // -3 是「被新的导航取消」，属于正常现象
    if (!isMainFrame || code === -3) return;
    rec.loaded = false;
    rec.failed = true;
    apply(rec);
    send({ url: url, status: 'error', code: code, desc: desc, failedUrl: failedUrl });
  });
  wc.on('did-navigate', (_event, target) => {
    send({ url: url, status: 'navigated', currentUrl: target, title: wc.getTitle() });
  });
  wc.on('did-navigate-in-page', (_event, target) => {
    send({ url: url, status: 'navigated', currentUrl: target, title: wc.getTitle() });
  });
  wc.on('page-title-updated', (_event, title) => {
    send({ url: url, status: 'title', title: title });
  });
  wc.on('render-process-gone', (_event, details) => {
    rec.loaded = false;
    rec.failed = true;
    rec.crashed = true;
    apply(rec);
    send({ url: url, status: 'gone', reason: details && details.reason });
  });

  // 焦点在网页里时，宿主收不到快捷键。只接管浏览器的通用键：
  //   Ctrl+F 转给宿主提示（网页列没有预览内查找）
  //   Alt+← / → 历史前进后退，F5 / Ctrl+R 重新加载
  // 不接管 Ctrl+B 等编辑快捷键（在线文档里它们是加粗）。
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (input.control && key === 'f') {
      event.preventDefault();
      send({ url: url, status: 'key', key: 'f' });
      return;
    }
    const history = wc.navigationHistory;
    if (input.alt && key === 'arrowleft' && history.canGoBack()) {
      event.preventDefault();
      history.goBack();
      return;
    }
    if (input.alt && key === 'arrowright' && history.canGoForward()) {
      event.preventDefault();
      history.goForward();
      return;
    }
    if (key === 'f5' || (input.control && key === 'r')) {
      event.preventDefault();
      beginReload(rec);
    }
  });

  wc.loadURL(url).catch(() => {});
  return rec;
}

function beginReload(rec) {
  // 渲染进程已经没了：reload 不会复活它，销毁后交给下一次 sync 重建
  if (rec.crashed) {
    destroyRec(rec);
    return;
  }
  rec.failed = false;
  rec.loaded = false;
  apply(rec);
  send({ url: rec.url, status: 'loading' });
  try {
    rec.wc.reload();
  } catch { /* 已销毁 */ }
}

/**
 * 声明式同步。list 里每一项：{ url, visible, rect: { x, y, width, height } | null }。
 * 不在 list 里的视图一律销毁；visible=false 的保留（例如预览暂时收起），
 * 这样重新展开时不用重新登录或回到文首。
 */
function sync(list) {
  if (!win || win.isDestroyed()) return;
  const desired = new Map();
  if (Array.isArray(list)) {
    for (const raw of list.slice(0, MAX_VIEWS)) {
      if (!raw || typeof raw !== 'object') continue;
      const url = normalizeWebUrl(raw.url);
      if (!url) continue;
      const visible = !!raw.visible;
      const rect = visible ? clampRect(raw.rect) : null;
      const want = { rect: rect, visible: visible && !!rect };
      const prev = desired.get(url);
      // 同一地址出现在多个窗格（固定后临时列还没收回）时，优先显示的那一份
      if (prev && (prev.visible || !want.visible)) continue;
      desired.set(url, want);
    }
  }

  for (const rec of Array.from(views.values())) {
    if (!desired.has(rec.url)) destroyRec(rec);
  }

  for (const [url, want] of desired) {
    let rec = views.get(url);
    if (!rec) {
      try {
        rec = create(url);
      } catch (err) {
        // 创建失败（会话 / 渲染进程起不来）也要让界面落到失败卡片，不能一直转圈
        send({ url: url, status: 'error', code: 'VIEW_FAILED', desc: err && err.message });
        continue;
      }
    }
    rec.rect = want.rect;
    rec.visible = want.visible;
    apply(rec);
  }
}

function reload(raw) {
  const url = normalizeWebUrl(raw);
  const rec = url ? views.get(url) : null;
  if (!rec) return false;
  beginReload(rec);
  return true;
}

function attachWindow(w) {
  if (win === w) return;
  destroyAll();
  win = w;
  configureSession();
  w.on('closed', () => {
    if (win !== w) return;
    destroyAll();
    win = null;
  });
}

module.exports = {
  PARTITION: PARTITION,
  attachWindow: attachWindow,
  sync: sync,
  reload: reload,
  destroyAll: destroyAll,
  /** 测试用：当前存在几个网页视图 */
  count: () => views.size
};
