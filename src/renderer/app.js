/* 渲染进程主逻辑：目录导航 + 交互接线
 *
 * 预览窗格的生命周期与布局在 pane.js（PV.pane），正文与头部怎么画在
 * preview-body.js（PV.body），预览内查找在 find.js（PV.find），
 * 项目切换条与图标选择在 projects.js（PV.projects）。
 * 这个文件负责：
 *   - 多栏目录导航：加载、选中、面包屑、虚拟滚动、快速访问
 *   - 键盘、指针、顶部按钮、主进程事件，以及把上面几个模块接起来
 *
 * 加载顺序：shared/contracts.js → paths.js → icons.js → highlight.js → markdown.js →
 *           pane.js → preview-body.js → webview.js → svgedit.js →
 *           find.js → projects.js → app.js。
 */
(function () {
  'use strict';

  const { icon, nodeIcon } = PV.icons;
  const { escapeHtml: esc } = PV.highlight;

  /* 行高与虚拟滚动参数：必须与 styles.css 中 .row 的高度一致 */
  const ROW_H = 28;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 16;
  const OVERSCAN = 8;
  /** 超过这个条目数才启用虚拟滚动 */
  const VIRTUAL_MIN = 120;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const colsEl = $('#cols');
  const crumbsEl = $('#crumbs');
  const previewEl = $('#preview');

  /** 最左栏上下两个面板各自的最小高度 */
  const SPLIT_MIN = 48;
  /** 项目切换条的高度，与 styles.css 的 .proj-dock 一致 */
  const PROJ_DOCK_H = 44;

  const state = {
    root: null,
    referenceDirs: [],
    rootName: '',
    path: [],        // 每级目录节点，path[0] 是工作区根
    cols: [],        // 每栏的加载状态与原始条目
    sel: null,       // { col, node }
    mode: 'preview', // 临时预览列的「预览 / 源码」模式
    theme: 'light',
    pendingScroll: false,
    hideDot: false,          // 是否隐藏以 . 开头的条目
    previewDocx: true,       // 是否内嵌预览 .docx（设置里可关）
    previewPptx: true,       // 是否内嵌预览 .pptx（设置里可关）
    favs: [],                // 当前工作区的快速访问项 [{ path, name, isDir, kind }]
    favoritesByRoot: {},     // 持久化的快速访问项（按工作区根目录分组）
    favTop: false,           // 最左栏：快速访问面板是否在上（false = 项目根目录在上）
    splitRatio: 2 / 3        // 最左栏「上 : 下」的高度比例，跟着位置走，与哪个面板在上面无关
  };

  let renderedColKeys = [];
  let welcomeVisible = false;

  /* 工作区变更监测：已展开目录的 mtime 基线，以及「列表已经过期」的目录 */
  const dirKnown = new Map();
  const dirtyDirs = new Set();

  /* ============================ 快速访问 ============================ */
  /** 快速访问项按工作区分组；Windows 路径大小写不敏感，统一成小写作为键 */
  function favKey(dir) {
    return String(dir || '').replace(/[\\/]+$/, '').toLowerCase();
  }

  /* ---- 网页条目：地址规则与主进程 web-url.js 保持一致（进程边界无法共享实现）；
   *      数量上限来自 shared/contracts.js，两边读同一份 ---- */
  const WEB_KIND = 'web';
  const WEB_URL_MAX = PV.contracts.MAX_URL_CHARS;
  const FAV_MAX_ITEMS = PV.contracts.MAX_FAV_ITEMS;

  function normalizeWebUrl(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s || s.length > WEB_URL_MAX) return '';
    if (/[\u0000-\u001f\u007f]/.test(s)) return '';
    let u;
    try { u = new URL(s); } catch { return ''; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    return u.toString();
  }

  function webHost(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; }
  }

  function isWebFav(f) {
    return !!f && f.kind === WEB_KIND && typeof f.url === 'string' && !!f.url;
  }

  /** 一条快速访问的身份：文件是路径，网页是规范化后的地址 */
  function favIdentity(f) {
    return isWebFav(f) ? f.url : f.path;
  }

  function webNodeFromFav(fav) {
    return { name: fav.name, kind: WEB_KIND, url: fav.url, path: fav.url, isDir: false,
      ...(fav.cloudMountId ? { cloudMountId: fav.cloudMountId, cloudNodeId: fav.cloudNodeId } : {}) };
  }

  function rootForPath(path) {
    return [state.root, ...state.referenceDirs].find((root) => root && PV.paths.within(root, path));
  }

  function refreshFavorites() {
    state.favs = normalizeFavorites([
      ...(state.favoritesByRoot[favKey(state.root)] || []),
      ...state.referenceDirs.map((path) => ({ path, name: PV.paths.baseName(path), isDir: true, kind: 'folder' }))
    ]);
  }

  async function updateReferences(dirs) {
    state.referenceDirs = dirs || [];
    refreshFavorites();
    // 撤销后丢弃缓存正文与固定列，避免继续展示失去授权的内容。
    PV.pane.clearPins();
    PV.pane.resetTemp();
    await browseRoot(state.root);
  }

  async function browseRoot(root) {
    state.path = [{ path: root, name: PV.paths.baseName(root), isDir: true, kind: 'folder' }];
    state.cols = [];
    state.sel = null;
    state.mode = 'preview';
    render();
    await loadColumn(0);
    scheduleSaveNav();
  }

  function normalizeFavorites(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      let fav = null;
      if (item && typeof item === 'object' && item.kind === WEB_KIND) {
        const url = normalizeWebUrl(item.url);
        if (!url) continue;
        fav = {
          url: url,
          name: (typeof item.name === 'string' && item.name.trim()) || webHost(url) || url,
          isDir: false,
          kind: WEB_KIND
        };
      } else {
        if (typeof item === 'string') {
          fav = {
            path: item,
            name: PV.paths.baseName(item) || item,
            isDir: false,
            kind: 'txt'
          };
        } else if (item && item.path) {
          fav = {
            path: item.path,
            name: item.name || PV.paths.baseName(item.path) || item.path,
            isDir: !!item.isDir,
            kind: item.kind || (item.isDir ? 'folder' : 'txt')
          };
        }
        if (!fav) continue;
        // 收藏按当前项目及其参考目录归属：未授权的旧条目直接丢掉
        if (state.root && !rootForPath(fav.path)) continue;
      }
      const key = isWebFav(fav) ? 'w:' + fav.url : 'p:' + PV.paths.key(fav.path);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fav);
    }
    return out;
  }

  function findLoadedNode(target) {
    for (let ci = 0; ci < state.cols.length; ci++) {
      const col = state.cols[ci];
      if (!col || !col.entries) continue;
      const hit = col.entries.find((e) => PV.paths.same(e.path, target));
      if (hit) return hit;
    }
    return null;
  }

  function isFavorite(path) {
    return state.favs.some((f) => f.path && PV.paths.same(f.path, path));
  }

  function saveFavorites() {
    if (!state.root) return;
    state.favoritesByRoot[favKey(state.root)] = state.favs.slice();
    pv.setState({ favorites: state.favoritesByRoot });
  }

  function toggleFavorite(target) {
    if (!target || !target.path) return;
    if (state.referenceDirs.some((p) => PV.paths.same(p, target.path))) {
      const project = state.root;
      pv.removeReferenceDir(target.path).then(async (result) => {
        if (project !== state.root) return;
        if (result.error) { toast('移除参考目录失败：' + result.error); return; }
        await updateReferences(result.dirs);
      }).catch((err) => toast(err.message));
      return;
    }
    const node = findLoadedNode(target.path) || target;
    const at = state.favs.findIndex((f) => f.path && PV.paths.same(f.path, node.path));
    if (at >= 0) {
      state.favs.splice(at, 1);
    } else {
      state.favs.push({
        path: node.path,
        name: node.name || PV.paths.baseName(node.path) || node.path,
        isDir: !!node.isDir,
        kind: node.isDir ? 'folder' : (node.kind || 'txt')
      });
    }
    saveFavorites();
    updateRowStates();
    renderFavorites();
    toast(at >= 0 ? '已从快速访问移除：' + (node.name || '') : '已加入快速访问：' + (node.name || ''));
  }

  async function openFavorite(fav) {
    if (!state.root || !fav) return;
    if (isWebFav(fav)) { openWebFavorite(fav); return; }
    const base = rootForPath(fav.path);
    const parts = base ? PV.paths.partsUnder(base, fav.path) : null;
    if (!parts) { toast('快速访问项不在当前工作区内'); return; }
    if (!parts.length) { await browseRoot(base); return; }

    // 目标位于隐藏目录里时先恢复显示，否则导航后列中不会出现对应行
    if (state.hideDot && parts.some((p) => p.charAt(0) === '.')) {
      state.hideDot = false;
      pv.setState({ hideDot: false });
    }

    const rootNode = { name: PV.paths.baseName(base), path: base, isDir: true, kind: 'folder' };
    state.path = [rootNode];
    state.cols = [];
    state.sel = null;
    state.mode = 'preview';

    let target = null;
    let targetCol = -1;
    for (let i = 0; i < parts.length; i++) {
      await loadColumn(i);
      const col = state.cols[i];
      if (!col || col.state !== 'ready') { toast('无法打开快速访问项'); render(); return; }
      const entry = (col.entries || []).find((e) => e.name === parts[i]);
      if (!entry) { toast('快速访问项已不存在：' + parts[i]); render(); return; }
      if (i === parts.length - 1) {
        target = entry;
        targetCol = i;
      } else if (entry.isDir) {
        state.path.push(entry);
      } else {
        toast('快速访问项的路径已变化');
        render();
        return;
      }
    }
    if (!target) return;

    state.sel = { col: targetCol, node: target };
    if (target.isDir) {
      state.path.push(target);
    } else if (!PV.pane.previewOpen()) {
      setPreviewVisible(true);
    }
    state.pendingScroll = true;
    render();

    const idx = itemsOf(targetCol).findIndex((n) => n.path === target.path);
    if (idx >= 0) ensureVisible(targetCol, idx);
    if (target.isDir) await loadColumn(targetCol + 1);
  }

  /**
   * 网页快速访问：不参与目录导航，直接把它作为预览列的内容。
   * 列号取当前最后一栏，只为让 ↑↓ 还有「从哪一栏继续」可依。
   * reveal=false 用于切项目恢复：用户关掉的临时预览列不要被重新展开。
   */
  function openWebFavorite(fav, reveal) {
    // MyGo 版没有 WebContentsView，内嵌网页不可用：交给系统浏览器，不建网页窗格
    if (pv.capabilities && pv.capabilities.webPane === false) {
      pv.openExternalUrl(fav.url);
      toast('当前版本不支持内嵌网页，已用系统浏览器打开');
      return;
    }
    const node = webNodeFromFav(fav);
    state.sel = { col: Math.max(0, state.path.length - 1), node };
    state.mode = 'preview';
    if (!PV.pane.previewOpen() && reveal !== false) setPreviewVisible(true);
    render();
    scheduleSaveNav();
  }

  function removeWebFavorite(url) {
    const at = state.favs.findIndex((f) => isWebFav(f) && f.url === url);
    if (at < 0) return;
    const fav = state.favs[at];
    state.favs.splice(at, 1);
    // 临时预览列正显示这一条时一并清空（固定列里的那份不主动关，用户可自己收）
    if (state.sel && state.sel.node.kind === WEB_KIND && state.sel.node.url === url) {
      state.sel = null;
      state.mode = 'preview';
    }
    const temp = PV.pane.allPanes()[0];
    if (temp && temp.node && temp.node.kind === WEB_KIND && temp.node.url === url) {
      PV.pane.resetTemp();
    }
    saveFavorites();
    render();
    toast('已从快速访问移除：' + fav.name);
  }

  /* ---- 添加 / 编辑网页链接的小浮层 ----
   * 做成挂在 body 上的浮层而不是面板内联表单：面板每次 render() 都会重建，
   * 内联输入框会丢焦点。打开期间把网页视图藏起来，否则原生视图会盖住浮层。
   */
  let webForm = null;

  function closeWebForm(restore) {
    if (!webForm) return;
    const form = webForm;
    webForm = null;
    form.el.remove();
    document.removeEventListener('pointerdown', form.onDoc, true);
    document.removeEventListener('keydown', form.onKey, true);
    if (restore !== false && PV.web) PV.web.setOccluded(false);
  }

  function placeWebForm(el, anchor) {
    const r = el.getBoundingClientRect();
    const a = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    let left = a ? a.left : 16;
    // 默认放在按钮下方；面板在窗口底部（默认布局）时改成上方，两种情况都夹在视口里
    let top = a ? a.bottom + 8 : 72;
    if (a && top + r.height > window.innerHeight - 8) top = a.top - r.height - 8;
    left = Math.max(8, Math.min(window.innerWidth - r.width - 8, left));
    top = Math.max(8, Math.min(window.innerHeight - r.height - 8, top));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  function openWebForm(editing, anchor) {
    if (!state.root) return;
    const isEdit = !!editing;
    closeWebForm(false);
    const el = document.createElement('div');
    el.className = 'web-pop';
    el.innerHTML = '<div class="web-pop-h">' + icon('globe', '', 14)
      + '<span>' + (isEdit ? '编辑网页链接' : '添加网页链接') + '</span></div>'
      + '<label class="web-field"><span>名称</span>'
      + '<input class="web-name" type="text" maxlength="120" autocomplete="off" spellcheck="false" '
      + 'placeholder="不填就用域名"></label>'
      + '<label class="web-field"><span>链接</span>'
      + '<input class="web-url" type="url" autocomplete="off" spellcheck="false" '
      + 'placeholder="https://…"></label>'
      + '<div class="web-err" hidden></div>'
      + '<div class="web-actions"><button type="button" class="btn-quiet" data-web-cancel>取消</button>'
      + '<button type="button" class="btn-primary" data-web-ok>' + (isEdit ? '保存' : '添加') + '</button></div>';
    document.body.appendChild(el);
    const nameInput = el.querySelector('.web-name');
    const urlInput = el.querySelector('.web-url');
    const errEl = el.querySelector('.web-err');
    if (isEdit) {
      nameInput.value = editing.name || '';
      urlInput.value = editing.url || '';
    }
    placeWebForm(el, anchor);

    if (PV.web) PV.web.setOccluded(true);

    const onDoc = (e) => {
      if (!el.contains(e.target)) closeWebForm();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeWebForm();
      }
    };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);

    const fail = (msg) => {
      errEl.textContent = msg;
      errEl.hidden = false;
      urlInput.focus();
      urlInput.select();
    };

    const submit = () => {
      const url = normalizeWebUrl(urlInput.value);
      if (!url) { fail('只支持 http:// 或 https:// 开头的链接'); return; }
      if (state.favs.some((f) => isWebFav(f) && f.url === url && f !== editing)) {
        fail('这个链接已经在快速访问里');
        return;
      }
      if (!isEdit && state.favs.length >= FAV_MAX_ITEMS) {
        fail('快速访问条目太多了，先删掉一些');
        return;
      }
      const oldUrl = isEdit ? editing.url : '';
      const name = nameInput.value.trim().slice(0, 120) || webHost(url) || url;
      if (isEdit) {
        editing.url = url;
        editing.name = name;
      } else {
        state.favs.push({ url: url, name: name, kind: WEB_KIND, isDir: false });
      }
      // 正在预览的就是这一条：让所有展示它的窗格跟着改名 / 换地址
      if (isEdit) {
        for (const pane of PV.pane.allPanes()) {
          const node = pane.node;
          if (!node || node.kind !== WEB_KIND || node.url !== oldUrl) continue;
          node.url = url;
          node.path = url;
          node.name = name;
          if (oldUrl !== url) {
            node.webCurrentUrl = '';
            node.webError = null;
          }
        }
      }
      saveFavorites();
      closeWebForm();
      render();
      toast((isEdit ? '已更新网页链接：' : '已添加网页链接：') + name);
    };

    el.querySelector('[data-web-cancel]').addEventListener('click', () => closeWebForm());
    el.querySelector('[data-web-ok]').addEventListener('click', submit);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
    });

    const mine = { el: el, onDoc: onDoc, onKey: onKey };
    webForm = mine;
    // 先把网页视图藏起来、宿主拿回焦点，再聚焦输入框
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (webForm !== mine) return;
      (isEdit ? nameInput : urlInput).focus();
      if (isEdit) nameInput.select();
    }));
  }

  /** 主进程的网页状态：更新头部地址、把失败落到正文卡片 */
  function handleWebState(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.status === 'download-blocked') {
      toast('网页下载已被拦截，请在浏览器中打开');
      return;
    }
    if (ev.status === 'key') {
      if (ev.key === 'f') toast('网页列暂不支持预览内查找');
      return;
    }
    if (!ev.url) return;

    let touched = false;
    for (const pane of PV.pane.allPanes()) {
      const node = pane.node;
      if (!node || node.kind !== WEB_KIND || node.url !== ev.url) continue;
      touched = true;
      if (ev.status === 'loading') {
        node.webError = null;
      } else if (ev.status === 'loaded') {
        node.webError = null;
        node.webCurrentUrl = ev.currentUrl || node.url;
      } else if (ev.status === 'navigated') {
        node.webCurrentUrl = ev.currentUrl || node.url;
      } else if (ev.status === 'error') {
        node.webError = { code: ev.code, desc: ev.desc };
      } else if (ev.status === 'gone') {
        node.webError = { code: 'RENDER_GONE', desc: ev.reason };
      }
      PV.pane.renderPane(pane,
        ev.status === 'error' || ev.status === 'gone' || ev.status === 'loading');
    }
    if (touched && PV.web) PV.web.schedule();
  }

  /** 快速访问的一行：栏内启动列表与最左栏面板共用同一套标记 */
  function favRowHtml(f, selKey) {
    const key = favIdentity(f);
    const web = isWebFav(f);
    const title = web ? f.url : (state.referenceDirs.some((p) => PV.paths.same(p, f.path)) ? '外部参考目录（只读）：' : '') + f.path;
    return '<div class="row fav-row' + (key === selKey ? ' is-sel' : '') + (web ? ' is-web' : '')
      + '" data-fav-key="' + esc(key) + '" title="' + esc(title) + '" role="button">'
      + nodeIcon(web
        ? { name: f.name, isDir: false, kind: WEB_KIND }
        : { name: f.name, isDir: f.isDir, kind: f.kind }, 14)
      + '<span class="nm">' + esc(f.name) + '</span>'
      + '</div>';
  }

  /**
   * 最左栏下部的快速访问面板。
   * 面板常驻（没有收藏时给出加入方式），否则交换上下的按钮会无处安放。
   * 高度由 applyLeftSplit 按「上 : 下」比例分配，与哪个面板在上面无关。
   * 置顶按钮只出现在当前处于下方的那一个面板的标题栏上。
   */
  function renderFavorites() {
    const colEl = colsEl.children[0];
    if (!colEl) return;
    const panel = colEl.querySelector('.fav-panel');
    if (!panel) return;
    panel.hidden = false;
    applyLeftSplit(colEl);
    const selKey = state.sel
      ? (state.sel.node.kind === WEB_KIND ? state.sel.node.url : state.sel.node.path)
      : '';
    const rows = state.favs.length || PV.cloud.rows()
      ? state.favs.map((f) => favRowHtml(f, selKey)).join('') + PV.cloud.rows()
      : '<div class="col-note">右键或行尾闪电图标加入快速访问；点标题栏的 + 添加网页链接</div>';
    const add = (state.path[0] && !PV.paths.same(state.path[0].path, state.root)
      ? '<button class="col-toggle" data-project-root title="返回项目目录" aria-label="返回项目目录">' + icon('arrowLeft', '', 14) + '</button>' : '')
      + '<button class="col-toggle fav-add" data-cloud-add title="添加云目录" aria-label="添加云目录">' + icon('globe', '', 14) + '</button>'
      + '<button class="col-toggle fav-add" data-reference-add title="添加外部目录" aria-label="添加外部目录">' + icon('folder', '', 14) + icon('plus', '', 10) + '</button>'
      + '<button class="col-toggle fav-add" data-web-add title="添加网页链接" aria-label="添加网页链接">'
      + icon('globe', '', 12) + icon('plus', 'fav-plus', 10) + '</button>';
    const swap = state.favTop
      ? ''
      : '<button class="col-toggle" data-swap-panels title="与上方面板交换位置" aria-label="交换上下面板">'
        + icon('toTop', '', 14) + '</button>';
    panel.innerHTML = '<div class="fav-head">' + icon('zapFilled', 'fav-head-ic', 12)
      + '<span class="fav-title">快速访问</span>' + add + swap + '</div>'
      + '<div class="fav-scroll"><div class="fav-list">' + rows + '</div></div>';
  }

  /* ---- 最左栏上下两个面板的高度：按比例分，比例只跟位置有关 ---- */
  /** 两个面板可分的高度：整栏扣掉栏头（30）与分隔条（7） */
  function splitAvail(colEl) {
    return Math.max(96, colEl.clientHeight - 37 - PROJ_DOCK_H);
  }

  /** 把「上 : 下」比例落到两个面板上（上面的固定高度，下面的吃掉剩余空间） */
  function applyLeftSplit(colEl) {
    const listEl = colEl.querySelector('.col-list');
    const favEl = colEl.querySelector('.fav-panel');
    if (!listEl || !favEl) return;
    const avail = splitAvail(colEl);
    const topH = Math.round(avail * state.splitRatio);
    const topEl = state.favTop ? favEl : listEl;
    const bottomEl = state.favTop ? listEl : favEl;
    topEl.style.flex = '0 0 ' + topH + 'px';
    topEl.style.maxHeight = 'none';
    bottomEl.style.flex = '1 1 auto';
    bottomEl.style.maxHeight = 'none';
  }

  /** 拖动分隔条：改变「上 : 下」比例，两个面板各自至少留 48px */
  function setSplitByTopHeight(colEl, topH) {
    const avail = splitAvail(colEl);
    const next = Math.min(Math.max(topH, SPLIT_MIN), Math.max(SPLIT_MIN, avail - SPLIT_MIN));
    state.splitRatio = next / avail;
    applyLeftSplit(colEl);
  }

  /** 交换最左栏「项目根目录 / 快速访问」两个面板的上下位置 */
  function swapLeftPanels() {
    state.favTop = !state.favTop;
    pv.setState({ favTop: state.favTop });
    render();
    toast(state.favTop ? '快速访问已移到上方' : '项目根目录已移到上方');
  }

  /* ============================ 数据 ============================ */
  /** 应用「隐藏点文件」过滤后的原始条目（搜索前） */
  function baseItemsOf(ci) {
    const col = state.cols[ci];
    if (!col || !col.entries) return [];
    return state.hideDot
      ? col.entries.filter((e) => e.name.charAt(0) !== '.')
      : col.entries;
  }

  function itemsOf(ci) {
    const col = state.cols[ci];
    if (!col || !col.entries) return [];
    const cacheKey = (state.hideDot ? 'hide' : 'show');
    if (col._items && col._itemsKey === cacheKey) return col._items;
    const base = baseItemsOf(ci);
    const list = base.slice();
    list.sort(PV.paths.compareNodes);
    col._items = list;
    col._itemsKey = cacheKey;
    return list;
  }

  /**
   * 某个目录当前显示出来的条目（过滤与排序都算过），没开在栏里就返回 null。
   * 连续预览要「顺序跟栏内一致」，拿的就是这个。
   */
  function itemsInDir(dir) {
    for (let ci = 0; ci < state.cols.length; ci++) {
      const col = state.cols[ci];
      if (col && col.dir === dir && col.entries) return itemsOf(ci);
    }
    return null;
  }

  function isInPath(node) {
    for (let i = 1; i < state.path.length; i++) {
      if (state.path[i].path === node.path) return true;
    }
    return false;
  }

  async function loadColumn(ci) {
    const folder = state.path[ci];
    if (!folder) return;
    const current = state.cols[ci];
    if (current && current.dir === folder.path && current.entries && !current.stale) return;

    const version = (current && current.version ? current.version : 0) + 1;
    state.cols[ci] = { dir: folder.path, state: 'loading', version, entries: null, error: null };
    render();

    const res = await pv.list(folder.path);
    const slot = state.cols[ci];
    if (!slot || slot.dir !== folder.path || slot.version !== version) return; // 已被更新的请求取代

    if (res.error) {
      state.cols[ci] = { dir: folder.path, state: 'error', version, entries: null, error: res };
    } else {
      state.cols[ci] = { dir: folder.path, state: 'ready', version, entries: res.entries, error: null };
    }
    // 这一栏刚从磁盘读过，之前记下的「有变化」可以收了，并重新记基线
    noteDirLoaded(folder.path);
    render();
  }

  /** 重新扫描：清掉缓存后按当前路径重载 */
  let refreshing = false;
  async function rescan() {
    if (!state.root || refreshing) return;
    refreshing = true;
    const root = state.root;
    const btn = $('#btn-refresh');
    btn.disabled = true;
    try {
      await Promise.all([Promise.all(PV.pane.visiblePanes().map(pollPane)), pollOpenDirs(), PV.cloud.refresh()]);
      if (root !== state.root) return;
      const jobs = state.path.map((folder, i) => {
        if (!dirtyDirs.has(folder.path)) return Promise.resolve();
        if (state.cols[i]) state.cols[i].stale = true;
        return loadColumn(i);
      });
      for (const pane of PV.pane.visiblePanes()) {
        if (pane.node && pane.node.kind === WEB_KIND) {
          await pv.webReload(pane.node.url);
          continue;
        }
        if (!pane.changed) continue;
        const keep = PV.pane.captureView(pane);
        PV.pane.renderPane(pane, true);
        jobs.push(Promise.resolve(pane.ready).then(() => PV.pane.restoreView(pane, keep)));
      }
      await Promise.all(jobs);
      paintRescan();
      toast(PV.pane.visiblePanes().some((p) => p.changed) ? '部分内容未能刷新，请查看预览中的错误提示' : '已刷新变化内容');
    } catch (err) { toast('刷新失败：' + err.message); }
    finally { refreshing = false; btn.disabled = false; }
  }

  /* ============================ 选择与导航 ============================ */
  async function openRoot(dir) {
    // 先记下当前项目的浏览位置，再换工作区
    saveNavNow();
    closeWebForm();
    navRestored = false;
    state.root = dir;
    state.rootName = PV.paths.baseName(dir) || dir;
    state.path = [{ name: state.rootName, path: dir, isDir: true, kind: 'folder' }];
    state.cols = [];
    state.sel = null;
    state.mode = 'preview';
    state.referenceDirs = [];
    state.favs = [];
    // 固定列装的是上一个工作区的文件，换工作区后一律清掉
    PV.pane.clearPins();
    PV.find.close();
    PV.pane.resetTemp();
    // 换工作区后，上一个工作区的目录变更提示不再有意义
    dirtyDirs.clear();
    dirKnown.clear();
    // 切换条：当前项立刻高亮；新项目有空位就加进去
    PV.projects.noteOpened(dir);
    render();
    await PV.cloud.setProject(dir);
    const references = await pv.referenceDirs();
    if (state.root !== dir) return;
    state.referenceDirs = references;
    refreshFavorites();
    const nav = PV.projects.navOf(dir);
    setWelcome(false);
    render();
    await loadColumn(0);
    if (nav) {
      await applySavedNav(nav);
      navRestored = true;
    }
    scheduleSaveNav();
  }

  async function selectNode(node, ci, options) {
    const opts = options || {};
    state.sel = { col: ci, node };
    state.mode = 'preview';
    if (node.isDir) {
      state.path = state.path.slice(0, ci + 1).concat([node]);
      state.pendingScroll = opts.scroll !== false;
      render();
      await loadColumn(ci + 1);
    } else {
      state.path = state.path.slice(0, ci + 1);
      state.cols.length = ci + 1;
      state.pendingScroll = false;
      // 预览被收起时，重新单击文件应当把预览内容带回来
      if (!PV.pane.previewOpen() && opts.revealPreview) {
        setPreviewVisible(true);
      }
      render();
      requestAnimationFrame(() => {
        const col = colsEl.children[ci];
        if (col) col.scrollIntoView({ block: 'nearest', inline: 'end' });
      });
    }
    scheduleSaveNav();
  }

  function goToPathIndex(i) {
    if (i < 0) {
      state.path = state.path.slice(0, 1);
      state.sel = null;
      state.cols.length = 1;
    } else {
      state.path = state.path.slice(0, i + 1);
      state.sel = i === 0 ? null : { col: i - 1, node: state.path[i] };
      state.cols.length = i + 1;
    }
    render();
    scheduleSaveNav();
  }

  /* ---- 每个项目记住的浏览位置：展开到哪一级、选中谁、预览还是源码 ---- */
  let navTimer = null;
  let navRestored = false;

  function currentNav() {
    return {
      path: state.path.map((f) => f.path),
      sel: state.sel && !state.sel.node.cloudMountId ? state.sel.node.path : null,
      mode: state.mode,
      // 固定列、列宽、分屏比例都跟着项目走：切走时一起存，切回来原样恢复
      layout: PV.pane.layoutSnapshot()
    };
  }

  function saveNavNow() {
    if (!state.root) return;
    clearTimeout(navTimer);
    navTimer = null;
    PV.projects.saveNav(state.root, currentNav());
  }

  function scheduleSaveNav() {
    if (!state.root) return;
    clearTimeout(navTimer);
    navTimer = setTimeout(saveNavNow, 350);
  }

  /** 逐级恢复：从根目录开始，按保存的路径一层层进去，再选中文件与模式 */
  async function restoreNav(nav) {
    const levels = Array.isArray(nav && nav.path) ? nav.path : [];
    if (levels[0] && state.referenceDirs.some((p) => PV.paths.same(p, levels[0]))) {
      await browseRoot(levels[0]);
    }
    for (let i = 1; i < levels.length; i++) {
      const col = state.cols[i - 1];
      if (!col || col.state !== 'ready' || !col.entries) break;
      const node = col.entries.find((e) => e.isDir && PV.projects.samePath(e.path, levels[i]));
      if (!node) break;
      await selectNode(node, i - 1, { scroll: false });
    }
    if (nav && nav.sel) {
      const ci = state.path.length - 1;
      const col = state.cols[ci];
      let restored = false;
      if (col && col.state === 'ready' && col.entries) {
        const node = col.entries.find((e) => !e.isDir && PV.projects.samePath(e.path, nav.sel));
        if (node) {
          // 恢复选中不等于用户点了文件：临时预览列关着就别强行展开
          await selectNode(node, ci, { scroll: false });
          restored = true;
        }
      }
      // 上次选中的是一条网页快捷方式：它不是目录里的条目，按地址找回收藏
      if (!restored) {
        const fav = state.favs.find((f) => isWebFav(f) && f.url === nav.sel);
        if (fav) openWebFavorite(fav, false);
      }
    }
    if (nav && nav.mode === 'source' && !(state.sel && state.sel.node.kind === WEB_KIND)) {
      state.mode = 'source';
    }
    render();
  }

  /** 恢复某个项目保存的导航与固定列布局（首次启动、切换项目共用） */
  async function applySavedNav(nav) {
    await restoreNav(nav);
    PV.pane.restoreLayout(nav.layout);
  }

  /* ---- 项目切换 / 新开项目 ---- */
  async function switchProject(path) {
    if (!path) return;
    if (state.root && PV.projects.samePath(path, state.root)) return;
    const res = await pv.openRoot(path);
    if (res && res.error) {
      // 后一次切换已经开始了：这次被取消是正常现象，不用打扰用户
      if (res.error === 'SUPERSEDED') return;
      toast(res.error === 'NOT_OFFERED' ? '无法打开该项目：不在可访问范围内' : '无法打开该项目');
    }
  }

  async function pickProjectFolder() {
    // 满了就别先弹选择框：选完又加不进去，用户会更困惑
    if (PV.projects.isFull()) { PV.projects.warnFull(); return; }
    const res = await pv.pickFolder();
    if (res && res.root) toast('已打开：' + res.root);
  }

  /** 网页列的兜底出口：拉起系统浏览器（地址由主进程再校验一次） */
  async function openWebExternal(node) {
    const url = node.webCurrentUrl || node.url;
    const res = await pv.openExternalUrl(url);
    if (res && res.ok) toast('已在浏览器中打开');
    else toast('无法打开这个链接');
  }

  async function openWithSystem(node) {
    if (node.kind === WEB_KIND) { await openWebExternal(node); return; }
    if (node.isDir) {
      const res = await pv.reveal(node.path);
      if (res && res.error) toast('无法打开：' + node.name);
      return;
    }
    const res = await pv.openPath(node.path);
    if (res && res.ok) toast('已用系统默认程序打开：' + node.name);
    else toast('打开失败：' + ((res && res.message) || '系统没有关联的程序'));
  }

  /* ============================ 渲染：外壳 ============================ */
  function setWelcome(on) {
    welcomeVisible = on;
    $('#welcome').hidden = !on;
    $('#root-name').textContent = on ? 'lit explorer' : state.rootName;
    $('#root-path').textContent = on ? '' : state.root;
    $('#root-path').title = on ? '' : state.root;
  }

  function renderCrumbs() {
    if (!state.path.length) { crumbsEl.innerHTML = ''; return; }
    let html = '<button class="crumb" data-crumb="-1" title="工作区根目录">' + icon('home', '', 14) + '</button>';
    const last = state.path.length - 1;
    // 根目录已经由 home 图标代表，不再重复渲染项目名
    state.path.forEach((folder, i) => {
      if (i === 0) return;
      html += '<span class="crumb-sep">' + icon('chevron', '', 13) + '</span>';
      html += '<button class="crumb' + (i === last ? ' is-last' : '') + '" data-crumb="' + i + '" title="'
        + esc(folder.path) + '">' + esc(folder.name) + '</button>';
    });
    const sel = state.sel;
    if (sel && !sel.node.isDir && sel.node.kind !== WEB_KIND) {
      html += '<span class="crumb-sep">' + icon('chevron', '', 13) + '</span>';
      html += '<button class="crumb is-last" data-crumb="' + last + '" title="' + esc(sel.node.path) + '">'
        + esc(sel.node.name) + '</button>';
    }
    crumbsEl.innerHTML = html;
  }

  /* ============================ 渲染：栏 ============================ */
  function colKey(ci) {
    const folder = state.path[ci];
    const col = state.cols[ci];
    if (!folder) return '';
    const phase = !col ? 'init' : col.state + ':' + col.version + (col.error ? ':' + (col.error.error || '') : '');
    return folder.path + '\u0001' + phase + '\u0001' + (state.hideDot ? 'hide' : 'show')
      + '\u0001' + (ci === 0 && state.favTop ? 'favtop' : 'norm');
  }

  function applyRowClass(row, node) {
    const selected = !!(state.sel && state.sel.node.path === node.path);
    row.classList.toggle('is-sel', selected);
    row.classList.toggle('is-trail', !selected && isInPath(node));
    // blocked：链接指向工作区之外，点进去必然被拒，样子上就标成不可用
    row.classList.toggle('is-broken', !!node.broken || !!node.blocked);
    const fav = isFavorite(node.path);
    const favBtn = row.querySelector('.row-fav');
    if (favBtn) {
      favBtn.classList.toggle('is-on', fav);
      favBtn.title = fav ? '从快速访问中移除' : '添加到快速访问';
      favBtn.innerHTML = icon(fav ? 'zapFilled' : 'zap', '', 14);
    }
  }

  function rowEl(node, ci, idx) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.col = ci;
    row.dataset.idx = idx;
    row.title = node.name + '\n' + node.path
      + (node.blocked ? '\n（链接指向工作区之外，无法打开）' : '');
    row.setAttribute('role', 'button');
    row.innerHTML = nodeIcon(node)
      + '<span class="nm">' + esc(node.name) + '</span>'
      + (node.isDir ? '<span class="chev">' + icon('chevron', '', 14) + '</span>' : '')
      + '<button class="row-fav" tabindex="-1" aria-label="快速访问"></button>';
    applyRowClass(row, node);
    return row;
  }

  function renderColumnWindow(ci) {
    const colEl = colsEl.children[ci];
    if (!colEl) return;
    const listEl = colEl.querySelector('.col-list');
    if (!listEl || !listEl.classList.contains('is-virt')) return;
    const win = listEl.querySelector('.vwin');
    if (!win) return;

    const items = itemsOf(ci);
    const viewH = listEl.clientHeight || 600;
    let start = Math.floor((listEl.scrollTop - PAD_TOP) / ROW_H) - OVERSCAN;
    start = Math.max(0, start);
    const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2 + 2;
    const end = Math.min(items.length, start + count);

    win.style.transform = 'translateY(' + (PAD_TOP + start * ROW_H) + 'px)';
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(rowEl(items[i], ci, i));
    win.textContent = '';
    win.appendChild(frag);
  }

  const scrollFrame = new Map();
  function onColumnScroll(ci) {
    if (scrollFrame.has(ci)) return;
    const id = requestAnimationFrame(() => {
      scrollFrame.delete(ci);
      renderColumnWindow(ci);
    });
    scrollFrame.set(ci, id);
  }

  function buildColumn(ci, animate) {
    const folder = state.path[ci];
    const col = state.cols[ci];
    const items = itemsOf(ci);

    const el = document.createElement('div');
    el.className = 'col' + (animate ? ' is-new' : '') + (ci === 0 && state.favTop ? ' is-fav-top' : '');
    el.dataset.col = ci;

    const head = document.createElement('div');
    head.className = 'col-head';
    if (ci === 0) {
      // 根目录栏：项目名 + 点文件显隐开关，不再占用空间显示文件数
      // 快速访问被置顶时，这一栏落到下方，交换按钮就出现在这里
      const swap = state.favTop
        ? '<button class="col-toggle" data-swap-panels title="与上方面板交换位置" aria-label="交换上下面板">'
          + icon('toTop', '', 14) + '</button>'
        : '';
      head.innerHTML = '<b>' + esc(folder.name) + '</b>'
        + '<button class="col-toggle' + (state.hideDot ? ' is-on' : '') + '" data-toggle-dot title="'
        + (state.hideDot ? '显示以 . 开头的文件/文件夹' : '隐藏以 . 开头的文件/文件夹') + '" aria-label="切换点文件显示">'
        + icon(state.hideDot ? 'eyeOff' : 'eye', '', 14) + '</button>'
        + swap;
    } else {
      const total = baseItemsOf(ci).length;
      const countText = String(items.length);
      head.innerHTML = '<b>' + esc(folder.name) + '</b><span>'
        + (col && col.state === 'ready' ? countText : '') + '</span>';
    }
    el.appendChild(head);

    const list = document.createElement('div');
    list.className = 'col-list';
    el.appendChild(list);

    if (ci === 0) {
      // 快速访问面板固定在根目录栏，中间留一条可拖动的分隔条调整上下比例
      const favPanel = document.createElement('div');
      favPanel.className = 'fav-panel';
      favPanel.hidden = true;
      el.appendChild(favPanel);
      const split = document.createElement('div');
      split.className = 'panel-resize';
      split.title = '拖动调整上下面板的高度比例';
      el.appendChild(split);

      // 项目切换条是左栏的最后一条，贴在窗口底部
      const dock = document.createElement('div');
      dock.className = 'proj-dock';
      el.appendChild(dock);
      PV.projects.mount(dock);
    }

    colsEl.appendChild(el);

    if (!col || col.state === 'loading') {
      list.innerHTML = '<div class="skeleton"><i style="width:72%"></i><i style="width:56%"></i>'
        + '<i style="width:64%"></i><i style="width:44%"></i></div>';
      return;
    }

    if (col.state === 'error') {
      const denied = col.error && col.error.error === 'EACCES_ROOT';
      list.innerHTML = '<div class="col-note is-error">'
        + (denied ? '无法访问：超出已授权的工作区范围' : '无法访问该目录')
        + '<br>' + esc((col.error && col.error.message) || '') + '</div>';
      return;
    }

    if (!items.length) {
      list.innerHTML = '<div class="col-note">' + '空目录' + '</div>';
      return;
    }

    if (items.length > VIRTUAL_MIN) {
      list.classList.add('is-virt');
      list.innerHTML = '<div class="vspace"><div class="vwin"></div></div>';
      const vspace = list.firstChild;
      vspace.style.height = (PAD_TOP + items.length * ROW_H + PAD_BOTTOM) + 'px';
      list.addEventListener('scroll', () => onColumnScroll(ci), { passive: true });
      renderColumnWindow(ci);
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < items.length; i++) frag.appendChild(rowEl(items[i], ci, i));
    list.appendChild(frag);
  }

  function updateRowStates() {
    for (let ci = 0; ci < state.path.length; ci++) {
      const colEl = colsEl.children[ci];
      if (!colEl) continue;
      const items = itemsOf(ci);
      const rows = colEl.querySelectorAll('.row');
      for (let i = 0; i < rows.length; i++) {
        const node = items[+rows[i].dataset.idx];
        if (node) applyRowClass(rows[i], node);
      }
    }
  }

  function renderColumns() {
    const keys = state.path.map((_, ci) => colKey(ci));

    let firstStale = 0;
    while (firstStale < keys.length
      && firstStale < renderedColKeys.length
      && keys[firstStale] === renderedColKeys[firstStale]) {
      firstStale++;
    }

    const prevCount = colsEl.children.length;
    while (colsEl.children.length > firstStale) colsEl.lastElementChild.remove();
    for (let ci = firstStale; ci < state.path.length; ci++) {
      // 只有新出现的栏才播放入场动画：过滤、刷新、切换选中都不该让已有栏闪动
      buildColumn(ci, ci >= prevCount);
    }

    renderedColKeys = keys;
    updateRowStates();
    renderFavorites();

    if (state.pendingScroll) {
      state.pendingScroll = false;
      requestAnimationFrame(() => {
        colsEl.scrollTo({ left: colsEl.scrollWidth, behavior: 'smooth' });
      });
    }
  }

  /* ============================ 渲染：预览正文 ============================ */
  // 正文与头部怎么画在 preview-body.js（PV.body）：Markdown / 代码视图 / 图片与
  // 连续预览 / HTML 迷你浏览器 / PDF / docx / pptx 的分派都在那里，这里只把它接到
  // 窗格上（见下面 PV.pane.init）。


  /* ============================ 总渲染 ============================ */
  function render() {
    if (!state.root) {
      renderCrumbs();
      PV.pane.renderPreview();
      return;
    }
    renderCrumbs();
    renderColumns();
    PV.pane.renderPreview();
  }

  /* ============================ 交互 ============================ */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
  }

  function applyTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    $('#theme-ic').innerHTML = state.theme === 'light'
      ? PV.icons.ICONS.moon : PV.icons.ICONS.sun;
    pv.setState({ theme: state.theme });
  }

  /** 预览区的显示开关：窗格那边、按钮状态与持久化一起改 */
  function setPreviewVisible(on) {
    PV.pane.setPreviewOpen(on);
    // 预览整个收起来时，挂在上面的查找条也一起收掉
    if (!on) PV.find.close();
    pv.setState({ previewOpen: on });
  }

  function togglePreview(force) {
    setPreviewVisible(typeof force === 'boolean' ? force : !PV.pane.previewOpen());
    PV.pane.renderPreview();
  }

  /** 把焦点落到顶栏的文件名搜索框（Ctrl+F 的兜底、菜单里的「聚焦搜索框」共用） */
  function focusSearch() {
    const pane = PV.find.targetPane();
    if (pane && PV.find.canFind(pane)) PV.find.open(pane);
    else toast('请先打开可查找的文件');
  }

  function ensureVisible(ci, idx) {
    const colEl = colsEl.children[ci];
    if (!colEl) return;
    const listEl = colEl.querySelector('.col-list');
    if (!listEl) return;
    const top = PAD_TOP + idx * ROW_H;
    const viewTop = listEl.scrollTop;
    const viewBottom = viewTop + listEl.clientHeight;
    if (top < viewTop + PAD_TOP) {
      listEl.scrollTop = Math.max(0, top - PAD_TOP);
    } else if (top + ROW_H > viewBottom - 4) {
      listEl.scrollTop = top + ROW_H - listEl.clientHeight + 8;
    }
    if (listEl.classList.contains('is-virt')) renderColumnWindow(ci);
  }

  function nodeAt(ci, idx) {
    return itemsOf(ci)[idx] || null;
  }

  /* 列点击 / 双击 */
  colsEl.addEventListener('click', (e) => {
    // 最左栏两个面板上下互换
    if (e.target.closest('[data-swap-panels]')) {
      swapLeftPanels();
      return;
    }

    // 左栏头部：重新扫描
    if (e.target.closest('[data-rescan]')) {
      rescan();
      return;
    }

    // 点文件显隐开关
    if (e.target.closest('[data-toggle-dot]')) {
      state.hideDot = !state.hideDot;
      pv.setState({ hideDot: state.hideDot });
      render();
      return;
    }

    // 快速访问面板标题栏：添加网页链接
    if (e.target.closest('[data-project-root]')) { browseRoot(state.root); return; }
    if (e.target.closest('[data-reference-add]')) {
      const project = state.root;
      if (!project) { toast('请先打开项目'); return; }
      pv.addReferenceDir().then((result) => {
        if (project !== state.root || result.canceled) return;
        if (result.error) { toast('添加参考目录失败：' + (result.message || result.error)); return; }
        state.referenceDirs = result.dirs;
        refreshFavorites();
        renderFavorites();
      }).catch((err) => toast(err.message));
      return;
    }
    if (e.target.closest('[data-web-add]')) {
      openWebForm(null, e.target.closest('[data-web-add]'));
      return;
    }

    // 点击快速访问项：文件导航并选中，网页直接进预览列
    const favRow = e.target.closest('.fav-row');
    if (favRow) {
      const fav = state.favs.find((f) => favIdentity(f) === favRow.dataset.favKey);
      if (fav) openFavorite(fav);
      return;
    }

    // 行尾的快速访问按钮
    const star = e.target.closest('.row-fav');
    if (star) {
      e.stopPropagation();
      const row = star.closest('.row');
      const node = row ? nodeAt(+row.dataset.col, +row.dataset.idx) : null;
      if (node) toggleFavorite(node);
      return;
    }

    const row = e.target.closest('.row');
    if (!row) return;
    const ci = +row.dataset.col;
    if (!Number.isFinite(ci)) return;
    const node = nodeAt(ci, +row.dataset.idx);
    // 预览收起时，单击文件应当重新展开预览
    if (node) selectNode(node, ci, { revealPreview: true });
  });

  colsEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('fav-row')) return;
    const node = nodeAt(+row.dataset.col, +row.dataset.idx);
    if (node && !node.isDir) openWithSystem(node);
  });

  colsEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();

    const favRow = e.target.closest('.fav-row');
    if (favRow) {
      const fav = state.favs.find((f) => favIdentity(f) === favRow.dataset.favKey);
      if (fav) {
        if (isWebFav(fav)) {
          pv.openContextMenu({ kind: 'web', url: fav.url, name: fav.name });
        } else {
          pv.openContextMenu({
            path: fav.path,
            kind: fav.isDir ? 'folder' : 'file',
            favorited: true
          });
        }
      }
      return;
    }

    const row = e.target.closest('.row');
    if (!row) { pv.openContextMenu({ kind: 'empty' }); return; }
    const node = nodeAt(+row.dataset.col, +row.dataset.idx);
    if (!node) return;
    if (state.sel && state.sel.node.path !== node.path) {
      selectNode(node, +row.dataset.col);
    }
    pv.openContextMenu({
      path: node.path,
      kind: node.isDir ? 'folder' : 'file',
      favorited: isFavorite(node.path)
    });
  });

  /* 面包屑 */
  crumbsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-crumb]');
    if (!btn) return;
    goToPathIndex(+btn.dataset.crumb);
  });

  /* 记录最近操作的窗格：Ctrl+F 与 ↑↓ 都优先作用在它身上 */
  previewEl.addEventListener('pointerdown', (e) => {
    const pane = PV.pane.paneOf(e.target);
    if (pane) PV.pane.setActive(pane);
  });
  // 点回栏区就把「当前操作区」交还给文件列表（↑↓ 随之回到换选中项）
  colsEl.addEventListener('pointerdown', () => { PV.pane.clearActive(); });
  // 滚轮滚过哪一边，也把操作区算到哪一边
  previewEl.addEventListener('wheel', (e) => {
    const pane = PV.pane.paneOf(e.target);
    if (pane) PV.pane.setActive(pane);
  }, { passive: true });
  colsEl.addEventListener('wheel', () => { PV.pane.clearActive(); }, { passive: true });

  /* 预览区操作：所有窗格的头部按钮与卡片内按钮走同一套分派 */
  previewEl.addEventListener('click', (e) => {
    const pane = PV.pane.paneOf(e.target);
    if (!pane) return;
    const node = pane.node;

    const btn = e.target.closest('button[data-act], button[data-mode]');
    if (!btn) return;
    if (btn.dataset.mode) {
      if (!node) return;
      // 临时预览列沿用全局模式，固定住的窗格各记一份
      if (pane.pinned) pane.mode = btn.dataset.mode;
      else { state.mode = btn.dataset.mode; scheduleSaveNav(); }
      PV.pane.renderPane(pane, true);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'pin') { if (pane.pinned) PV.pane.unpinPane(pane); else PV.pane.pinCurrent(); return; }
    if (act === 'close') { if (pane.pinned) PV.pane.unpinPane(pane); else togglePreview(false); return; }
    if (act === 'zoom-in') { if (node) PV.body.stepZoom(pane, 1); return; }
    if (act === 'zoom-out') { if (node) PV.body.stepZoom(pane, -1); return; }
    if (act === 'zoom-reset') { if (node) PV.body.setZoom(pane, 0); return; }
    if (act === 'seq') { if (node) PV.body.toggleSeq(pane); return; }
    if (act === 'svg-edit') {
      // 能不能编辑问正文模块：类型知识只在 preview-body.js 里维护
      if (!node || !PV.body.capabilities(node, PV.pane.modeOf(pane)).svgEdit) return;
      pane.svgEdit = !pane.svgEdit;
      pane.svgEditPath = pane.svgEdit ? node.path : '';
      // 编辑模式接管正文，连续预览让位
      if (pane.svgEdit) pane.continuous = false;
      PV.pane.renderPane(pane, true);
      return;
    }
    if (!node) return;
    if (act === 'reload' || act === 'web-reload') {
      // 重新读取后基线由正文落地时上报；先清掉高亮，避免读失败时一直亮着
      pane.changed = false;
      btn.classList.add('spin');
      setTimeout(() => btn.classList.remove('spin'), 520);
      if (node.kind === WEB_KIND) {
        node.webError = null;
        PV.pane.renderPane(pane, true);
        // 视图可能还没建（刚切过来）或已被销毁：sync 会补建，reload 只负责已有的
        const job = pv.webReload(node.url);
        if (job && typeof job.catch === 'function') job.catch(() => {});
        PV.web.schedule();
      } else {
        PV.pane.renderPane(pane, true);
      }
    } else if (act === 'copy-path') {
      const text = node.kind === WEB_KIND ? (node.webCurrentUrl || node.url) : node.path;
      pv.copyText(text).then(() => toast((node.kind === WEB_KIND ? '已复制链接：' : '已复制路径：') + text));
    } else if (act === 'reveal') {
      if (node.kind !== WEB_KIND) pv.reveal(node.path);
    } else if (act === 'external') {
      openWithSystem(node);
    }
  });

  /* 拖动最左栏的分隔条：改变「上 : 下」的高度比例，与哪个面板在上面无关 */
  let panelDrag = null;
  colsEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest ? e.target.closest('.panel-resize') : null;
    if (!grip) return;
    const colEl = grip.closest('.col');
    if (!colEl || !colEl.querySelector('.fav-panel')) return;
    e.preventDefault();
    panelDrag = {
      colEl: colEl,
      y: e.clientY,
      topH: Math.round(splitAvail(colEl) * state.splitRatio)
    };
    grip.classList.add('is-drag');
    try { grip.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    document.body.classList.add('resizing-v');
  });
  colsEl.addEventListener('pointermove', (e) => {
    if (!panelDrag) return;
    // 分隔条跟着指针走：往下拖上面的面板变高，往上拖变矮
    setSplitByTopHeight(panelDrag.colEl, panelDrag.topH + (e.clientY - panelDrag.y));
  });
  colsEl.addEventListener('pointerup', () => {
    if (!panelDrag) return;
    const grip = panelDrag.colEl.querySelector('.panel-resize');
    if (grip) grip.classList.remove('is-drag');
    panelDrag = null;
    document.body.classList.remove('resizing-v');
    pv.setState({ leftSplitRatio: state.splitRatio });
  });

  /* 顶部按钮 */
  $('#btn-refresh').addEventListener('click', () => rescan());

  $('#btn-theme').addEventListener('click', () => {
    applyTheme(state.theme === 'light' ? 'dark' : 'light');
  });
  $('#btn-open').addEventListener('click', () => { pickProjectFolder(); });
  $('#btn-menu').addEventListener('click', () => pv.openAppMenu());

  /* 自绘标题栏的窗口控制 */
  const MAX_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">'
    + '<rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1"/></svg>';
  const RESTORE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">'
    + '<rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1"/>'
    + '<path d="M2.5 2.5v-2h7v7h-2" stroke="currentColor" stroke-width="1"/></svg>';

  function applyMaximized(value) {
    document.body.classList.toggle('is-maximized', !!value);
    const btn = $('#wc-max');
    btn.innerHTML = value ? RESTORE_ICON : MAX_ICON;
    btn.title = value ? '向下还原' : '最大化';
  }

  $('#wc-min').addEventListener('click', () => pv.minimize());
  $('#wc-max').addEventListener('click', async () => {
    applyMaximized(await pv.toggleMaximize());
  });
  $('#wc-close').addEventListener('click', () => pv.closeWindow());
  pv.onMaximized(applyMaximized);
  $('#w-open').addEventListener('click', () => { pickProjectFolder(); });
  $('#w-sample').addEventListener('click', async () => {
    const dir = await pv.getSampleRoot();
    if (!dir) return;
    // 示例项目已经在列表里时，满了也允许切过去
    const known = PV.projects.list().some((p) => PV.projects.samePath(p.path, dir));
    if (!known && PV.projects.isFull()) { PV.projects.warnFull(); return; }
    const res = await pv.openRoot(dir);
    // 主进程只接受它自己给过的目录；真被拒了要说一声，别让按钮看起来没反应
    if (res && res.error && res.error !== 'SUPERSEDED') toast('打不开示例项目：' + res.error);
  });

  /* 键盘 */
  document.addEventListener('keydown', (e) => {
    // 原生菜单栏已移除，应用级快捷键在这里接管
    if (e.ctrlKey || e.metaKey) {
      const k = String(e.key || '').toLowerCase();
      if (k === 'o') { e.preventDefault(); $('#btn-open').click(); return; }
      if (k === 'b') { e.preventDefault(); togglePreview(); return; }
      if (k === 'f') {
        e.preventDefault();
        const pane = PV.find.targetPane();
        if (pane && PV.find.canFind(pane)) { PV.find.open(pane); return; }
        // 有预览但类型不支持查找（源码视图 / 图片 / PDF / HTML / 网页）时给一句提示，
        // 别默默跳到文件名搜索框上去
        if (pane) {
          toast(pane.node && pane.node.kind === WEB_KIND
            ? '网页列暂不支持预览内查找'
            : '这一列不支持查找；文档预览与源码视图可以用 Ctrl+F');
          return;
        }
        focusSearch();
        return;
      }
      if (k === 'l' && e.shiftKey) {
        e.preventDefault();
        applyTheme(state.theme === 'light' ? 'dark' : 'light');
        return;
      }
      return;
    }
    if (e.key === 'F5') { e.preventDefault(); rescan(); return; }

    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Escape') {
        e.target.value = '';
        e.target.blur();
        render();
      }
      return;
    }

    // 焦点不在查找框里时，Esc 先关掉查找条
    if (e.key === 'Escape' && PV.find.isOpen()) { PV.find.close(); return; }
    if (!state.root) return;

    const sel = state.sel;
    const ci = sel ? sel.col : 0;
    const items = itemsOf(ci);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 最近一次点在预览里：↑↓ 归预览内容（读长文档、翻连续预览都用它），不动文件选中项
      const focused = PV.pane.active();
      if (focused && !focused.el.hidden) {
        e.preventDefault();
        PV.pane.scrollPaneBy(focused, e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (!items.length) return;
      e.preventDefault();
      let idx = sel ? items.findIndex((n) => n.path === sel.node.path) : -1;
      idx = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (idx < 0) idx = 0;
      selectNode(items[idx], ci, { scroll: false });
      ensureVisible(ci, idx);
      return;
    }

    if (e.key === 'ArrowRight') {
      if (sel && sel.node.isDir && itemsOf(ci + 1).length) {
        e.preventDefault();
        selectNode(itemsOf(ci + 1)[0], ci + 1);
      }
      return;
    }

    if (e.key === 'ArrowLeft') {
      if (sel && ci > 0) {
        e.preventDefault();
        const parent = state.path[ci];
        state.sel = { col: ci - 1, node: parent };
        state.path = state.path.slice(0, ci + 1);
        state.cols.length = ci + 1;
        render();
        const idx = itemsOf(ci - 1).findIndex((n) => n.path === parent.path);
        if (idx >= 0) ensureVisible(ci - 1, idx);
      }
      return;
    }

    if (e.key === 'Enter') {
      if (sel && !sel.node.isDir) openWithSystem(sel.node);
      return;
    }

    if (e.key === 'Escape') {
      if (sel) {
        state.sel = null;
        state.path = state.path.slice(0, 1);
        state.cols.length = 1;
        render();
        scheduleSaveNav();
      }
    }
  });

  /* 窗口尺寸变化：重排虚拟列表窗口，必要时压缩预览列宽度、重算左栏上下比例 */
  window.addEventListener('resize', () => {
    for (let ci = 0; ci < state.path.length; ci++) renderColumnWindow(ci);
    PV.pane.relayout();
    const colEl = colsEl.children[0];
    if (colEl && colEl.querySelector('.fav-panel')) applyLeftSplit(colEl);
  });

  /* 根目录栏是 sticky 的：横向滚动后加一层投影，和后面的栏区分开 */
  colsEl.addEventListener('scroll', () => {
    colsEl.classList.toggle('is-scrolled', colsEl.scrollLeft > 0);
  }, { passive: true });

  /* ============================ 磁盘变更提示 ============================ *
   * 每 5 s 做两类 stat，都只「提示」不自动重载：
   *   1. 可见预览：比 size / mtime，变了就点亮预览头的刷新按钮；
   *   2. 已展开的目录：比目录 mtime，变了就点亮左栏的重新扫描按钮。
   * 目录 mtime 只在直接子项增删/改名时变化，正好对应「列表可能过期」。
   * 不走 fs.watch：agent 频繁写文件时事件会成串，而且 \\wsl$ / 网络盘收不到通知。
   * ------------------------------------------------------------------------- */
  /** 重新扫描按钮的提示语：有外部变更时说明该点它了 */
  function rescanTitle() {
    return '刷新已变化内容 (F5)';
  }

  /** 只改按钮本身，不整块重绘（重绘会把栏内滚动位置清掉） */
  function paintRescan() {
    const btn = $('#btn-refresh');
    if (!btn) return;
    btn.classList.toggle('is-changed', dirtyDirs.size > 0 || PV.pane.visiblePanes().some((p) => p.changed));
    btn.title = rescanTitle();
  }

  const { noteLoaded, noteDirLoaded, pollPane, pollOpenDirs, startChangeWatch } = PV.changes.create({
    pv, state, dirKnown, dirtyDirs, WEB_KIND, paintRescan
  });

  /* ============================ 把模块接起来 ============================ */
  // pane.js 管窗格的生命周期与布局，preview-body.js 管正文与头部画成什么样；
  // 它们需要的应用状态都由这里提供。
  PV.cloud.init({
    changed: renderFavorites,
    toast,
    openWeb: openWebFavorite,
    clearPreviews: function (mountId) {
      if (state.sel && state.sel.node.cloudMountId === mountId) state.sel = null;
      for (const pane of PV.pane.allPanes().slice()) {
        if (!pane.node || pane.node.cloudMountId !== mountId) continue;
        if (pane.pinned) PV.pane.unpinPane(pane);
        else PV.pane.resetTemp();
      }
      render();
    }
  });
  PV.body.init({
    toast: toast,
    root: function () { return state.root; },
    previewPrefs: function () { return { docx: state.previewDocx, pptx: state.previewPptx }; },
    itemsInDir: itemsInDir,
    openLocal: async function (mdPath, href) {
      const root = state.root;
      const target = PV.paths.resolveLink(mdPath, href);
      const base = target && rootForPath(target);
      if (!base) throw new Error('链接不在项目或参考目录内');
      const slash = target.lastIndexOf('/');
      const result = await pv.list(target.slice(0, slash));
      if (root !== state.root) return;
      const node = result && result.entries && result.entries.find((n) => PV.paths.same(n.path, target));
      if (!node || node.isDir) throw new Error('目标不是可预览的文件或已不存在');
      // 按目录链导航，保持目标文件与列表同时可见。
      const parts = PV.paths.partsUnder(base, node.path);
      if (!parts) throw new Error('链接不在项目或参考目录内');
      state.path = [{ path: base, name: PV.paths.baseName(base), isDir: true, kind: 'folder' }];
      state.cols = [];
      for (let i = 0; i < parts.length - 1; i++) {
        await loadColumn(i);
        const dir = state.cols[i].entries.find((n) => n.isDir && n.name === parts[i]);
        if (!dir) throw new Error('目录不存在');
        await selectNode(dir, i, { scroll: false });
      }
      await selectNode(node, parts.length - 1, { revealPreview: true });
    },
    canWrite: function (node) { return !!node && PV.paths.within(state.root, node.path); },
    loaded: noteLoaded
  });
  PV.pane.init({
    toast: toast,
    mode: function () { return state.mode; },
    selection: function () { return state.sel; },
    renderHead: PV.body.head,
    renderBody: PV.body.render,
    bodyKey: PV.body.key,
    capabilities: PV.body.capabilities,
    afterLayout: function () { if (PV.web) PV.web.schedule(); },
    layoutChanged: function () { scheduleSaveNav(); },
    allowPinnedPath: function (path) { return !!rootForPath(path); }
  });
  PV.projects.init({
    toast: toast,
    switchTo: switchProject,
    openNew: pickProjectFolder
  });

  /* ============================ 主进程事件 ============================ */
  // 异步链路上的异常必须显式暴露，否则预览会静默停在旧内容上
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    console.error('[unhandledrejection]', reason);
    toast('内部错误：' + ((reason && reason.message) || String(reason)));
  });
  window.addEventListener('error', (e) => {
    console.error('[error]', e.message);
  });

  pv.onOpenRoot((dir) => { openRoot(dir); });
  pv.onNoWorkspace(() => {
    setWelcome(true);
    render();
  });

  pv.onMeta((payload) => {
    const { dir, metas } = payload || {};
    if (!dir || !metas) return;
    PV.body.setMeta(metas);
    // 元信息到齐后刷新预览头（大小 / 修改时间）
    PV.pane.renderPreview();
  });

  pv.onTheme((theme) => applyTheme(theme));
  pv.onTogglePreview(() => togglePreview());
  pv.onRescan(() => rescan());
  pv.onFocusSearch(focusSearch);
  pv.onToggleFavorite((node) => {
    if (!node) return;
    if (node.kind === WEB_KIND && node.url) removeWebFavorite(node.url);
    else if (node.path) toggleFavorite(node);
  });
  pv.onEditWeb((payload) => {
    if (!payload || !payload.url) return;
    const fav = state.favs.find((f) => isWebFav(f) && f.url === payload.url);
    if (fav) openWebForm(fav, colsEl.querySelector('[data-web-add]'));
  });
  pv.onWebState(handleWebState);
  pv.onPreviewPrefs((prefs) => {
    if (!prefs) return;
    state.previewDocx = prefs.previewDocx !== false;
    state.previewPptx = prefs.previewPptx !== false;
    PV.pane.renderPreview(true);
    toast('Word 内嵌预览：' + (state.previewDocx ? '开' : '关')
      + ' · PPT 内嵌预览：' + (state.previewPptx ? '开' : '关'));
  });

  /* ============================ 启动 ============================ */
  (async function init() {
    const st = await pv.getState();
    document.documentElement.dataset.theme = st.theme === 'dark' ? 'dark' : 'light';
    state.theme = st.theme === 'dark' ? 'dark' : 'light';
    $('#theme-ic').innerHTML = state.theme === 'light' ? PV.icons.ICONS.moon : PV.icons.ICONS.sun;
    PV.pane.setPreviewOpen(st.previewOpen !== false);
    state.hideDot = !!st.hideDot;
    state.favTop = !!st.favTop;
    // 上下比例跟着位置走：默认上 2/3、下 1/3，拖动过之后一直用拖动结果
    if (typeof st.leftSplitRatio === 'number' && st.leftSplitRatio > 0) {
      state.splitRatio = Math.min(0.92, Math.max(0.08, st.leftSplitRatio));
    }
    state.previewDocx = st.previewDocx !== false;
    state.previewPptx = st.previewPptx !== false;
    state.favoritesByRoot = st.favorites && typeof st.favorites === 'object' ? st.favorites : {};
    PV.projects.load(st.projects || []);
    PV.projects.setActive(state.root || '');
    // 主进程有可能在读取设置期间就已经把工作区打开了，这时补上该工作区的快速访问项
    if (state.root) {
      refreshFavorites();
      PV.projects.noteOpened(state.root);
      const nav = navRestored ? null : PV.projects.navOf(state.root);
      render();
      if (nav) await applySavedNav(nav);
    }
    if (st.previewWidth > 0) PV.pane.setTempWidth(st.previewWidth);
    applyMaximized(await pv.isMaximized());
    // 主进程可能在读设置的同时已经把工作区打开了，这里不能反过来盖住它
    if (!st.lastRoot && !state.root) {
      setWelcome(true);
      render();
    }
    startChangeWatch();
  })();
})();
