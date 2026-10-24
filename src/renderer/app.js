/* 渲染进程主逻辑：目录导航 + 交互接线
 *
 * 预览窗格的生命周期与布局在 pane.js（PV.pane），正文与头部怎么画在
 * preview-body.js（PV.body），预览内查找在 find.js（PV.find），
 * 项目切换条与图标选择在 projects.js（PV.projects）。
 * 这个文件负责：
 *   - 多栏目录导航：加载、选中、面包屑、虚拟滚动、快速访问
 *   - 键盘、指针、顶部按钮、主进程事件，以及把上面几个模块接起来
 *
 * 加载顺序：icons.js → highlight.js → markdown.js → vendor/docpreview.js →
 *           pane.js → preview-body.js → find.js → projects.js → app.js。
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
    rootName: '',
    path: [],        // 每级目录节点，path[0] 是工作区根
    cols: [],        // 每栏的加载状态与原始条目
    sel: null,       // { col, node }
    mode: 'preview', // 临时预览列的「预览 / 源码」模式
    query: '',
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

  function normalizeFavorites(list) {
    if (!Array.isArray(list)) return [];
    const root = (state.root || '').replace(/[\\/]+$/, '').toLowerCase();
    return list.map((item) => {
      if (typeof item === 'string') {
        return {
          path: item,
          name: item.split(/[\\/]/).filter(Boolean).pop() || item,
          isDir: false,
          kind: 'txt'
        };
      }
      if (!item || !item.path) return null;
      return {
        path: item.path,
        name: item.name || item.path.split(/[\\/]/).filter(Boolean).pop() || item.path,
        isDir: !!item.isDir,
        kind: item.kind || (item.isDir ? 'folder' : 'txt')
      };
    }).filter((f) => {
      if (!f) return false;
      const p = f.path.replace(/[\\/]+$/, '').toLowerCase();
      return !root || p === root || p.startsWith(root + '\\') || p.startsWith(root + '/');
    });
  }

  function findLoadedNode(target) {
    for (let ci = 0; ci < state.cols.length; ci++) {
      const col = state.cols[ci];
      if (!col || !col.entries) continue;
      const hit = col.entries.find((e) => e.path === target);
      if (hit) return hit;
    }
    return null;
  }

  function isFavorite(path) {
    return state.favs.some((f) => f.path === path);
  }

  function saveFavorites() {
    if (!state.root) return;
    state.favoritesByRoot[favKey(state.root)] = state.favs.slice();
    pv.setState({ favorites: state.favoritesByRoot });
  }

  function toggleFavorite(target) {
    if (!target || !target.path) return;
    const node = findLoadedNode(target.path) || target;
    const at = state.favs.findIndex((f) => f.path === node.path);
    if (at >= 0) {
      state.favs.splice(at, 1);
    } else {
      state.favs.push({
        path: node.path,
        name: node.name || node.path.split(/[\\/]/).filter(Boolean).pop() || node.path,
        isDir: !!node.isDir,
        kind: node.isDir ? 'folder' : (node.kind || 'txt')
      });
    }
    saveFavorites();
    updateRowStates();
    renderFavorites();
    toast(at >= 0 ? '已从快速访问移除：' + (node.name || '') : '已加入快速访问：' + (node.name || ''));
  }

  /** 快速访问项相对当前工作区根目录的各段名字 */
  function partsUnderRoot(absPath) {
    if (!state.root) return null;
    const root = state.root.replace(/[\\/]+$/, '');
    const p = String(absPath || '').replace(/[\\/]+$/, '');
    if (p.toLowerCase() === root.toLowerCase()) return [];
    const base = root.toLowerCase();
    const low = p.toLowerCase();
    if (!low.startsWith(base + '\\') && !low.startsWith(base + '/')) return null;
    return p.slice(root.length).split(/[\\/]+/).filter(Boolean);
  }

  async function openFavorite(fav) {
    if (!state.root || !fav) return;
    const parts = partsUnderRoot(fav.path);
    if (!parts) { toast('快速访问项不在当前工作区内'); return; }
    if (!parts.length) { goToPathIndex(-1); return; }

    // 目标位于隐藏目录里时先恢复显示，否则导航后列中不会出现对应行
    if (state.hideDot && parts.some((p) => p.charAt(0) === '.')) {
      state.hideDot = false;
      pv.setState({ hideDot: false });
    }
    if (state.query) {
      state.query = '';
      $('#search').value = '';
    }

    const rootNode = state.path[0]
      || { name: state.rootName, path: state.root, isDir: true, kind: 'folder' };
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

  /** 快速访问的一行：栏内启动列表与最左栏面板共用同一套标记 */
  function favRowHtml(f, selPath) {
    return '<div class="row fav-row' + (f.path === selPath ? ' is-sel' : '')
      + '" data-fav-path="' + esc(f.path) + '" title="' + esc(f.path) + '" role="button">'
      + nodeIcon({ name: f.name, isDir: f.isDir, kind: f.kind }, 14)
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
    const selPath = state.sel ? state.sel.node.path : '';
    const rows = state.favs.length
      ? state.favs.map((f) => favRowHtml(f, selPath)).join('')
      : '<div class="col-note">右键或行尾闪电图标加入快速访问</div>';
    const swap = state.favTop
      ? ''
      : '<button class="col-toggle" data-swap-panels title="与上方面板交换位置" aria-label="交换上下面板">'
        + icon('toTop', '', 14) + '</button>';
    panel.innerHTML = '<div class="fav-head">' + icon('zapFilled', 'fav-head-ic', 12)
      + '<span class="fav-title">快速访问</span>' + swap + '</div>'
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
    const cacheKey = state.query + '\u0001' + (state.hideDot ? 'hide' : 'show');
    if (col._items && col._itemsKey === cacheKey) return col._items;
    const q = state.query.toLowerCase();
    const base = baseItemsOf(ci);
    const list = q ? base.filter((e) => e.name.toLowerCase().indexOf(q) >= 0) : base.slice();
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
    });
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
  async function rescan() {
    if (!state.root) return;
    const keep = state.sel ? state.sel.node.path : null;
    state.cols = [];
    const jobs = [];
    for (let i = 0; i < state.path.length; i++) jobs.push(loadColumn(i));
    await Promise.all(jobs);
    if (keep) toast('已重新扫描');
  }

  /* ============================ 选择与导航 ============================ */
  async function openRoot(dir) {
    // 先记下当前项目的浏览位置，再换工作区
    saveNavNow();
    navRestored = false;
    state.root = dir;
    state.rootName = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    state.path = [{ name: state.rootName, path: dir, isDir: true, kind: 'folder' }];
    state.cols = [];
    state.sel = null;
    state.mode = 'preview';
    state.favs = normalizeFavorites(state.favoritesByRoot[favKey(dir)]);
    // 固定列装的是上一个工作区的文件，换工作区后一律清掉
    PV.pane.clearPins();
    PV.find.close();
    PV.pane.resetTemp();
    // 换工作区后，上一个工作区的目录变更提示不再有意义
    dirtyDirs.clear();
    dirKnown.clear();
    // 切换条：当前项立刻高亮；新项目有空位就加进去
    PV.projects.setActive(dir);
    PV.projects.noteOpened(dir);
    const nav = PV.projects.navOf(dir);
    setWelcome(false);
    render();
    await loadColumn(0);
    if (nav) {
      await restoreNav(nav);
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
      sel: state.sel ? state.sel.node.path : null,
      mode: state.mode
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
      if (col && col.state === 'ready' && col.entries) {
        const node = col.entries.find((e) => !e.isDir && PV.projects.samePath(e.path, nav.sel));
        if (node) await selectNode(node, ci, { scroll: false, revealPreview: true });
      }
    }
    if (nav && nav.mode === 'source') state.mode = 'source';
    render();
  }

  /* ---- 项目切换 / 新开项目 ---- */
  async function switchProject(path) {
    if (!path) return;
    if (state.root && PV.projects.samePath(path, state.root)) return;
    const res = await pv.openRoot(path);
    if (res && res.error) {
      toast(res.error === 'NOT_OFFERED' ? '无法打开该项目：不在可访问范围内' : '无法打开该项目');
    }
  }

  async function pickProjectFolder() {
    // 满了就别先弹选择框：选完又加不进去，用户会更困惑
    if (PV.projects.isFull()) { PV.projects.warnFull(); return; }
    const res = await pv.pickFolder();
    if (res && res.root) toast('已打开：' + res.root);
  }

  async function openWithSystem(node) {
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
    if (sel && !sel.node.isDir) {
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
    return folder.path + '\u0001' + phase + '\u0001' + state.query + '\u0001' + (state.hideDot ? 'hide' : 'show')
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
        + '<button class="col-toggle rescanbtn' + (dirtyDirs.size ? ' is-changed' : '') + '"'
        + ' data-rescan title="' + (dirtyDirs.size ? '工作区有变化，点击重新扫描' : '重新扫描 (F5)')
        + '" aria-label="重新扫描">' + icon('refresh', '', 14) + '</button>'
        + '<button class="col-toggle' + (state.hideDot ? ' is-on' : '') + '" data-toggle-dot title="'
        + (state.hideDot ? '显示以 . 开头的文件/文件夹' : '隐藏以 . 开头的文件/文件夹') + '" aria-label="切换点文件显示">'
        + icon(state.hideDot ? 'eyeOff' : 'eye', '', 14) + '</button>'
        + swap;
    } else {
      const total = baseItemsOf(ci).length;
      const countText = state.query && total !== items.length ? items.length + ' / ' + total : String(items.length);
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
      list.innerHTML = '<div class="col-note">' + (state.query ? '无匹配项' : '空目录') + '</div>';
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

    // 点击快速访问项：导航到它并选中
    const favRow = e.target.closest('.fav-row');
    if (favRow) {
      const fav = state.favs.find((f) => f.path === favRow.dataset.favPath);
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
      const fav = state.favs.find((f) => f.path === favRow.dataset.favPath);
      if (fav) {
        pv.openContextMenu({
          path: fav.path,
          kind: fav.isDir ? 'folder' : 'file',
          favorited: true
        });
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
    if (!node) return;
    if (act === 'reload') {
      // 重新读取后基线由正文落地时上报；先清掉高亮，避免读失败时一直亮着
      pane.changed = false;
      btn.classList.add('spin');
      setTimeout(() => btn.classList.remove('spin'), 520);
      PV.pane.renderPane(pane, true);
    } else if (act === 'copy-path') {
      pv.copyText(node.path).then(() => toast('已复制路径：' + node.path));
    } else if (act === 'reveal') {
      pv.reveal(node.path);
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
    if (res && res.error) toast('打不开示例项目：' + res.error);
  });

  /* 搜索 */
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    render();
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
        // 有预览但类型不支持查找（源码视图 / 图片 / PDF / HTML）时给一句提示，
        // 别默默跳到文件名搜索框上去
        if (pane) { toast('这一列不支持查找：Markdown 与 Word / PPT 预览里可以用 Ctrl+F'); return; }
        $('#search').focus();
        $('#search').select();
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
        state.query = '';
        e.target.blur();
        render();
      }
      return;
    }
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
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
  const CHANGE_POLL_MS = 5000;
  /** 连续这么久没回到前台就暂停扫描：窗口在后台放着时没必要每 5 秒唤醒磁盘 */
  const FOREGROUND_IDLE_MS = 10 * 60 * 1000;
  let changeTimer = 0;
  let changePolling = false;
  let lastForegroundAt = Date.now();

  /** 记下某个窗格「现在显示的是哪个版本」 */
  function noteLoaded(pane, node, info) {
    if (!pane || !pane.node || !node || pane.node.path !== node.path) return;
    if (info && typeof info.size === 'number' && typeof info.mtime === 'number') {
      pane.known = { path: node.path, size: info.size, mtime: info.mtime };
      pane.changed = false;
      return;
    }
    // 图片 / HTML / PDF / 文档的读取接口不给 mtime，单独问一次
    const path = node.path;
    pv.stat(path).then((st) => {
      if (!st || st.error || !pane.node || pane.node.path !== path) return;
      pane.known = { path: path, size: st.size, mtime: st.mtime };
      pane.changed = false;
    }).catch(() => {});
  }

  function markChanged(pane) {
    if (pane.changed) return;
    pane.changed = true;
    // 只重建头部，正文不动（内容身份没变，renderPane 会跳过正文）
    PV.pane.renderPane(pane, false);
  }

  async function pollPane(pane) {
    const node = pane.node;
    if (!node || node.isDir) return;
    let st;
    try {
      st = await pv.stat(node.path);
    } catch {
      return;   // 读不到就下一轮再试，变更监测不打扰用户
    }
    // 等待期间窗格可能已经换了文件或被关掉
    if (!pane.node || pane.node.path !== node.path) return;
    if (!st || st.error) { markChanged(pane); return; }
    if (!pane.known || pane.known.path !== node.path) {
      // 正文还没落地（或刚换文件），这一轮先建立基线
      pane.known = { path: node.path, size: st.size, mtime: st.mtime };
      return;
    }
    if (st.size !== pane.known.size || Math.abs(st.mtime - pane.known.mtime) > 0.5) {
      markChanged(pane);
    }
  }

  /** 只改按钮本身，不整块重绘（重绘会把栏内滚动位置清掉） */
  function paintRescan() {
    const btn = colsEl.querySelector('[data-rescan]');
    if (!btn) return;
    const dirty = dirtyDirs.size > 0;
    btn.classList.toggle('is-changed', dirty);
    btn.title = dirty ? '工作区有变化，点击重新扫描' : '重新扫描 (F5)';
  }

  /** 某个目录刚重新读过：收掉它的变更标记，并重新记 mtime 基线 */
  function noteDirLoaded(dir) {
    dirtyDirs.delete(dir);
    dirKnown.delete(dir);
    if (!dir) return;
    pv.stat(dir).then((st) => {
      if (!st || st.error) return;
      if (state.path.some((f) => f.path === dir)) dirKnown.set(dir, st.mtime);
    }).catch(() => {});
  }

  async function pollOpenDirs() {
    if (!state.path.length) return;
    const open = new Set(state.path.map((f) => f.path));
    // 已经不在栏里的目录不再占着基线
    for (const key of Array.from(dirKnown.keys())) {
      if (!open.has(key)) dirKnown.delete(key);
    }
    for (const key of Array.from(dirtyDirs)) {
      if (!open.has(key)) dirtyDirs.delete(key);
    }

    for (const dir of open) {
      if (dirtyDirs.has(dir)) continue;
      let st;
      try {
        st = await pv.stat(dir);
      } catch {
        continue;
      }
      // 目录被删掉或暂时读不到：列表肯定已经不对了
      if (!st || st.error) { dirtyDirs.add(dir); continue; }
      if (!dirKnown.has(dir)) { dirKnown.set(dir, st.mtime); continue; }
      if (Math.abs(st.mtime - dirKnown.get(dir)) > 0.5) dirtyDirs.add(dir);
    }
    paintRescan();
  }

  async function checkForChanges() {
    if (changePolling || document.hidden) return;
    // 有焦点时一直算在前台；失焦后再给 10 分钟宽限，然后停到重新聚焦为止
    if (document.hasFocus()) lastForegroundAt = Date.now();
    else if (Date.now() - lastForegroundAt >= FOREGROUND_IDLE_MS) return;
    changePolling = true;
    try {
      await Promise.all([Promise.all(PV.pane.visiblePanes().map(pollPane)), pollOpenDirs()]);
    } finally {
      changePolling = false;
    }
  }

  function startChangeWatch() {
    if (changeTimer) return;
    changeTimer = setInterval(checkForChanges, CHANGE_POLL_MS);
    // 窗口重新可见 / 重新获得焦点时立刻补查一次，不用等下一个 5 s
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkForChanges();
    });
    window.addEventListener('focus', () => {
      lastForegroundAt = Date.now();
      checkForChanges();
    });
    checkForChanges();
  }

  /* ============================ 把模块接起来 ============================ */
  // pane.js 管窗格的生命周期与布局，preview-body.js 管正文与头部画成什么样；
  // 它们需要的应用状态都由这里提供。
  PV.body.init({
    toast: toast,
    root: function () { return state.root; },
    previewPrefs: function () { return { docx: state.previewDocx, pptx: state.previewPptx }; },
    itemsInDir: itemsInDir,
    loaded: noteLoaded
  });
  PV.pane.init({
    toast: toast,
    mode: function () { return state.mode; },
    selection: function () { return state.sel; },
    renderHead: PV.body.head,
    renderBody: PV.body.render,
    bodyKey: PV.body.key
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
  pv.onFocusSearch(() => {
    $('#search').focus();
    $('#search').select();
  });
  pv.onToggleFavorite((node) => {
    if (node && node.path) toggleFavorite(node);
  });
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
      state.favs = normalizeFavorites(state.favoritesByRoot[favKey(state.root)]);
      PV.projects.noteOpened(state.root);
      const nav = navRestored ? null : PV.projects.navOf(state.root);
      render();
      if (nav) await restoreNav(nav);
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
