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
  /** 快速访问面板的最小高度（只放得下标题栏） */
  const FAV_MIN_H = 34;

  const state = {
    root: null,
    rootName: '',
    path: [],        // 每级目录节点，path[0] 是工作区根
    cols: [],        // 每栏的加载状态与原始条目
    sel: null,       // { col, node }
    mode: 'preview', // 临时预览列的「预览 / 源码」模式
    query: '',
    theme: 'light',
    previewOpen: true,
    pendingScroll: false,
    hideDot: false,          // 是否隐藏以 . 开头的条目
    previewDocx: true,       // 是否内嵌预览 .docx（设置里可关）
    previewPptx: true,       // 是否内嵌预览 .pptx（设置里可关）
    favs: [],                // 当前工作区的快速访问项 [{ path, name, isDir, kind }]
    favoritesByRoot: {},     // 持久化的快速访问项（按工作区根目录分组）
    pins: [],                // 固定住的预览列（最多 MAX_PINS 个），[0] 是最新固定的，排在最左
    favTop: false,           // 最左栏：快速访问面板是否在上（false = 项目根目录在上）
    favH: 0                  // 快速访问面板高度（px）；0 = 按内容收缩，最多占该栏 1/3
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

  function metaText(node) {
    if (node.isDir) return '';
    const m = meta.get(node.path);
    return m ? fmtSize(m.size) : '';
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
   * 高度默认按内容收缩、最多该栏 1/3；用户拖过分隔条后按拖动结果固定。
   * 置顶按钮只出现在当前处于下方的那一个面板的标题栏上。
   */
  function renderFavorites() {
    const colEl = colsEl.children[0];
    if (!colEl) return;
    const panel = colEl.querySelector('.fav-panel');
    if (!panel) return;
    panel.hidden = false;
    applyFavHeight(colEl);
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

  /** 快速访问面板的高度：未手动拖动过就交给 CSS 按内容收缩（上限 1/3） */
  function applyFavHeight(colEl) {
    const panel = colEl && colEl.querySelector('.fav-panel');
    if (!panel) return;
    if (state.favH > 0) {
      panel.style.flex = '0 0 ' + state.favH + 'px';
      panel.style.maxHeight = 'none';
    } else {
      panel.style.flex = '';
      panel.style.maxHeight = '';
    }
  }

  /** 拖动分隔条改变上下比例：只改快速访问面板的高度 */
  function favHeightLimits(colEl) {
    const colH = colEl.getBoundingClientRect().height;
    // 下限只留得下标题栏；上限给另一个面板留下约 145px（扣掉栏头与分隔条）
    return { min: FAV_MIN_H, max: Math.max(FAV_MIN_H, Math.round(colH - 180)) };
  }

  function setFavHeight(colEl, px) {
    const lim = favHeightLimits(colEl);
    state.favH = Math.round(Math.min(Math.max(px, lim.min), lim.max));
    applyFavHeight(colEl);
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
    row.classList.toggle('is-broken', !!node.broken);
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
    row.title = node.name + '\n' + node.path;
    row.setAttribute('role', 'button');
    row.innerHTML = nodeIcon(node)
      + '<span class="nm">' + esc(node.name) + '</span>'
      + '<span class="meta">' + esc(metaText(node)) + '</span>'
      + '<button class="row-fav" tabindex="-1" aria-label="快速访问"></button>'
      + (node.isDir ? '<span class="chev">' + icon('chevron', '', 14) + '</span>' : '');
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
      view: null
    };
    el.dataset.pane = String(pane.id);
    panes.set(pane.id, pane);
    return pane;
  }

  /** 临时预览列：始终在最左，内容跟随选中的文件 */
  const tempPane = createPane({});

  function destroyPane(pane) {
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

  /** 临时预览列是否多余：已经有固定列，且当前没有「没被固定住的文件」可看 */
  function tempPaneHidden() {
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

  /* ---- 窗格宽度：每列独立，拖动左边界只改这一列 ---- */
  function bodyWidth() {
    return $('#app-body').clientWidth || window.innerWidth;
  }

  /** 栏区的舒适宽度：新增预览列、窗口变窄时按这个值给它留位 */
  function mainComfortWidth() {
    return Math.max(320, Math.round(bodyWidth() * 0.32));
  }

  /** 预览列可用的总宽度（自动分配时用） */
  function paneBudget() {
    return Math.max(PANE_MIN, bodyWidth() - mainComfortWidth());
  }

  /** 手动拖动时的上限：可以把栏区压到一栏宽，但不允许更窄 */
  function paneDragMax() {
    return Math.max(PANE_MIN, bodyWidth() - MAIN_HARD_MIN);
  }

  function ensurePaneWidths() {
    if (!tempPane.w) tempPane.w = Math.max(PANE_MIN, Math.round(bodyWidth() * 0.46));
  }

  /** 总宽超出可用宽度时按比例压缩（各自压到下限为止） */
  function fitPaneWidths() {
    const list = visiblePanes();
    const budget = paneBudget();
    let total = list.reduce((s, p) => s + p.w, 0);
    let over = total - budget;
    for (let guard = 0; guard < 8 && over > 0; guard++) {
      const flex = list.filter((p) => p.w > PANE_MIN);
      if (!flex.length) break;
      const cap = flex.reduce((s, p) => s + (p.w - PANE_MIN), 0);
      const cut = Math.min(over, cap);
      flex.forEach((p) => { p.w -= Math.round(cut * (p.w - PANE_MIN) / cap); });
      total = list.reduce((s, p) => s + p.w, 0);
      over = total - budget;
    }
  }

  function applyPaneWidths() {
    for (const pane of allPanes()) {
      if (pane.el.hidden) continue;
      pane.el.style.width = pane.w + 'px';
    }
  }

  function pinCurrent() {
    if (!tempPane.node) return;
    if (state.pins.length >= MAX_PINS) {
      toast('最多固定 ' + MAX_PINS + ' 个预览，先取消一个再固定');
      return;
    }
    // 新固定的排在已有固定列的左边：它本来就在临时预览列的位置上，固定后原地不动
    state.pins.unshift(createPane({
      pinned: true,
      node: tempPane.node,
      mode: state.mode,
      w: Math.max(PANE_MIN, tempPane.w || Math.round(bodyWidth() * 0.46))
    }));
    renderPreview();
    toast('已固定：' + tempPane.node.name);
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

    const mode = paneMode(pane);
    const canSource = ['html', 'md', 'svg'].indexOf(node.kind) >= 0;
    const seg = canSource
      ? '<div class="pv-seg"><div class="seg">'
        + '<button data-mode="preview" class="' + (mode === 'preview' ? 'is-on' : '') + '">预览</button>'
        + '<button data-mode="source" class="' + (mode === 'source' ? 'is-on' : '') + '">源码</button>'
        + '</div></div>'
      : '';

    // 图钉 / 刷新 / 关闭放在最右，低频的三个排在左边
    return '<span class="pv-ic">' + nodeIcon(node, 17) + '</span>'
      + '<div class="pv-name"><div class="pv-nm" title="' + esc(node.name) + '">' + esc(node.name) + '</div>'
      + '<div class="pv-sub" title="' + esc(sub.join(' · ')) + '">' + esc(sub.join(' · ')) + '</div></div>'
      + '<div class="pv-actions">' + seg
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
    pane.head.innerHTML = node ? paneHeadHtml(pane, node) : '';

    if (!node) {
      if (force || pane.bodyKey !== 'none') {
        pane.bodyKey = 'none';
        dropPaneView(pane);
        pane.body.className = 'pv-body is-empty';
        pane.body.innerHTML = emptyState();
      }
      return;
    }

    const mode = paneMode(pane);
    const key = [node.path, mode,
      node.kind === 'docx' && !state.previewDocx ? 'docx-off' : '',
      node.kind === 'pptx' && !state.previewPptx ? 'pptx-off' : ''].join('\u0001');
    if (!force && key === pane.bodyKey) return;
    pane.bodyKey = key;
    pane.body.className = 'pv-body';
    dropPaneView(pane);
    renderPaneBody(pane, node, mode, key);
  }

  async function renderPaneBody(pane, node, mode, key) {
    const box = pane.body;
    const stale = () => pane.bodyKey !== key;

    // 交给协议地址直接渲染的类型：HTML 迷你浏览器 / 图片 / PDF 内置阅读器
    if (mode === 'preview' && ['html', 'image', 'svg', 'pdf'].indexOf(node.kind) >= 0) {
      box.innerHTML = loadingState();
      const res = await pv.previewUrl(node.path);
      if (stale()) return;
      if (!res.url) { box.innerHTML = fallbackCard(node, '无法生成预览地址'); return; }
      if (node.kind === 'html') box.innerHTML = browserChrome(node, res.url);
      else if (node.kind === 'pdf') box.innerHTML = pdfFrame(node, res.url);
      else box.innerHTML = '<div class="img-wrap"><img src="' + esc(res.url) + '" alt="' + esc(node.name) + '"></div>';
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

  function renderPreview(force) {
    previewEl.hidden = !state.previewOpen;
    if (!state.previewOpen) return;

    syncTempPane();
    const list = visiblePanes();
    for (const pane of allPanes()) pane.el.hidden = list.indexOf(pane) < 0;
    // appendChild 会把节点移到末尾，按顺序走一遍即可得到目标排列
    for (let i = 0; i < list.length; i++) panesEl.appendChild(list[i].el);

    ensurePaneWidths();
    fitPaneWidths();
    applyPaneWidths();

    for (let i = 0; i < list.length; i++) renderPane(list[i], force);
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

  /* 拖动最左栏的分隔条：只改快速访问面板的高度，另一个面板吃掉剩余空间 */
  let panelDrag = null;
  colsEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest ? e.target.closest('.panel-resize') : null;
    if (!grip) return;
    const colEl = grip.closest('.col');
    const panel = colEl && colEl.querySelector('.fav-panel');
    if (!panel) return;
    e.preventDefault();
    panelDrag = {
      colEl: colEl,
      favTop: state.favTop,
      y: e.clientY,
      h: panel.getBoundingClientRect().height
    };
    grip.classList.add('is-drag');
    try { grip.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    document.body.classList.add('resizing-v');
  });
  colsEl.addEventListener('pointermove', (e) => {
    if (!panelDrag) return;
    const dy = e.clientY - panelDrag.y;
    // 面板在下面时往上拖变高，在上面时往下拖变高
    setFavHeight(panelDrag.colEl, panelDrag.favTop ? panelDrag.h + dy : panelDrag.h - dy);
  });
  colsEl.addEventListener('pointerup', () => {
    if (!panelDrag) return;
    const grip = panelDrag.colEl.querySelector('.panel-resize');
    if (grip) grip.classList.remove('is-drag');
    panelDrag = null;
    document.body.classList.remove('resizing-v');
    pv.setState({ favPanelHeight: state.favH });
  });

  /* 拖动窗格左侧边界：只改这一列的宽度，左右两侧各列都不动 */
  let paneDrag = null;
  panesEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest ? e.target.closest('.pane-resize') : null;
    if (!grip) return;
    const pane = paneOf(grip);
    if (!pane) return;
    e.preventDefault();
    paneDrag = { pane: pane, x: e.clientX, w: pane.w };
    grip.classList.add('is-drag');
    // 合成事件没有真实指针，捕获失败不影响拖动
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.classList.add('resizing');
  });
  panesEl.addEventListener('pointermove', (e) => {
    if (!paneDrag) return;
    const pane = paneDrag.pane;
    const others = visiblePanes().reduce((sum, p) => sum + (p === pane ? 0 : p.w), 0);
    const max = Math.max(PANE_MIN, paneDragMax() - others);
    pane.w = Math.min(max, Math.max(PANE_MIN, paneDrag.w - (e.clientX - paneDrag.x)));
    applyPaneWidths();
  });
  panesEl.addEventListener('pointerup', () => {
    if (!paneDrag) return;
    const pane = paneDrag.pane;
    pane.grip.classList.remove('is-drag');
    paneDrag = null;
    document.body.classList.remove('resizing');
    // 临时预览列的宽度沿用原来的设置项，重启后恢复
    if (!pane.pinned) pv.setState({ previewWidth: pane.w });
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
    if (dir) await pv.openRoot(dir);
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
    if (!state.root) return;

    const sel = state.sel;
    const ci = sel ? sel.col : 0;
    const items = itemsOf(ci);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
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

  /* 窗口尺寸变化：重排虚拟列表窗口，必要时压缩预览列宽度、重夹快速访问面板高度 */
  window.addEventListener('resize', () => {
    for (let ci = 0; ci < state.path.length; ci++) renderColumnWindow(ci);
    fitPaneWidths();
    applyPaneWidths();
    const colEl = colsEl.children[0];
    if (colEl && state.favH > 0) {
      const lim = favHeightLimits(colEl);
      if (state.favH > lim.max) { state.favH = lim.max; applyFavHeight(colEl); }
    }
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
    // 只更新受影响栏的可见行，避免整列重绘
    for (let ci = 0; ci < state.path.length; ci++) {
      if (!state.path[ci] || state.path[ci].path !== dir) continue;
      const colEl = colsEl.children[ci];
      if (!colEl) continue;
      const items = itemsOf(ci);
      colEl.querySelectorAll('.row').forEach((row) => {
        const node = items[+row.dataset.idx];
        if (!node) return;
        const span = row.querySelector('.meta');
        if (span) span.textContent = metaText(node);
      });
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
    state.favH = st.favPanelHeight > 0 ? st.favPanelHeight : 0;
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
