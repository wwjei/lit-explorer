'use strict';

// 大目录批量 stat 会密集使用线程池，提前放大以免成为瓶颈
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, protocol, nativeImage } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

const fsApi = require('./fs-api');
const store = require('./store');
const stateSanitize = require('./state-sanitize');
const webViews = require('./web-views');
const webUrl = require('./web-url');
const contracts = require('../shared/contracts');

const DEV_ROOT = path.join(__dirname, '..', '..');
const DEV = process.argv.includes('--dev');
const SHOT = argValue('--shot=');
const SHOT_JS = argValue('--shot-js=');
const SHOT_DELAY = Number(argValue('--shot-delay=') || 1400);
const OPEN_ARG = argValue('--open=');

/** 打包后这些文件在 resources 下，asar 内的路径 shell.openPath 打不开 */
function assetPath(name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(DEV_ROOT, name);
}

let win = null;

function argValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    'lit explorer',
    '',
    '  --open=<dir>       启动时打开指定工作区',
    '  --dev              启动时打开开发者工具',
    '',
    '截图钩子（调试用：加载完成后截图并退出）',
    '  --shot=<file>      截图写到该文件',
    '  --shot-js=<file>   截图前先执行该 JS 文件，其返回值会打印到 stdout',
    '  --shot-delay=<ms>  截图前等待时长，默认 1400',
    '',
    '例：npm run shot -- --open="./sample-project" --shot=".tmp/shot.png"'
  ].join('\n'));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 预览专用协议：pv://local/<绝对路径>
 * 用自定义协议而不是 file://，这样 HTML 预览里的相对资源（css/js/图片）
 * 能正常解析，同时可以把访问范围限制在工作区内。
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pv',
    // corsEnabled 让预览页里的 ES module / fetch 能请求 pv:// 资源
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

function filePathFromUrl(rawUrl) {
  let p = decodeURIComponent(new URL(rawUrl).pathname);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // Windows 盘符前会多一个斜杠
  return p;
}

function toPreviewUrl(filePath) {
  const abs = path.resolve(filePath);
  const normalized = abs.split(path.sep).join('/');
  const prefix = normalized.startsWith('/') ? '' : '/';
  return 'pv://local' + prefix + normalized.split('/').map(encodeURIComponent).join('/');
}

/* ------------------------------------------------------------------ *
 * Markdown 图片地址 -> pv://
 * 本地地址相对 md 文件所在目录；以 / 或 \ 开头的按工作区根。
 * 每个候选都过 assertAllowed()：越界（含 junction / 符号链接）一律拒绝。
 * ------------------------------------------------------------------ */
const IMG_SRC_MAX = 2048;
const IMG_MAX_PER_DOC = contracts.MAX_MD_IMAGES;
const IMG_MAX_BYTES = 32 * 1024 * 1024;

function codedError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/** 图片 / HTML / PDF 的预览地址都带文件版本，保存后重新渲染才能拿到新内容 */
function previewVersion(st) {
  return '?v=' + Math.round(st.mtimeMs) + '-' + st.size;
}

