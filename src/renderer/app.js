/* 渲染进程主逻辑 */
(function () {
  'use strict';

  const { icon, nodeIcon } = PV.icons;
  const { escapeHtml: esc } = PV.highlight;
  const mdToHtml = PV.markdown.toHtml;

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
  const panesEl = $('#panes');

  /** 最多固定几个预览窗格（加上临时预览列，最多四列并行） */
  const MAX_PINS = 3;
  /** 最左栏上下两个面板各自的最小高度 */
  const SPLIT_MIN = 48;

  const state = {
    root: null,
    rootName: '',
    path: [],        // 每级目录节点，path[0] 是工作区根
    cols: [],        // 每栏的加载状态与原始条目
    sel: null,       // { col, node }
    mode: 'preview', // 临时预览列的「预览 / 源码」模式
    query: '',
    theme: 'light',
    previewOpen: true,       // 临时预览列是否显示（固定列不受它影响）
    pendingScroll: false,
    hideDot: false,          // 是否隐藏以 . 开头的条目
    previewDocx: true,       // 是否内嵌预览 .docx（设置里可关）
    previewPptx: true,       // 是否内嵌预览 .pptx（设置里可关）
    favs: [],                // 当前工作区的快速访问项 [{ path, name, isDir, kind }]
    favoritesByRoot: {},     // 持久化的快速访问项（按工作区根目录分组）
    pins: [],                // 固定住的预览列（最多 MAX_PINS 个），[0] 是最新固定的，排在最左
    favTop: false,           // 最左栏：快速访问面板是否在上（false = 项目根目录在上）
    splitRatio: 2 / 3        // 最左栏「上 : 下」的高度比例，跟着位置走，与哪个面板在上面无关
  };

  /** 路径 -> { size, mtime }，由主进程异步补发 */
  const meta = new Map();
  let renderedColKeys = [];
  let welcomeVisible = false;

  /* ============================ 格式化 ============================ */
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

  function fmtSize(bytes) {
    let n = Number(bytes) || 0;
    let i = 0;
    while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + UNITS[i];
  }

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (v) => String(v).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function subPath(node) {
    if (!state.root || !node) return '';
    const root = state.root.replace(/[\\/]+$/, '');
    const abs = node.path;
    const rel = abs.toLowerCase().startsWith(root.toLowerCase()) ? abs.slice(root.length) : abs;
    return rel.replace(/^[\\/]+/, '');
  }

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
    } else if (!state.previewOpen) {
      state.previewOpen = true;
      $('#btn-preview').classList.remove('is-on');
      pv.setState({ previewOpen: true });
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
    return Math.max(96, colEl.clientHeight - 37);
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
    state.root = dir;
    state.rootName = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    state.path = [{ name: state.rootName, path: dir, isDir: true, kind: 'folder' }];
    state.cols = [];
    state.sel = null;
    state.mode = 'preview';
    state.favs = normalizeFavorites(state.favoritesByRoot[favKey(dir)]);
    // 固定列装的是上一个工作区的文件，换工作区后一律清掉
    while (state.pins.length) destroyPane(state.pins.pop());
    closeFind();
    tempPane.node = null;
    tempPane.bodyKey = '';
    setWelcome(false);
    render();
    await loadColumn(0);
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
      if (!state.previewOpen && opts.revealPreview) {
        state.previewOpen = true;
        $('#btn-preview').classList.remove('is-on');
        pv.setState({ previewOpen: true });
      }
      render();
    }
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

  function renderStatus() {
    if (!state.root) { $('#st-path').textContent = '未打开工作区'; return; }
    const sel = state.sel;
    const parts = state.path.map((f) => f.name);
    if (sel && !sel.node.isDir) parts.push(sel.node.name);
    const el = $('#st-path');
    el.textContent = parts.join(' / ');
    el.title = sel ? sel.node.path : state.root;
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

  /* ============================ 渲染：预览 ============================ */
  function emptyState() {
    return '<div class="state">'
      + '<div class="big">' + icon('folder', '', 26) + '</div>'
      + '<h4>未选择文件</h4>'
      + '<p>在左侧栏中选择一个文件即可在此预览，双击则调用系统默认程序打开。</p>'
      + '<div class="keys">'
      + '<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>'
      + '<span><kbd>→</kbd> 进入目录</span>'
      + '<span><kbd>←</kbd> 返回上级</span>'
      + '<span><kbd>⏎</kbd> 打开</span>'
      + '<span><kbd>Ctrl</kbd><kbd>F</kbd> 查找</span>'
      + '</div></div>';
  }

  function loadingState(text) {
    return '<div class="state"><div class="spinner"></div><p>' + esc(text || '读取中…') + '</p></div>';
  }

  function fallbackCard(node, note) {
    const m = meta.get(node.path);
    return '<div class="state">'
      + '<div class="big">' + icon('box', '', 24) + '</div>'
      + '<h4>' + esc(node.name) + '</h4>'
      + '<p>' + esc(note || '该类型暂不支持内嵌预览') + (m ? '（' + fmtSize(m.size) + '）' : '') + '</p>'
      + '<div class="state-action"><button class="btn-quiet" data-act="external">'
      + icon('external', '', 14) + '<span>用默认程序打开</span></button></div>'
      + '</div>';
  }

  function browserChrome(node, url) {
    // 地址栏显示真实文件地址（可读），iframe 用 pv:// 协议加载（相对资源可解析）
    const shown = 'file:///' + node.path.replace(/\\/g, '/');
    return '<div class="browser">'
      + '<div class="browser-bar">'
      + '<span class="dots"><i class="r"></i><i class="y"></i><i class="g"></i></span>'
      + '<div class="addr">' + icon('lock', '', 12) + '<span title="' + esc(shown) + '">' + esc(shown) + '</span></div>'
      + '<button class="iconbtn" data-act="reload" title="刷新">' + icon('refresh', '', 15) + '</button>'
      + '</div>'
      + '<iframe class="frame" title="' + esc(node.name) + ' 预览" '
      + 'sandbox="allow-scripts allow-forms allow-popups allow-modals" src="' + esc(url) + '"></iframe>'
      + '</div>';
  }

  /** PDF：交给 Chromium 内置阅读器渲染（需要 webPreferences.plugins） */
  function pdfFrame(node, url) {
    return '<div class="pdfview"><iframe class="pdf-frame" title="' + esc(node.name) + ' 预览" '
      + 'src="' + esc(url) + '"></iframe></div>';
  }

  /** docx / pptx：整份字节读进渲染进程，交给 vendor/docpreview.js 里的纯前端解析器 */
  async function renderDocPreview(pane, node, kind, stale) {
    const box = pane.body;
    if (!PV.docpreview) {
      box.innerHTML = fallbackCard(node, '预览组件未构建：请先运行 npm run build');
      return;
    }
    box.innerHTML = loadingState('正在解析 ' + (kind === 'docx' ? 'Word' : 'PowerPoint') + ' 文档…');
    const res = await pv.readBytes(node.path);
    if (stale()) return;
    if (res.error) { box.innerHTML = fallbackCard(node, '读取失败：' + res.error); return; }
    if (res.tooLarge) {
      box.innerHTML = fallbackCard(node, '文件较大（' + fmtSize(res.size) + '），暂不内嵌预览');
      return;
    }

    const raw = res.data;
    let buf = raw;
    if (raw instanceof Uint8Array) buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    else if (raw && raw.type === 'Buffer' && Array.isArray(raw.data)) buf = new Uint8Array(raw.data).buffer;

    const wrap = document.createElement('div');
    wrap.className = 'docview';
    box.innerHTML = '';
    box.appendChild(wrap);
    try {
      if (kind === 'docx') await PV.docpreview.renderDocx(buf, wrap);
      else await PV.docpreview.renderPptx(buf, wrap);
      if (stale()) return;
    } catch (err) {
      console.error('[docpreview]', err);
      // 失败卡片也要先看任务是否还属于自己：用户可能已经切走了，
      // 这时候写进去会盖掉新文件的预览
      if (stale()) return;
      box.innerHTML = fallbackCard(node, '预览失败：' + ((err && err.message) || err));
    }
  }

  /** 源码视图用的语言 id：按当前窗格的模式取，未知语言返回 null（纯文本） */
  function langForNode(node, mode) {
    if (mode === 'source') {
      if (node.kind === 'md') return 'markdown';
      if (node.kind === 'html') return 'html';
      if (node.kind === 'svg') return 'xml';
    }
    return PV.highlight.langFor(node.name);
  }

  /* ============================ 预览窗格 ============================ *
   * 预览区由若干「窗格」组成，每个窗格各自记住文件、模式与宽度：
   *   - 临时预览：只跟随「选中文件」更新。选中文件夹不动它（文件夹没有预览）
   *   - 固定列：由图钉固定下来，最多 MAX_PINS 个，新固定的排在旧固定的右边
   * 选中项已经出现在某个固定列里时，临时预览不再重复展示同一份内容。
   * 每个窗格左侧的边界都可以拖动，且只改这一列的宽度。
   * ------------------------------------------------------------------ */
  const PANE_MIN = 240;        // 单个窗格的最小宽度
  const MAIN_HARD_MIN = 260;   // 栏区的绝对下限（约一栏宽），手动拖动也不越过
  let paneSeq = 0;
  const panes = new Map();

  function createPane(opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.className = 'pane' + (o.pinned ? ' is-pinned' : '');
    const grip = document.createElement('div');
    grip.className = 'pane-resize';
    grip.title = '拖动调整此预览列宽度';
    const head = document.createElement('div');
    head.className = 'pv-head';
    const body = document.createElement('div');
    body.className = 'pv-body is-empty';
    el.appendChild(grip);
    el.appendChild(head);
    el.appendChild(body);
    const pane = {
      id: ++paneSeq,
      pinned: !!o.pinned,
      el: el,
      grip: grip,
      head: head,
      body: body,
      node: o.node || null,
      mode: o.mode || 'preview',
      w: o.w || 0,
      bodyKey: '',
      reqId: 0,           // 任务身份：每次真正重渲染都换一个，用来丢弃晚到的旧响应
      pending: 0,         // 还在读/还在解析的渲染任务数，>0 说明正文是加载态空壳
      view: null,
      findEl: null,
      zoom: o.zoom || 0,  // 图片缩放：0 = 适应窗口，其余是倍数
      continuous: !!o.continuous, // 连续预览：同目录图片竖着排下来
      images: []          // 当前窗格里的 <img>，改缩放时直接落到它们身上
    };
    el.dataset.pane = String(pane.id);
    panes.set(pane.id, pane);
    return pane;
  }

  /** 临时预览列：始终在最左，内容跟随选中的文件 */
  const tempPane = createPane({});

  function destroyPane(pane) {
    // 查找条长在这个窗格里，窗格没了查找状态也就没意义了
    if (findState && findState.pane === pane) findState = null;
    dropPaneView(pane);
    panes.delete(pane.id);
    pane.el.remove();
  }

  /** 代码视图自带 ResizeObserver，换内容前必须销毁，否则越挂越多 */
  function dropPaneView(pane) {
    if (pane.view && pane.view.destroy) pane.view.destroy();
    pane.view = null;
  }

  function paneOf(el) {
    const host = el && el.closest ? el.closest('.pane') : null;
    if (!host) return null;
    return panes.get(Number(host.dataset.pane)) || null;
  }

  function paneMode(pane) {
    return pane.pinned ? pane.mode : state.mode;
  }

  function allPanes() {
    return [tempPane].concat(state.pins);
  }

  /** 临时预览列是否多余：用户关掉了它，或者内容已经在固定列里 */
  function tempPaneHidden() {
    if (!state.previewOpen) return true;
    if (!state.pins.length) return false;
    if (!tempPane.node) return true;
    return isPinnedPath(tempPane.node.path);
  }

  function isPinnedPath(path) {
    return state.pins.some((p) => p.node && p.node.path === path);
  }

  /** 实际显示出来的窗格：临时预览（若不多余）在最左，固定列按固定先后从右往左排 */
  function visiblePanes() {
    const list = [];
    if (!tempPaneHidden()) list.push(tempPane);
    for (let i = 0; i < state.pins.length; i++) list.push(state.pins[i]);
    return list;
  }

  /**
   * 临时预览列只在这两种情况下更新：
   * 1. 选中了一个文件，且这个文件没有出现在任何固定列里
   * 2. 都不满足时保持原样——选中文件夹、或选中「已经固定住的文件」都不动它
   *    （比如固定了 A、临时列在看 B，再点回 A 时 B 要留着）
   */
  function syncTempPane() {
    const sel = state.sel;
    if (!sel || sel.node.isDir) return;
    if (isPinnedPath(sel.node.path)) return;
    tempPane.node = sel.node;
  }

  /**
   * 排列顺序固定为「临时预览 | 固定 1 | 固定 2 | …」。
   * 用 flex order 排，而不是把节点重新 append 一遍：把一个已经挂在文档里的节点
   * 重新 append（等于先摘下来再插回去）会把它内部的滚动位置清零——固定列里
   * 正读到一半的文档会突然跳回顶部。
   */
  function syncPaneOrder(list) {
    for (let i = 0; i < list.length; i++) {
      const pane = list[i];
      if (pane.el.parentNode !== panesEl) panesEl.appendChild(pane.el);
      pane.el.style.order = String(i);
    }
  }

  /* ---- 窗格宽度：每列独立，拖动左边界只改这一列 ---- */
  /** 本次渲染各列实际用的宽度（pane.w 是用户设定，这里是被压缩后的结果） */
  let paneWidths = new Map();
  /** 手动把最左那一列拖宽过之后留下的栏区宽度（0 = 按默认预留） */
  let mainFloor = 0;

  function bodyWidth() {
    return $('#app-body').clientWidth || window.innerWidth;
  }

  /** 栏区的舒适宽度：新增预览列、窗口变窄时按这个值给它留位 */
  function mainComfortWidth() {
    return Math.max(320, Math.round(bodyWidth() * 0.32));
  }

  /**
   * 预览列可用的总宽度：固定列多了以后栏区让步到一栏宽，好让临时预览列保住自己的宽度。
   * mainFloor 是「手动把最左那一列拖宽过」之后留下的栏区宽度：这时栏区按这个下限让位，
   * 拖出来的宽度不会被右邻列抢回去。
   */
  function paneBudget() {
    const n = visiblePanes().length;
    const auto = n >= 3 ? MAIN_HARD_MIN : mainComfortWidth();
    const reserve = mainFloor ? Math.max(MAIN_HARD_MIN, Math.min(auto, mainFloor)) : auto;
    return Math.max(PANE_MIN * n, bodyWidth() - reserve);
  }

  /** 手动拖动时的上限：可以把栏区压到一栏宽，但不允许更窄 */
  function paneDragMax() {
    return Math.max(PANE_MIN, bodyWidth() - MAIN_HARD_MIN);
  }

  function ensurePaneWidths() {
    if (!tempPane.w) tempPane.w = Math.max(PANE_MIN, Math.round(bodyWidth() * 0.46));
  }

  /**
   * 空间不够时按比例压缩，但**只压渲染宽度、不改用户设定的宽度**——
   * pane.w 是「我希望它多宽」，关掉几个预览列后要能原样回来。
   * 压缩顺序也有讲究：先让固定列让位（它们是参考用的，240px 也看得清），
   * 临时预览列是正在读的那一列，尽量保住用户拖出来的宽度。
   */
  function squeezeInto(list, eff, amount) {
    const flex = list.filter((p) => eff.get(p) > PANE_MIN);
    if (!flex.length) return;
    const cap = flex.reduce((s, p) => s + (eff.get(p) - PANE_MIN), 0);
    const cut = Math.min(amount, cap);
    flex.forEach((p) => { eff.set(p, eff.get(p) - Math.round(cut * (eff.get(p) - PANE_MIN) / cap)); });
  }

  function fitPaneWidths() {
    const list = visiblePanes();
    const budget = paneBudget();
    const eff = new Map();
    for (const p of list) eff.set(p, p.w);
    const total = () => list.reduce((s, p) => s + eff.get(p), 0);
    let over = total() - budget;
    if (over > 0) {
      const pins = list.filter((p) => p !== tempPane);
      for (let guard = 0; guard < 8 && over > 0; guard++) {
        squeezeInto(pins, eff, over);
        over = total() - budget;
      }
      for (let guard = 0; guard < 8 && over > 0; guard++) {
        squeezeInto(list, eff, over);
        over = total() - budget;
      }
    }
    paneWidths = eff;
  }

  /** 某一列当前实际渲染的宽度 */
  function effWidth(pane) {
    const w = paneWidths.get(pane);
    return w === undefined ? pane.w : w;
  }

  function applyPaneWidths() {
    fitPaneWidths();
    for (const pane of allPanes()) {
      if (pane.el.hidden) continue;
      pane.el.style.width = Math.round(effWidth(pane)) + 'px';
    }
  }

  /**
   * 手动拖动之前，把「现在看到的宽度」记成各列的设定宽度。
   * 这样拖动时各列加起来正好等于当前总宽，分界线就是 1:1 跟着指针走，
   * 不会再出现「拖了没反应」——因为可用宽度早已被别的列的设定值占满。
   * 代价是这些列不再回弹到更早的设定值：手拖过的布局就是新的设定。
   */
  function freezePaneWidths() {
    fitPaneWidths();
    for (const p of visiblePanes()) p.w = Math.max(PANE_MIN, Math.floor(effWidth(p)));
  }

  function pinCurrent() {
    if (!tempPane.node) return;
    if (state.pins.length >= MAX_PINS) {
      toast('最多固定 ' + MAX_PINS + ' 个预览，先取消一个再固定');
      return;
    }
    // 新固定的排在已有固定列的左边：它本来就在临时预览列的位置上，固定后原地不动
    const pane = createPane({
      pinned: true,
      node: tempPane.node,
      mode: state.mode,
      w: Math.max(PANE_MIN, tempPane.w || Math.round(bodyWidth() * 0.46)),
      zoom: tempPane.zoom,
      continuous: tempPane.continuous
    });
    state.pins.unshift(pane);
    // 正在看的那一屏整块搬过去：连续预览滚到第几张、文档读到哪一段都原地保留。
    // 但正文还在读的时候不能搬——搬过去只是个「读取中…」的空壳，而这次读取属于
    // 原来那一列、回来时会被丢弃，固定列就永远停在加载态。这种情况让新列自己重渲染。
    const keep = tempPane.pending > 0 ? null : adoptPaneBody(pane, tempPane);
    // 查找条长在窗格上：内容被固定到新列时，查询词与高亮一并跟过去
    const carried = !!(findState && findState.pane === tempPane && findState.query);
    if (carried) carryFind(pane, findState.query);
    renderPreview();
    // 位置要等这一列挂进文档、有了布局之后才落得下去（搬家的元素在文档外读不到高度）
    if (keep) restorePaneTop(pane, keep);
    // 正文是搬过来的，没有走重渲染那条路，高亮在这里补落一次
    if (carried) refreshFind();
    toast('已固定：' + pane.node.name);
  }

  /**
   * 把一列的内容整块交给另一列（DOM 直接搬家，不重新渲染）：
   * 滚动位置、已经解码好的图片、连续预览的列表都原样跟着走——固定住一列
   * 不会让它又从第一张图 / 文首开始。
   * 返回搬家前的位置，等新列进了文档再由 restorePaneTop 落回去。
   */
  function adoptPaneBody(to, from) {
    const keep = paneScrollKeep(paneScrollHost(from));
    to.body.className = from.body.className;
    to.bodyKey = from.bodyKey;
    to.images = from.images;
    to.view = from.view;
    from.images = [];
    from.view = null;
    from.bodyKey = '';
    from.body.className = 'pv-body is-empty';
    while (from.body.firstChild) to.body.appendChild(from.body.firstChild);
    return keep;
  }

  /**
   * 记下这一列正在看的位置：图片列按「最上面那张图」记，其它按滚动像素记。
   * 图片列换列后宽度可能变（临时列收起、固定列分到更多宽度），图片跟着变高变矮，
   * 只记像素会落到别的一张上，所以记「哪一张 + 它相对视口顶部的偏移」。
   */
  function paneScrollKeep(sc) {
    if (!sc) return null;
    const keep = { top: sc.scrollTop, item: -1, off: 0 };
    if (!sc.classList.contains('imgseq')) return keep;
    const box = sc.getBoundingClientRect();
    const items = sc.querySelectorAll('.imgseq-item');
    for (let i = 0; i < items.length; i++) {
      if (items[i].getBoundingClientRect().bottom > box.top + 4) {
        keep.item = i;
        keep.off = Math.round(items[i].offsetTop - sc.offsetTop - sc.scrollTop);
        break;
      }
    }
    return keep;
  }

  function restorePaneTop(pane, keep) {
    if (!keep) return;
    const sc = paneScrollHost(pane);
    if (!sc) return;
    if (keep.item >= 0) {
      const items = sc.querySelectorAll('.imgseq-item');
      const at = items[Math.min(keep.item, items.length - 1)];
      if (at) { sc.scrollTop = Math.max(0, at.offsetTop - sc.offsetTop - keep.off); return; }
    }
    sc.scrollTop = keep.top;
  }

  /** 把临时列上的查找条交给新的固定列（正文由 renderPane 重渲染后自动重新落高亮） */
  function carryFind(pane, query) {
    closeFind();
    if (!query) return;
    const bar = ensureFindBar(pane);
    bar.hidden = false;
    bar.querySelector('.find-input').value = query;
    findState = { pane: pane, query: query, hits: [], index: -1, capped: false };
  }

  function unpinPane(pane) {
    const at = state.pins.indexOf(pane);
    if (at < 0) return;
    state.pins.splice(at, 1);
    destroyPane(pane);
    renderPreview();
    toast('已取消固定：' + ((pane.node && pane.node.name) || ''));
  }

  function paneHeadHtml(pane, node) {
    const m = meta.get(node.path);
    const sub = [subPath(node) || node.name];
    sub.push(String(node.kind || '').toUpperCase());
    if (m) { sub.push(fmtSize(m.size)); sub.push(fmtTime(m.mtime)); }
    if (pane.continuous) sub.push('连续预览');

    const mode = paneMode(pane);
    const canSource = ['html', 'md', 'svg'].indexOf(node.kind) >= 0;
    const seg = canSource
      ? '<div class="pv-seg"><div class="seg">'
        + '<button data-mode="preview" class="' + (mode === 'preview' ? 'is-on' : '') + '">预览</button>'
        + '<button data-mode="source" class="' + (mode === 'source' ? 'is-on' : '') + '">源码</button>'
        + '</div></div>'
      : '';

    // 图片：− [适应/150%] + 的缩放档位，以及进入连续预览的向下箭头
    const imageBar = (mode === 'preview' && isImageNode(node))
      ? '<div class="pv-zoom">'
        + '<button data-act="zoom-out" title="缩小（也可 Ctrl+滚轮）" aria-label="缩小">'
        + icon('zoomOut', '', 13) + '</button>'
        + '<button class="zoom-val" data-act="zoom-reset" title="点一下回到适应窗口">'
        + zoomText(pane.zoom) + '</button>'
        + '<button data-act="zoom-in" title="放大（也可 Ctrl+滚轮）" aria-label="放大">'
        + icon('zoomIn', '', 13) + '</button>'
        + '</div>'
        + '<button class="iconbtn seqbtn' + (pane.continuous ? ' is-on' : '')
        + '" data-act="seq" aria-label="连续预览" title="'
        + (pane.continuous ? '退出连续预览' : '连续预览：向下滚动看同目录后面的图片') + '">'
        + icon('arrowDown', '', 15) + '</button>'
      : '';

    // 图钉 / 刷新 / 关闭放在最右，低频的三个排在左边
    return '<span class="pv-ic">' + nodeIcon(node, 17) + '</span>'
      + '<div class="pv-name"><div class="pv-nm" title="' + esc(node.name) + '">' + esc(node.name) + '</div>'
      + '<div class="pv-sub" title="' + esc(sub.join(' · ')) + '">' + esc(sub.join(' · ')) + '</div></div>'
      + '<div class="pv-actions">' + seg + imageBar
      + '<div class="pv-btns">'
      + '<button class="iconbtn" data-act="copy" title="复制路径">' + icon('copy', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="reveal" title="在资源管理器中显示">' + icon('reveal', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="external" title="用默认程序打开">' + icon('external', '', 15) + '</button>'
      + '<button class="iconbtn pinbtn' + (pane.pinned ? ' is-on' : '') + '" data-act="pin" title="'
      + (pane.pinned ? '取消固定' : '固定此预览') + '" aria-label="固定预览">'
      + icon(pane.pinned ? 'pinFilled' : 'pin', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="reload" title="重新读取">' + icon('refresh', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="close" title="' + (pane.pinned ? '关闭此预览列' : '收起预览') + '">'
      + icon('close', '', 15) + '</button>'
      + '</div></div>';
  }

  /** 渲染一个窗格：头部每次重建（元信息会异步补发），内容按 key 增量渲染 */
  function renderPane(pane, force) {
    const node = pane.node;
    // 连续预览只对「图片 + 预览模式」有意义，切到别的文件/源码视图时自动退出
    if (pane.continuous && !(node && paneMode(pane) === 'preview' && isImageNode(node))) {
      pane.continuous = false;
    }
    pane.head.innerHTML = node ? paneHeadHtml(pane, node) : '';

    if (!node) {
      if (findState && findState.pane === pane) closeFind();
      if (force || pane.bodyKey !== 'none') {
        pane.bodyKey = 'none';
        dropPaneView(pane);
        pane.images = [];
        pane.body.className = 'pv-body is-empty';
        pane.body.innerHTML = emptyState();
      }
      return;
    }

    const mode = paneMode(pane);
    const key = [node.path, mode, pane.continuous ? 'seq' : '',
      node.kind === 'docx' && !state.previewDocx ? 'docx-off' : '',
      node.kind === 'pptx' && !state.previewPptx ? 'pptx-off' : ''].join('\u0001');
    if (!force && key === pane.bodyKey) return;
    pane.bodyKey = key;
    pane.body.className = 'pv-body';
    dropPaneView(pane);
    // 任务身份与内容 key 分开：key 只说明「该显示什么」，同一个文件重新读取时 key
    // 不变，只有每次渲染新发的编号能区分前后两次请求，晚到的旧响应才不会盖住新内容。
    const req = ++pane.reqId;
    pane.pending++;
    const body = Promise.resolve(renderPaneBody(pane, node, mode, key, req))
      .finally(() => { pane.pending--; });
    // 正文是异步填的（读文件、解析文档、取图片地址），填完再把查找高亮落回去
    if (findState && findState.pane === pane) {
      Promise.resolve(body).then(() => {
        if (findState && findState.pane === pane && pane.reqId === req) refreshFind();
      });
    }
  }

  async function renderPaneBody(pane, node, mode, key, req) {
    const box = pane.body;
    // 只认自己那一次请求：晚到的旧响应直接丢掉，不碰 DOM
    const stale = () => pane.reqId !== req;

    // 交给协议地址直接渲染的类型：HTML 迷你浏览器 / 图片 / PDF 内置阅读器
    if (mode === 'preview' && ['html', 'image', 'svg', 'pdf'].indexOf(node.kind) >= 0) {
      box.innerHTML = loadingState();
      const res = await pv.previewUrl(node.path);
      if (stale()) return;
      if (!res.url) { box.innerHTML = fallbackCard(node, '无法生成预览地址'); return; }
      if (node.kind === 'html') box.innerHTML = browserChrome(node, res.url);
      else if (node.kind === 'pdf') box.innerHTML = pdfFrame(node, res.url);
      else if (pane.continuous) await renderImageSeq(pane, node, key);
      else renderImageView(pane, node, res.url);
      return;
    }

    // 设置里关掉时不再内嵌解析，走下面的通用分支落到兜底卡片
    if (node.kind === 'docx' && state.previewDocx) { await renderDocPreview(pane, node, 'docx', stale); return; }
    if (node.kind === 'pptx' && state.previewPptx) { await renderDocPreview(pane, node, 'pptx', stale); return; }

    box.innerHTML = loadingState();
    const res = await pv.read(node.path);
    if (stale()) return;

    if (res.error) {
      box.innerHTML = fallbackCard(node, res.error === 'IS_DIR' ? '这是一个目录' : '读取失败：' + res.error);
      return;
    }
    if (res.binary) {
      box.innerHTML = fallbackCard(node, '该类型暂不支持内嵌预览');
      return;
    }

    const notice = [];
    if (res.truncated) notice.push('文件较大，仅显示前 5 MB');
    if (res.lossy) notice.push('编码无法识别，可能存在乱码');
    const noticeHtml = notice.length ? '<div class="notice">' + notice.join(' · ') + '</div>' : '';

    if (node.kind === 'md' && mode === 'preview') {
      box.innerHTML = noticeHtml + '<div class="prose-wrap"><article class="prose">' + mdToHtml(res.text) + '</article></div>';
      PV.highlight.highlightFences(box.querySelector('.prose'));
      return;
    }

    // 其余一律走代码视图：分词在 Worker 里做，主线程只渲染可见窗口
    box.innerHTML = noticeHtml;
    pane.view = PV.highlight.mount(box, {
      text: res.text,
      size: res.size,
      mtime: res.mtime,
      path: node.path,
      lang: langForNode(node, mode)
    });
  }

  /* ============================ 图片：缩放与连续预览 ============================ *
   * 单张：− / + 按档位缩放，点中间那格回到「适应窗口」，Ctrl+滚轮同样能缩放。
   * 连续：向下箭头进入，把「当前图片所在目录里排在它后面的图片」竖着排下来，
   *       滚动即看下一张；图片走原生懒加载，只有快滚到的才会真的去取。
   * ------------------------------------------------------------------------- */
  /** 缩放档位（pane.zoom = 0 表示适应窗口） */
  const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
  /** 连续预览一次最多列多少张，避免超大目录把 DOM 撑爆 */
  const SEQ_MAX = 300;

  function isImageNode(node) {
    return !!node && !node.isDir && (node.kind === 'image' || node.kind === 'svg');
  }

  function zoomText(zoom) {
    return zoom ? Math.round(zoom * 100) + '%' : '适应';
  }

  /** 把 pane.zoom 落到这个窗格里的每张图上（各自按自己的原始尺寸算） */
  function applyZoom(pane) {
    for (const img of pane.images) {
      if (!pane.zoom) {
        img.style.width = '';
        img.style.height = '';
        continue;
      }
      // 还没解码出尺寸的图先不动，等 load 回来再套
      if (!img.naturalWidth) continue;
      img.style.width = Math.max(24, Math.round(img.naturalWidth * pane.zoom)) + 'px';
      img.style.height = 'auto';
    }
    const wrap = pane.body.querySelector('.img-wrap');
    if (wrap) wrap.classList.toggle('is-zoom', !!pane.zoom);
    const seq = pane.body.querySelector('.imgseq');
    if (seq) seq.classList.toggle('is-zoom', !!pane.zoom);
  }

  function setZoom(pane, zoom) {
    pane.zoom = zoom;
    applyZoom(pane);
    const label = pane.head.querySelector('[data-act="zoom-reset"]');
    if (label) label.textContent = zoomText(zoom);
  }

  /** 在档位之间走一步；从「适应窗口」出发时，放大到 100%、缩小到 75% */
  function stepZoom(pane, dir) {
    const cur = pane.zoom || 0;
    let next;
    if (!cur) {
      next = dir > 0 ? 1 : 0.75;
    } else {
      const at = ZOOM_STEPS.indexOf(cur);
      const from = at < 0 ? ZOOM_STEPS.findIndex((z) => z > cur) : at + dir;
      next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, from))];
    }
    setZoom(pane, next);
  }

  /**
   * Ctrl+滚轮缩放（不按 Ctrl 的滚轮留给滚动，不抢）。
   * 监听挂在图片容器上，而这个容器可能已经被「固定」搬到别的窗格里，
   * 所以每次按键都按它当前所在的窗格算。
   */
  function bindZoomWheel(pane, host) {
    host.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      stepZoom(paneOf(host) || pane, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  function newImage(pane, node, url, lazy) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = node.name;
    img.draggable = false;
    if (lazy) img.loading = 'lazy';
    // 图片可能已经跟着内容搬到了别的窗格，缩放要落在它现在那一列上
    img.addEventListener('load', () => applyZoom(paneOf(img) || pane));
    pane.images.push(img);
    return img;
  }

  function renderImageView(pane, node, url) {
    pane.body.innerHTML = '';
    pane.images = [];
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    wrap.appendChild(newImage(pane, node, url, false));
    pane.body.appendChild(wrap);
    applyZoom(pane);
    bindZoomWheel(pane, wrap);
  }

  /** 同目录里的图片，顺序与栏内一致（搜索过滤也算） */
  async function imageSequence(node) {
    const dir = node.path.replace(/[\\/][^\\/]*$/, '');
    let entries = null;
    for (let ci = 0; ci < state.cols.length; ci++) {
      const col = state.cols[ci];
      if (col && col.dir === dir && col.entries) { entries = itemsOf(ci); break; }
    }
    if (!entries) {
      // 这个目录没开在栏里（固定列可能指向别处）：直接问一次文件系统
      const res = await pv.list(dir);
      entries = res && res.entries ? res.entries.slice() : [];
      entries.sort((a, b) => (a.isDir !== b.isDir)
        ? (a.isDir ? -1 : 1)
        : a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    }
    return entries.filter(isImageNode);
  }

  async function renderImageSeq(pane, node, key) {
    const seq = await imageSequence(node);
    if (pane.bodyKey !== key) return;

    let at = seq.findIndex((e) => e.path === node.path);
    if (at < 0) at = 0;
    const rest = seq.slice(at);
    const shown = rest.slice(0, SEQ_MAX);

    const urls = await Promise.all(shown.map((e) => pv.previewUrl(e.path)));
    if (pane.bodyKey !== key) return;

    pane.body.innerHTML = '';
    pane.images = [];
    const box = document.createElement('div');
    box.className = 'imgseq';
    for (let i = 0; i < shown.length; i++) {
      const fig = document.createElement('figure');
      fig.className = 'imgseq-item' + (shown[i].path === node.path ? ' is-current' : '');
      fig.dataset.path = shown[i].path;
      if (urls[i] && urls[i].url) {
        fig.appendChild(newImage(pane, shown[i], urls[i].url, i > 0));
      } else {
        const bad = document.createElement('div');
        bad.className = 'imgseq-cap';
        bad.textContent = '无法生成预览地址';
        fig.appendChild(bad);
      }
      const cap = document.createElement('figcaption');
      cap.className = 'imgseq-cap';
      cap.innerHTML = '<span class="n">' + (at + i + 1) + ' / ' + seq.length + '</span>'
        + '<span class="nm" title="' + esc(shown[i].name) + '">' + esc(shown[i].name) + '</span>';
      fig.appendChild(cap);
      box.appendChild(fig);
    }
    if (rest.length > shown.length) {
      const note = document.createElement('div');
      note.className = 'imgseq-note';
      note.textContent = '这个目录后面还有 ' + (rest.length - shown.length)
        + ' 张图片，只列到前 ' + SEQ_MAX + ' 张';
      box.appendChild(note);
    }
    pane.body.appendChild(box);
    applyZoom(pane);
    bindZoomWheel(pane, box);
    box.scrollTop = 0;
  }

  function toggleSeq(pane) {
    pane.continuous = !pane.continuous;
    toast(pane.continuous ? '连续预览：向下滚动看同目录后面的图片' : '已退出连续预览');
    renderPane(pane, true);
  }

  function renderPreview(force) {
    syncTempPane();
    // 关掉临时预览列不影响固定列：整块预览区只在「一列都没有」时才收起
    const list = visiblePanes();
    previewEl.hidden = list.length === 0;
    if (!list.length) return;

    for (const pane of allPanes()) pane.el.hidden = list.indexOf(pane) < 0;
    syncPaneOrder(list);

    ensurePaneWidths();
    applyPaneWidths();   // 里面会按可用宽度重算每列的实际宽度

    for (let i = 0; i < list.length; i++) renderPane(list[i], force);
    // 临时预览列被收起来（内容已经在固定列里）时，挂在它上面的查找条一并收掉
    if (findState && findState.pane.el.hidden) closeFind();
  }

  /* ============================ 预览内查找 ============================ *
   * Ctrl+F 在「渲染成真实 DOM 的预览」里查关键字：
   *   - 参与查找：Markdown 预览、Word / PPT 内嵌预览
   *   - 不参与：代码视图（按窗口渲染，DOM 里只有可见的几十行）、图片、PDF、HTML（在 iframe 里）
   * 命中处原地包一层 <mark>，当前命中再加 .is-current 并滚到视口中间。
   * ------------------------------------------------------------------ */
  /** 单次查找最多标记多少个命中，避免超大文档把主线程卡住 */
  const FIND_MAX = 2000;
  /** 最近一次指针位置：Ctrl+F 优先作用在指针下的那个窗格 */
  const pointer = { x: -1, y: -1 };
  let activePaneId = 0;
  let findState = null;   // { pane, query, hits, index, capped }

  function paneFindable(pane) {
    if (!pane || !pane.node || pane.node.isDir) return false;
    if (pane.el.hidden) return false;
    const box = pane.body;
    if (!box || box.classList.contains('is-empty')) return false;
    if (box.querySelector('.codeview, .img-wrap, .imgseq, iframe')) return false;
    return !!box.querySelector('.prose, .docview');
  }

  /** Ctrl+F 会落在哪个窗格：指针下的 → 最近点过的 → 最左的可见窗格 */
  function targetPane() {
    const list = visiblePanes().filter((p) => !p.el.hidden);
    if (!list.length) return null;
    const hovered = paneOf(document.elementFromPoint(pointer.x, pointer.y));
    if (hovered && list.indexOf(hovered) >= 0) return hovered;
    const active = panes.get(activePaneId);
    if (active && list.indexOf(active) >= 0) return active;
    return list[0];
  }

  function ensureFindBar(pane) {
    if (pane.findEl) return pane.findEl;
    const el = document.createElement('div');
    el.className = 'find-bar';
    el.hidden = true;
    el.innerHTML = icon('search', 'find-ic', 14)
      + '<input class="find-input" type="text" placeholder="在预览中查找…" spellcheck="false" '
      + 'autocomplete="off" aria-label="在预览中查找">'
      + '<span class="find-count"></span>'
      + '<button class="iconbtn" data-find="prev" title="上一个匹配 (Shift+Enter)" aria-label="上一个匹配">'
      + icon('arrowUp', '', 14) + '</button>'
      + '<button class="iconbtn" data-find="next" title="下一个匹配 (Enter)" aria-label="下一个匹配">'
      + icon('arrowDown', '', 14) + '</button>'
      + '<button class="iconbtn" data-find="close" title="关闭查找 (Esc)" aria-label="关闭查找">'
      + icon('close', '', 14) + '</button>';
    // 夹在窗格头部与正文之间
    pane.el.insertBefore(el, pane.body);
    pane.findEl = el;

    const input = el.querySelector('.find-input');
    input.addEventListener('input', () => {
      if (!findState || findState.pane !== pane) return;
      findState.query = input.value.trim();
      applyFind();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); return; }
      // 这里必须拦下 Esc，否则会冒泡到全局处理器去清空文件名搜索框
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
    });
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-find]');
      if (!btn) return;
      if (btn.dataset.find === 'prev') stepFind(-1);
      else if (btn.dataset.find === 'next') stepFind(1);
      else closeFind();
    });
    return el;
  }

  function openFind(pane) {
    if (!pane) return false;
    if (findState && findState.pane !== pane) closeFind();
    const bar = ensureFindBar(pane);
    bar.hidden = false;
    if (!findState) findState = { pane: pane, query: '', hits: [], index: -1, capped: false };
    const input = bar.querySelector('.find-input');
    input.focus();
    input.select();
    updateFindBar();
    return true;
  }

  /** 关掉查找：撤掉高亮、清空输入，焦点不停在查找框里 */
  function closeFind() {
    const f = findState;
    findState = null;
    if (!f) return;
    clearMarks(f.pane.body);
    const bar = f.pane.findEl;
    if (!bar) return;
    const input = bar.querySelector('.find-input');
    if (input) { input.value = ''; input.blur(); }
    bar.hidden = true;
  }

  function updateFindBar() {
    const f = findState;
    if (!f || !f.pane.findEl) return;
    const count = f.pane.findEl.querySelector('.find-count');
    if (!f.query) {
      count.textContent = '';
      count.classList.remove('is-none');
    } else if (!f.hits.length) {
      count.textContent = '无匹配';
      count.classList.add('is-none');
    } else {
      count.textContent = (f.index + 1) + '/' + f.hits.length + (f.capped ? '+' : '');
      count.classList.remove('is-none');
    }
  }

  /** 正文里所有可参与查找的文本节点（跳过查找条自身、脚本样式与已经包好的命中） */
  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script, style, textarea, .find-bar, mark.find-hit')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const out = [];
    let n = walker.nextNode();
    while (n) { out.push(n); n = walker.nextNode(); }
    return out;
  }

  /** 把命中处原地包成 <mark>，返回全部命中元素（文档顺序） */
  function markMatches(root, query) {
    const needle = query.toLowerCase();
    const hits = [];
    let capped = false;
    for (const node of collectTextNodes(root)) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let at = lower.indexOf(needle);
      if (at < 0) continue;
      const frag = document.createDocumentFragment();
      let cut = 0;
      while (at >= 0) {
        if (hits.length >= FIND_MAX) { capped = true; break; }
        if (at > cut) frag.appendChild(document.createTextNode(text.slice(cut, at)));
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = text.slice(at, at + needle.length);
        frag.appendChild(mark);
        hits.push(mark);
        cut = at + needle.length;
        at = lower.indexOf(needle, cut);
      }
      // 触发上限时，这一节剩下的原文照原样补回去
      if (cut < text.length) frag.appendChild(document.createTextNode(text.slice(cut)));
      node.parentNode.replaceChild(frag, node);
      if (capped) break;
    }
    return { hits: hits, capped: capped };
  }

  /** 撤掉查找高亮，把正文还原成纯文本节点 */
  function clearMarks(root) {
    if (!root) return;
    const marks = root.querySelectorAll('mark.find-hit');
    if (!marks.length) return;
    const parents = [];
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      if (parents.indexOf(parent) < 0) parents.push(parent);
    }
    // 合并被切开后相邻的文本节点，避免反复查找让 DOM 越来越碎
    for (const parent of parents) parent.normalize();
  }

  function applyFind() {
    const f = findState;
    if (!f) return;
    clearMarks(f.pane.body);
    f.hits = [];
    f.index = -1;
    f.capped = false;
    if (f.query) {
      const res = markMatches(f.pane.body, f.query);
      f.hits = res.hits;
      f.capped = res.capped;
      if (f.hits.length) { f.index = 0; focusFindHit(); }
    }
    updateFindBar();
  }

  /** 当前命中换成强调色并滚到视口中间 */
  function focusFindHit() {
    const f = findState;
    if (!f) return;
    for (let i = 0; i < f.hits.length; i++) {
      f.hits[i].classList.toggle('is-current', i === f.index);
    }
    const hit = f.hits[f.index];
    if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function stepFind(delta) {
    const f = findState;
    if (!f || !f.hits.length) return;
    f.index = (f.index + delta + f.hits.length) % f.hits.length;
    focusFindHit();
    updateFindBar();
  }

  /** 正文重渲染之后重新落高亮；已经不满足查找条件就直接关掉查找条 */
  function refreshFind() {
    const f = findState;
    if (!f) return;
    if (f.pane.el.hidden || !paneFindable(f.pane)) { closeFind(); return; }
    applyFind();
  }

  /* ============================ 总渲染 ============================ */
  function render() {
    if (!state.root) {
      renderCrumbs();
      renderStatus();
      renderPreview();
      return;
    }
    renderCrumbs();
    renderColumns();
    renderPreview();
    renderStatus();
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

  function togglePreview(force) {
    state.previewOpen = typeof force === 'boolean' ? force : !state.previewOpen;
    $('#btn-preview').classList.toggle('is-on', !state.previewOpen);
    // 预览整个收起来时，挂在上面的查找条也一起收掉
    if (!state.previewOpen) closeFind();
    renderPreview();
    pv.setState({ previewOpen: state.previewOpen });
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

  /* 记录指针位置与最近操作的窗格：Ctrl+F 默认落在指针下的那个窗格 */
  document.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }, { passive: true });
  previewEl.addEventListener('pointerdown', (e) => {
    const pane = paneOf(e.target);
    if (pane) activePaneId = pane.id;
  });
  // 点回栏区就把「当前操作区」交还给文件列表（↑↓ 随之回到换选中项）
  colsEl.addEventListener('pointerdown', () => { activePaneId = 0; });
  // 滚轮滚过哪一边，也把操作区算到哪一边
  previewEl.addEventListener('wheel', (e) => {
    const pane = paneOf(e.target);
    if (pane) activePaneId = pane.id;
  }, { passive: true });
  colsEl.addEventListener('wheel', () => { activePaneId = 0; }, { passive: true });

  /* 焦点在预览里时 ↑↓ 滚的是预览内容，不动文件列表的选中项 */
  const PANE_SCROLLERS = ['.prose-wrap', '.cv-scroll', '.imgseq', '.img-wrap', '.docview', '.pdfview'];

  function paneScroller(pane) {
    for (const sel of PANE_SCROLLERS) {
      const el = pane.body.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 2) return el;
    }
    return null;
  }

  /** 窗格里的滚动容器，不管它现在能不能滚（图片列的高度要等图片解码完才准） */
  function paneScrollHost(pane) {
    for (const sel of PANE_SCROLLERS) {
      const el = pane.body.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** 返回是否真的滚了：焦点在预览里但这一列没得滚时，按键就到此为止 */
  function scrollPaneBy(pane, dir) {
    const el = paneScroller(pane);
    if (!el) return false;
    const step = Math.max(72, Math.round(el.clientHeight * 0.15));
    el.scrollTop += dir * step;
    return true;
  }

  /* 预览区操作：所有窗格的头部按钮与卡片内按钮走同一套分派 */
  previewEl.addEventListener('click', (e) => {
    const pane = paneOf(e.target);
    if (!pane) return;
    const node = pane.node;

    const btn = e.target.closest('button[data-act], button[data-mode]');
    if (!btn) return;
    if (btn.dataset.mode) {
      if (!node) return;
      // 临时预览列沿用全局模式，固定住的窗格各记一份
      if (pane.pinned) pane.mode = btn.dataset.mode;
      else state.mode = btn.dataset.mode;
      renderPane(pane, true);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'pin') { if (pane.pinned) unpinPane(pane); else pinCurrent(); return; }
    if (act === 'close') { if (pane.pinned) unpinPane(pane); else togglePreview(false); return; }
    if (act === 'zoom-in') { if (node) stepZoom(pane, 1); return; }
    if (act === 'zoom-out') { if (node) stepZoom(pane, -1); return; }
    if (act === 'zoom-reset') { if (node) setZoom(pane, 0); return; }
    if (act === 'seq') { if (node) toggleSeq(pane); return; }
    if (!node) return;
    if (act === 'reload') {
      btn.classList.add('spin');
      setTimeout(() => btn.classList.remove('spin'), 520);
      renderPane(pane, true);
    } else if (act === 'copy') {
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

  /** 手动拖动窗格左侧边界：分界线跟着指针走，左邻那一列让出 / 收回同样的宽度 */
  let paneDrag = null;
  panesEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest ? e.target.closest('.pane-resize') : null;
    if (!grip) return;
    const pane = paneOf(grip);
    if (!pane) return;
    e.preventDefault();
    paneDrag = { pane: pane, x: e.clientX, w: effWidth(pane), tempW: tempPane.w, frozen: false };
    grip.classList.add('is-drag');
    // 合成事件没有真实指针，捕获失败不影响拖动
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.classList.add('resizing');
  });
  panesEl.addEventListener('pointermove', (e) => {
    if (!paneDrag) return;
    const pane = paneDrag.pane;
    if (!paneDrag.frozen) {
      // 以「现在看到的宽度」作为各列的设定宽度再开始拖：这时它们加起来正好是当前总宽，
      // 分界线就是 1:1 跟着指针走，不会被「按比例压缩」那一套稀释掉
      freezePaneWidths();
      const list = visiblePanes();
      const at = list.indexOf(pane);
      paneDrag.left = at > 0 ? list[at - 1] : null;
      paneDrag.w = pane.w;
      paneDrag.leftW = paneDrag.left ? paneDrag.left.w : 0;
      paneDrag.frozen = true;
    }
    const dx = e.clientX - paneDrag.x;   // 向左拖为负
    if (paneDrag.left) {
      // 这两列加起来不变：一列变宽，另一列就变窄，各自都不低于下限
      const pair = paneDrag.w + paneDrag.leftW;
      const want = Math.min(pair - PANE_MIN, Math.max(PANE_MIN, paneDrag.w - dx));
      pane.w = want;
      paneDrag.left.w = pair - want;
    } else {
      // 最左那一列：左边是栏区，加宽就从栏区借，栏区不低于硬下限
      const others = visiblePanes().reduce((s, p) => s + (p === pane ? 0 : p.w), 0);
      const max = Math.max(PANE_MIN, paneDragMax() - others);
      pane.w = Math.min(max, Math.max(PANE_MIN, paneDrag.w - dx));
      // 记下这一拖给栏区留了多宽：拖动结束后按这个下限留住它，
      // 不然刚拖出来的宽度会被「按比例压缩」分给右边的固定列
      const left = bodyWidth() - (pane.w + others);
      const auto = visiblePanes().length >= 3 ? MAIN_HARD_MIN : mainComfortWidth();
      mainFloor = left >= auto ? 0 : left;
    }
    applyPaneWidths();
  });
  panesEl.addEventListener('pointerup', () => {
    if (!paneDrag) return;
    const drag = paneDrag;
    const pane = drag.pane;
    paneDrag = null;
    pane.grip.classList.remove('is-drag');
    document.body.classList.remove('resizing');
    // 临时预览列的宽度沿用原来的设置项，重启后恢复（它自己拖动、或被左邻让出宽度都算）
    if (!pane.pinned) pv.setState({ previewWidth: pane.w });
    else if (tempPane.w !== drag.tempW) pv.setState({ previewWidth: tempPane.w });
  });

  /* 顶部按钮 */
  $('#btn-preview').addEventListener('click', () => togglePreview());
  $('#btn-theme').addEventListener('click', () => {
    applyTheme(state.theme === 'light' ? 'dark' : 'light');
  });
  $('#btn-rescan').addEventListener('click', () => rescan());
  $('#btn-open').addEventListener('click', async () => {
    const res = await pv.pickFolder();
    if (res && res.root) toast('已打开：' + res.root);
  });
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
  $('#w-open').addEventListener('click', async () => {
    const res = await pv.pickFolder();
    if (res && res.root) toast('已打开：' + res.root);
  });
  $('#w-sample').addEventListener('click', async () => {
    const dir = await pv.getSampleRoot();
    if (!dir) return;
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
        const pane = targetPane();
        if (pane && paneFindable(pane)) { openFind(pane); return; }
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
    if (e.key === 'Escape' && findState) { closeFind(); return; }
    if (!state.root) return;

    const sel = state.sel;
    const ci = sel ? sel.col : 0;
    const items = itemsOf(ci);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 最近一次点在预览里：↑↓ 归预览内容（读长文档、翻连续预览都用它），不动文件选中项
      const focused = panes.get(activePaneId);
      if (focused && !focused.el.hidden) {
        e.preventDefault();
        scrollPaneBy(focused, e.key === 'ArrowDown' ? 1 : -1);
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
      }
    }
  });

  /* 窗口尺寸变化：重排虚拟列表窗口，必要时压缩预览列宽度、重算左栏上下比例 */
  window.addEventListener('resize', () => {
    for (let ci = 0; ci < state.path.length; ci++) renderColumnWindow(ci);
    fitPaneWidths();
    applyPaneWidths();
    const colEl = colsEl.children[0];
    if (colEl && colEl.querySelector('.fav-panel')) applyLeftSplit(colEl);
  });

  /* 根目录栏是 sticky 的：横向滚动后加一层投影，和后面的栏区分开 */
  colsEl.addEventListener('scroll', () => {
    colsEl.classList.toggle('is-scrolled', colsEl.scrollLeft > 0);
  }, { passive: true });

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
    for (const key of Object.keys(metas)) {
      if (metas[key]) meta.set(key, metas[key]);
    }
    // 元信息到齐后刷新预览头（大小 / 修改时间）
    renderPreview();
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
    renderPreview(true);
    toast('Word 内嵌预览：' + (state.previewDocx ? '开' : '关')
      + ' · PPT 内嵌预览：' + (state.previewPptx ? '开' : '关'));
  });

  /* ============================ 启动 ============================ */
  (async function init() {
    const st = await pv.getState();
    document.documentElement.dataset.theme = st.theme === 'dark' ? 'dark' : 'light';
    state.theme = st.theme === 'dark' ? 'dark' : 'light';
    $('#theme-ic').innerHTML = state.theme === 'light' ? PV.icons.ICONS.moon : PV.icons.ICONS.sun;
    state.previewOpen = st.previewOpen !== false;
    $('#btn-preview').classList.toggle('is-on', !state.previewOpen);
    state.hideDot = !!st.hideDot;
    state.favTop = !!st.favTop;
    // 上下比例跟着位置走：默认上 2/3、下 1/3，拖动过之后一直用拖动结果
    if (typeof st.leftSplitRatio === 'number' && st.leftSplitRatio > 0) {
      state.splitRatio = Math.min(0.92, Math.max(0.08, st.leftSplitRatio));
    }
    state.previewDocx = st.previewDocx !== false;
    state.previewPptx = st.previewPptx !== false;
    state.favoritesByRoot = st.favorites && typeof st.favorites === 'object' ? st.favorites : {};
    // 主进程有可能在读取设置期间就已经把工作区打开了，这时补上该工作区的快速访问项
    if (state.root) {
      state.favs = normalizeFavorites(state.favoritesByRoot[favKey(state.root)]);
      render();
    }
    if (st.previewWidth > 0) tempPane.w = Math.max(PANE_MIN, st.previewWidth);
    applyMaximized(await pv.isMaximized());
    // 主进程可能在读设置的同时已经把工作区打开了，这里不能反过来盖住它
    if (!st.lastRoot && !state.root) {
      setWelcome(true);
      render();
    }
  })();
})();