/** 去掉 <> 包裹、片段与查询串并解码；控制字符 / 协议头 / UNC 一律判无效 */
function cleanImageSrc(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.length > IMG_SRC_MAX) return '';
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  // 本地文件没有查询串与片段；文件名里真带 # 的会落到「文件不存在」
  s = s.replace(/[?#].*$/, '');
  try { s = decodeURIComponent(s); } catch { /* 保持原样 */ }
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return '';
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  // 单字母是 Windows 盘符；UNC 路径会真的去连网络主机，也不收
  if ((scheme && scheme[1].length > 1) || s.startsWith('//') || s.startsWith('\\\\')) return '';
  return s;
}

async function resolveImageTargets(mdPath, srcs) {
  const base = await fsApi.assertAllowed(mdPath);
  const dir = path.dirname(base);
  // openWorkspace() 每次都先 resetAllowedRoots() 再只允许当前根，所以这里唯一的一项
  // 就是当前工作区；将来真有多个授权根，这个取法要跟着改。
  const root = fsApi.allowedRootList()[0];
  return Promise.all(srcs.slice(0, IMG_MAX_PER_DOC).map(async (raw) => {
    const src = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
    try {
      const clean = cleanImageSrc(src);
      if (!clean) throw codedError('EBAD_SRC');
      const abs = /^[\\/]/.test(clean) && root
        ? path.resolve(root, clean.replace(/^[\\/]+/, ''))
        : path.resolve(dir, clean);
      const real = await fsApi.assertAllowed(abs);
      const st = await fsp.stat(real);
      if (!st.isFile()) throw codedError('ENOT_FILE');
      if (st.size > IMG_MAX_BYTES) throw codedError('ETOO_LARGE');
      const kind = fsApi.kindFor(real);
      if (kind !== 'image' && kind !== 'svg') throw codedError('ENOT_IMAGE');
      // 与 fs:preview-url 一样带文件版本：改了图再刷新要拿到新内容
      return { src: src, url: toPreviewUrl(real) + previewVersion(st) };
    } catch (err) {
      return { src: src, error: (err && err.code) || 'EIMG' };
    }
  }));
}

function registerPreviewProtocol() {
  protocol.handle('pv', async (request) => {
    let abs;
    try {
      abs = await fsApi.assertAllowed(filePathFromUrl(request.url));
    } catch {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await fsp.readFile(abs);
      return new Response(data, {
        headers: {
          'content-type': fsApi.mimeFor(abs),
          'cache-control': 'no-store',
          // 预览 iframe 是不透明源（sandbox 无 allow-same-origin），
          // ES module / fetch 会走 CORS，必须允许跨源读取
          'access-control-allow-origin': '*'
        }
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */
async function createWindow() {
  const state = await store.load();
  // 只取窗口几何字段：state.window 不能整份摊进 BrowserWindow 参数，
  // 否则 webPreferences（sandbox / contextIsolation / nodeIntegration）可被持久化覆盖
  const bounds = stateSanitize.windowBounds(state.window);

  // 主进程给过渲染进程的目录：命令行指定、上次的、最近打开过的。
  // 渲染进程只能从这些里挑着打开（见 workspace:open 的处理）。
  fsApi.offerRoot(OPEN_ARG);
  fsApi.offerRoot(state.lastRoot);
  for (const recent of state.recentRoots || []) fsApi.offerRoot(recent);
  // 项目快捷切换里的项目也要登记：它们可能已经不在 recentRoots 的 8 个名额里
  for (const p of state.projects || []) if (p && p.path) fsApi.offerRoot(p.path);

  win = new BrowserWindow(Object.assign(
    {
      width: 1440,
      height: 900,
      minWidth: 900,
      minHeight: 560,
      show: false,
      // 无边框：不要 Windows 原生标题栏与菜单栏，标题栏由界面自绘
      frame: false,
      backgroundColor: state.theme === 'dark' ? '#0f1115' : '#f5f6f8',
      title: 'lit explorer',
      // 打包后窗口/任务栏图标来自 exe 自身，开发时才需要显式指定
      icon: app.isPackaged ? undefined : path.join(DEV_ROOT, 'build', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // PDF 预览用 Chromium 内置阅读器（<iframe> 加载 application/pdf）
        plugins: true,
        spellcheck: false
      }
    },
    bounds || {}
  ));

  win.once('ready-to-show', () => win.show());
  // 内嵌网页视图挂在窗口的 contentView 上；窗口关闭时由它自己清理
  webViews.attachWindow(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 最大化状态要回传给界面，用于切换按钮图标与去掉窗口描边
  const sendMaximized = () => {
    if (win && !win.isDestroyed()) win.webContents.send('window:maximized', win.isMaximized());
  };
  win.on('maximize', sendMaximized);
  win.on('unmaximize', sendMaximized);

  // 菜单栏已移除，开发者工具保留 F12 入口
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 外链一律交给系统浏览器，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    store.patch({ window: win.getNormalBounds() });
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  if (DEV) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.once('did-finish-load', async () => {
    const root = OPEN_ARG || state.lastRoot;
    if (root) {
      const res = await openWorkspace(root, { silent: true });
      // 上次的工作区可能已被删除，这时要让界面回到欢迎页而不是留一片空白
      if (!res || res.error) win.webContents.send('app:no-workspace');
    }
    if (SHOT) await captureAndQuit();
  });
}

async function captureAndQuit() {
  try {
    await new Promise((r) => setTimeout(r, SHOT_DELAY));
    if (SHOT_JS) {
      const code = await fsp.readFile(path.resolve(SHOT_JS), 'utf8');
      const result = await win.webContents.executeJavaScript(code, true);
      if (result !== undefined) console.log('[shot-js]', JSON.stringify(result));
      await new Promise((r) => setTimeout(r, 1400));
    }
    const image = await win.webContents.capturePage();
    const out = path.resolve(SHOT);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, image.toPNG());
    console.log('[shot] ' + out);
  } catch (err) {
    console.error('[shot] failed: ' + err.message);
  }
  app.exit(0);
}

/* ------------------------------------------------------------------ *
 * 工作区
 * ------------------------------------------------------------------ */
/** 每次切换工作区递增；后发起的切换获胜，先发起的不许再登记授权根 */
let workspaceSeq = 0;

async function openWorkspace(dir, options = {}) {
  const seq = ++workspaceSeq;
  const abs = path.resolve(dir);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) {
    if (!options.silent) {
      dialog.showMessageBox(win, {
        type: 'warning',
        message: '无法打开该目录',
        detail: abs + '\n\n目录不存在或不可访问。'
      });
    }
    return { error: 'NOT_A_DIRECTORY' };
  }

  // 登记并统一使用真实路径：用户可能挑了一个符号链接 / junction，
  // 后续所有路径校验都在真实路径上做，界面里也用同一份地址。
  // 先异步解析，再同步「清空 + 登记」：两次切换重叠时，先发起的那次若在
  // 后一次清空之后才登记，就会留下两个授权根（A 已切走却仍然可读）。
  const root = await fsApi.resolveReal(abs);
  if (seq !== workspaceSeq) return { error: 'SUPERSEDED' };
  fsApi.resetAllowedRoots();
  fsApi.allowResolvedRoot(root);
  // 打开过的目录也算「给过渲染进程」：它之后可以再打开一次
  fsApi.offerRoot(root);
  const state = await store.load();
  const recent = [root, ...(state.recentRoots || []).filter((p) => p !== root)].slice(0, 8);
  await store.patch({ lastRoot: root, recentRoots: recent });
  win.setTitle(path.basename(root) + ' · lit explorer');
  win.webContents.send('workspace:opened', root);
  return { root: root };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('workspace:sample', () => fsApi.offerRoot(assetPath('sample-project')));

  ipcMain.handle('workspace:pick', () => pickFolderAndOpen());

  // 只接受主进程给过的目录（示例项目、最近打开、上次的工作区、已打开过的）。
  // 渲染进程不能凭自己拼的路径把任意现存目录登记成新的授权根——授权决策留在主进程。
  ipcMain.handle('workspace:open', async (_e, dir) => {
    if (!fsApi.isOfferedRoot(dir)) return { error: 'NOT_OFFERED' };
    return openWorkspace(dir);
  });

  // 项目图标：用户挑一张图片，主进程缩到 64px 再交出去。
  // 渲染进程拿到的只是 data URL，不能借这个口子读任意文件。
  ipcMain.handle('projects:pick-icon', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择项目图标',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'bmp'] }]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    try {
      const img = nativeImage.createFromPath(res.filePaths[0]);
      if (img.isEmpty()) return { error: 'BAD_IMAGE' };
      const size = img.getSize();
      const scale = 64 / Math.max(size.width || 1, size.height || 1);
      const resized = img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best'
      });
      return { dataUrl: resized.toDataURL() };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('fs:list', async (_e, dir) => {
    try {
      const { dir: abs, entries } = await fsApi.listDir(dir);
      // 元信息（大小/修改时间）异步补发，不阻塞首屏
      fsApi.statEntries(abs, entries)
        .then((metas) => {
          if (win && !win.isDestroyed()) win.webContents.send('fs:meta', { dir: abs, metas });
        })
        .catch(() => {});
      return { dir: abs, entries };
    } catch (err) {
      return { error: err.code || 'ELIST', message: err.message };
    }
  });

  ipcMain.handle('fs:read', async (_e, filePath) => {
    try {
      return await fsApi.readFileForPreview(filePath);
    } catch (err) {
      return { error: err.code || 'EREAD', message: err.message };
    }
  });

  ipcMain.handle('fs:read-bytes', async (_e, filePath) => {
    try {
      return await fsApi.readFileBytes(filePath);
    } catch (err) {
      return { error: err.code || 'EREAD', message: err.message };
    }
  });

  ipcMain.handle('fs:stat', async (_e, target) => {
    try {
      return await fsApi.statPath(target);
    } catch (err) {
      return { error: err.code || 'ESTAT', message: err.message };
    }
  });

  // 唯一的写入口：只覆盖工作区内已存在的 .svg，且要带上读取时的版本
  ipcMain.handle('fs:write-svg', async (_e, filePath, content, expected) => {
    try {
      return await fsApi.writeSvgFile(filePath, content, expected);
    } catch (err) {
      return { error: err.code || 'EWRITE', message: err.message };
    }
  });

  ipcMain.handle('fs:preview-url', async (_e, filePath) => {
    try {
      const abs = await fsApi.assertAllowed(filePath);
      // 同一路径的图片会按 URL 命中 Chromium 的内存缓存，no-store 也拦不住；
      // 带上文件版本，保存后重新渲染才会取到新内容
      let version = '';
      try {
        const st = await fsp.stat(abs);
        version = previewVersion(st);
      } catch { /* 取不到版本就用不带查询串的地址，能不能读交给协议判断 */ }
      return { url: toPreviewUrl(abs) + version };
    } catch (err) {
      return { error: err.code || 'EURL' };
    }
  });

  // Markdown 里的本地图片：一次把整篇的地址解析完，渲染进程据此出 <img> 或占位
  ipcMain.handle('fs:resolve-images', async (_e, mdPath, srcs) => {
    try {
      if (!Array.isArray(srcs) || !srcs.length) return { items: [] };
      return { items: await resolveImageTargets(mdPath, srcs) };
    } catch (err) {
      return { error: err.code || 'EIMG', items: [] };
    }
  });

  ipcMain.handle('shell:open', async (_e, filePath) => {
    try {
      const abs = await fsApi.assertAllowed(filePath);
      // openPath 就是资源管理器双击的行为：交给系统文件关联
      const message = await shell.openPath(abs);
      return message ? { error: 'OPEN_FAILED', message } : { ok: true };
    } catch (err) {
      return { error: err.code || 'EOPEN', message: err.message };
    }
  });

  ipcMain.handle('shell:reveal', async (_e, filePath) => {
    try {
      shell.showItemInFolder(await fsApi.assertAllowed(filePath));
      return { ok: true };
    } catch (err) {
      return { error: err.code || 'EREVEAL', message: err.message };
    }
  });

  ipcMain.handle('clipboard:copy', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  /* 内嵌网页：渲染进程只声明「要哪些地址、占哪块矩形」，视图由主进程管理 */
  ipcMain.handle('web:sync', (_e, list) => {
    webViews.sync(list);
    return { ok: true };
  });
  ipcMain.handle('web:reload', (_e, url) => ({ ok: webViews.reload(url) }));
  // 网页列头部 / 右键菜单的「在浏览器中打开」：这是辅助出口，不是主路径
  ipcMain.handle('web:open-external', async (_e, raw) => {
    const url = webUrl.normalizeWebUrl(raw);
    if (!url) return { error: 'BAD_URL' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('app:get-state', () => store.load());
  // 渲染进程只能改界面偏好；window / lastRoot / recentRoots 由主进程自己维护
  ipcMain.handle('app:set-state', (_e, changes) =>
    store.patch(stateSanitize.sanitizePatch(changes || {}, fsApi.isOfferedRoot)));

  ipcMain.handle('ui:context-menu', (_e, payload) => showContextMenu(payload));
  ipcMain.handle('ui:app-menu', () => showAppMenu());

  /* 自绘标题栏的窗口控制 */
  ipcMain.handle('window:minimize', () => {
    win.minimize();
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    win.close();
  });
  ipcMain.handle('window:is-maximized', () => win.isMaximized());
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */
function showContextMenu(payload) {
  const target = payload && payload.path ? payload.path : null;
  const kind = payload ? payload.kind : 'empty';
  const items = [];

  // 网页快捷方式不是文件路径：不能落到下面的 openPath / showItemInFolder
  if (kind === 'web') {
    const url = webUrl.normalizeWebUrl(payload && payload.url);
    if (!url) return;
    const name = typeof payload.name === 'string' && payload.name ? payload.name : url;
    items.push({ label: '在浏览器中打开', click: () => shell.openExternal(url) });
    items.push({ label: '复制链接', click: () => clipboard.writeText(url) });
    items.push({
      label: '编辑链接…',
      click: () => win.webContents.send('app:edit-web', { url: url, name: name })
    });
    items.push({ type: 'separator' });
    items.push({
      label: '从快速访问中移除',
      click: () => win.webContents.send('app:toggle-favorite', { url: url, name: name, kind: 'web' })
    });
    items.push({ type: 'separator' });
    items.push({
      label: '重新扫描目录',
      accelerator: 'F5',
      click: () => win.webContents.send('app:rescan')
    });
    Menu.buildFromTemplate(items).popup({ window: win });
    return;
  }

  if (target && kind === 'file') {
    items.push({ label: '用默认程序打开', click: () => shell.openPath(target) });
    items.push({ type: 'separator' });
  } else if (target && kind === 'folder') {
    items.push({ label: '在资源管理器中打开', click: () => shell.openPath(target) });
    items.push({ type: 'separator' });
  }

  if (target) {
    items.push({
      label: payload && payload.favorited ? '从快速访问中移除' : '添加到快速访问',
      click: () => win.webContents.send('app:toggle-favorite', {
        path: target,
        name: path.basename(target),
        isDir: kind === 'folder'
      })
    });
    items.push({ type: 'separator' });
    items.push({ label: '复制路径', click: () => clipboard.writeText(target) });
    items.push({ label: '复制名称', click: () => clipboard.writeText(path.basename(target)) });
    items.push({ label: '在资源管理器中显示', click: () => shell.showItemInFolder(target) });
    items.push({ type: 'separator' });
  }

  items.push({
    label: '重新扫描目录',
    accelerator: 'F5',
    click: () => win.webContents.send('app:rescan')
  });

  Menu.buildFromTemplate(items).popup({ window: win });
}

/* ------------------------------------------------------------------ *
 * 应用菜单
 *
 * 不用原生菜单栏（Windows 上那一行「文件 编辑 视图 帮助」太占地方也不好看），
 * 入口收敛到标题栏的 ⋯ 按钮、右键菜单和快捷键里。
 * ------------------------------------------------------------------ */
/** 选择并打开一个工作区：按钮（workspace:pick）与菜单的 Ctrl+O 共用 */
async function pickFolderAndOpen() {
  const res = await dialog.showOpenDialog(win, {
    title: '选择项目目录',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  return openWorkspace(res.filePaths[0]);
}

async function toggleThemeFromMain() {
  const state = await store.load();
  const theme = state.theme === 'dark' ? 'light' : 'dark';
  await store.patch({ theme });
  win.webContents.send('app:theme', theme);
}

/** 切换某个预览开关，并把最新设置推回界面（正在预览的文件会立即重新渲染） */
async function togglePreviewPref(key) {
  const state = await store.load();
  const saved = await store.patch({ [key]: !(state[key] !== false) });
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:preview-prefs', {
      previewDocx: saved.previewDocx !== false,
      previewPptx: saved.previewPptx !== false
    });
  }
}

async function showAppMenu() {
  const state = await store.load();
  const items = [
    { label: '打开文件夹…', accelerator: 'Ctrl+O', click: pickFolderAndOpen },
    { label: '打开示例项目', click: () => openWorkspace(assetPath('sample-project')) },
    { type: 'separator' },
    { label: '重新扫描目录', accelerator: 'F5', click: () => win.webContents.send('app:rescan') },
    { label: '聚焦搜索框', accelerator: 'Ctrl+F', click: () => win.webContents.send('app:focus-search') },
    {
      // 原来状态栏那排按键说明，收进菜单里当图例；不是可执行命令
      label: '快捷键',
      submenu: [
        { label: '↑ / ↓　选择', enabled: false },
        { label: '→　进入目录', enabled: false },
        { label: '←　返回上级', enabled: false },
        { label: '⏎　打开文件', enabled: false },
        { label: 'Ctrl+F　预览内查找', enabled: false },
        { label: '双击　用默认程序打开', enabled: false }
      ]
    },
    { type: 'separator' },
    { label: '显示 / 隐藏预览面板', accelerator: 'Ctrl+B', click: () => win.webContents.send('app:toggle-preview') },
    { label: '切换明暗主题', accelerator: 'Ctrl+Shift+L', click: toggleThemeFromMain },
    { type: 'separator' },
    {
      label: '启用 Word (.docx) 内嵌预览',
      type: 'checkbox',
      checked: state.previewDocx !== false,
      click: () => togglePreviewPref('previewDocx')
    },
    {
      label: '启用 PPT (.pptx) 内嵌预览',
      type: 'checkbox',
      checked: state.previewPptx !== false,
      click: () => togglePreviewPref('previewPptx')
    },
    { type: 'separator' },
    { label: '开发者工具', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
    { label: '实际大小', accelerator: 'Ctrl+0', click: () => win.webContents.setZoomLevel(0) },
    { type: 'separator' },
    { label: '功能特性说明', click: () => shell.openPath(assetPath('FEATURES.md')) },
    { label: '代码高亮方案', click: () => shell.openPath(assetPath(path.join('docs', 'highlighting.md'))) },
    { label: '示例项目目录', click: () => shell.openPath(assetPath('sample-project')) }
  ];
  Menu.buildFromTemplate(items).popup({ window: win });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerPreviewProtocol();
    registerIpc();
    // 不要原生菜单栏
    Menu.setApplicationMenu(null);
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
