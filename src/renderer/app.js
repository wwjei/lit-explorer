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
  const pvHead = $('#pv-head');
  const pvBody = $('#pv-body');

  const state = {
    root: null,
    rootName: '',
    path: [],        // 每级目录节点，path[0] 是工作区根
    cols: [],        // 每栏的加载状态与原始条目
    sel: null,       // { col, node }
    mode: 'preview',
    query: '',
    theme: 'light',
    previewOpen: true,
    pendingScroll: false,
    hideDot: false,          // 是否隐藏以 . 开头的条目
    favs: [],                // 当前工作区的快速访问项 [{ path, name, isDir, kind }]
    favoritesByRoot: {}      // 持久化的快速访问项（按工作区根目录分组）
  };

  /** 路径 -> { size, mtime }，由主进程异步补发 */
  const meta = new Map();
  let renderedColKeys = [];
  let renderedPreviewKey = '';
  let previewSig = '';
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
    renderedPreviewKey = '';
    render();

    const idx = itemsOf(targetCol).findIndex((n) => n.path === target.path);
    if (idx >= 0) ensureVisible(targetCol, idx);
    if (target.isDir) await loadColumn(targetCol + 1);
  }

  function renderFavorites() {
    const colEl = colsEl.children[0];
    if (!colEl) return;
    const panel = colEl.querySelector('.fav-panel');
    if (!panel) return;
    if (!state.favs.length) {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }
    panel.hidden = false;
    const selPath = state.sel ? state.sel.node.path : '';
    const rows = state.favs.map((f) => {
      return '<div class="row fav-row' + (f.path === selPath ? ' is-sel' : '')
        + '" data-fav-path="' + esc(f.path) + '" title="' + esc(f.path) + '" role="button">'
        + nodeIcon({ name: f.name, isDir: f.isDir, kind: f.kind }, 14)
        + '<span class="nm">' + esc(f.name) + '</span>'
        + '</div>';
    }).join('');
    panel.innerHTML = '<div class="fav-head">' + icon('zapFilled', 'fav-head-ic', 12)
      + '<span>快速访问</span></div>'
      + '<div class="fav-scroll"><div class="fav-list">' + rows + '</div></div>';
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
    // 选中的文件夹摘要依赖下一栏的内容，加载完成后要强制刷新预览头/卡片
    if (state.sel && state.sel.node.isDir && state.sel.col + 1 === ci) renderedPreviewKey = '';
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
    return folder.path + '\u0001' + phase + '\u0001' + state.query + '\u0001' + (state.hideDot ? 'hide' : 'show');
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
    el.className = 'col' + (animate ? ' is-new' : '');
    el.dataset.col = ci;

    const head = document.createElement('div');
    head.className = 'col-head';
    if (ci === 0) {
      // 根目录栏：项目名 + 点文件显隐开关，不再占用空间显示文件数
      head.innerHTML = '<b>' + esc(folder.name) + '</b>'
        + '<button class="col-toggle' + (state.hideDot ? ' is-on' : '') + '" data-toggle-dot title="'
        + (state.hideDot ? '显示以 . 开头的文件/文件夹' : '隐藏以 . 开头的文件/文件夹') + '" aria-label="切换点文件显示">'
        + icon(state.hideDot ? 'eyeOff' : 'eye', '', 14) + '</button>';
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
      // 快速访问面板固定在根目录栏底部，最多占该栏一半高度
      const favPanel = document.createElement('div');
      favPanel.className = 'fav-panel';
      favPanel.hidden = true;
      el.appendChild(favPanel);
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

  function folderCard(node, ci) {
    const col = state.cols[ci];
    const items = col && col.entries ? itemsOf(ci) : [];
    const m = meta.get(node.path);
    const rows = items.slice(0, 300).map((child) =>
      '<button class="frow" data-open="' + esc(child.name) + '">'
      + nodeIcon(child, 15)
      + '<span class="nm">' + esc(child.name) + '</span>'
      + '<span class="meta">' + esc(metaText(child)) + '</span></button>'
    ).join('');
    return '<div class="folder-card">'
      + '<div class="folder-hero">'
      + '<span class="big">' + icon('folder', 'c-folder', 24) + '</span>'
      + '<div><h3>' + esc(node.name) + '</h3><p>'
      + (col && col.entries ? col.entries.length + ' 个项目' : '读取中…')
      + (m ? ' · 修改于 ' + fmtTime(m.mtime) : '') + '</p></div>'
      + '</div>'
      + '<div class="folder-list">' + rows + '</div>'
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

  /** 源码视图用的语言 id：按当前模式取，未知语言返回 null（纯文本） */
  function langForNode(node) {
    if (state.mode === 'source') {
      if (node.kind === 'md') return 'markdown';
      if (node.kind === 'html') return 'html';
      if (node.kind === 'svg') return 'xml';
    }
    return PV.highlight.langFor(node.name);
  }

  async function renderPreview(force) {
    // 注意：局部变量不要叫 pv，会遮蔽 preload 暴露的 window.pv
    const panel = $('#preview');
    $('#gutter').hidden = !state.previewOpen;
    if (!state.previewOpen) {
      panel.hidden = true;
      renderedPreviewKey = '';
      return;
    }
    panel.hidden = false;

    const sel = state.sel;
    const sig = sel
      ? [state.root, state.path.map((f) => f.name).join('/'), sel.node.path, state.mode].join('\u0001')
      : 'none';

    if (!force && sig === renderedPreviewKey) return;
    renderedPreviewKey = sig;
    previewSig = sig;
    const stale = () => previewSig !== sig;

    if (!sel) {
      pvHead.innerHTML = '';
      pvBody.className = 'pv-body is-empty';
      pvBody.innerHTML = emptyState();
      return;
    }

    const node = sel.node;
    const m = meta.get(node.path);
    const sub = [subPath(node) || node.name];
    if (!node.isDir) sub.push(node.kind.toUpperCase());
    if (m) { sub.push(fmtSize(m.size)); sub.push(fmtTime(m.mtime)); }

    const canSource = !node.isDir && ['html', 'md', 'svg'].indexOf(node.kind) >= 0;
    const seg = canSource
      ? '<div class="seg">'
        + '<button data-mode="preview" class="' + (state.mode === 'preview' ? 'is-on' : '') + '">预览</button>'
        + '<button data-mode="source" class="' + (state.mode === 'source' ? 'is-on' : '') + '">源码</button>'
        + '</div>'
      : '';

    pvHead.innerHTML = '<span class="pv-ic">' + nodeIcon(node, 17) + '</span>'
      + '<div class="pv-name"><div class="pv-nm" title="' + esc(node.name) + '">' + esc(node.name) + '</div>'
      + '<div class="pv-sub" title="' + esc(sub.join(' · ')) + '">' + esc(sub.join(' · ')) + '</div></div>'
      + '<div class="pv-actions">' + seg
      + '<button class="iconbtn" data-act="reload" title="重新读取">' + icon('refresh', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="copy" title="复制路径">' + icon('copy', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="reveal" title="在资源管理器中显示">' + icon('reveal', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="external" title="用默认程序打开">' + icon('external', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="close" title="收起预览">' + icon('close', '', 15) + '</button>'
      + '</div>';

    pvBody.className = 'pv-body';

    if (node.isDir) {
      pvBody.innerHTML = folderCard(node, sel.col + 1);
      return;
    }

    if (node.kind === 'html' && state.mode === 'preview') {
      const res = await pv.previewUrl(node.path);
      if (stale()) return;
      pvBody.innerHTML = res.url ? browserChrome(node, res.url) : fallbackCard(node, '无法生成预览地址');
      return;
    }

    if ((node.kind === 'image' || node.kind === 'svg') && state.mode === 'preview') {
      const res = await pv.previewUrl(node.path);
      if (stale()) return;
      pvBody.innerHTML = res.url
        ? '<div class="img-wrap"><img src="' + esc(res.url) + '" alt="' + esc(node.name) + '"></div>'
        : fallbackCard(node, '无法生成预览地址');
      return;
    }

    pvBody.innerHTML = loadingState();
    const res = await pv.read(node.path);
    if (stale()) return;

    if (res.error) {
      pvBody.innerHTML = fallbackCard(node, res.error === 'IS_DIR' ? '这是一个目录' : '读取失败：' + res.error);
      return;
    }
    if (res.binary) {
      pvBody.innerHTML = fallbackCard(node, '该类型暂不支持内嵌预览');
      return;
    }

    const notice = [];
    if (res.truncated) notice.push('文件较大，仅显示前 5 MB');
    if (res.lossy) notice.push('编码无法识别，可能存在乱码');
    const noticeHtml = notice.length ? '<div class="notice">' + notice.join(' · ') + '</div>' : '';

    if (node.kind === 'md' && state.mode === 'preview') {
      pvBody.innerHTML = noticeHtml + '<div class="prose-wrap"><article class="prose">' + mdToHtml(res.text) + '</article></div>';
      PV.highlight.highlightFences(pvBody.querySelector('.prose'));
      return;
    }

    // 其余一律走代码视图：分词在 Worker 里做，主线程只渲染可见窗口
    pvBody.innerHTML = noticeHtml;
    PV.highlight.mount(pvBody, {
      text: res.text,
      size: res.size,
      mtime: res.mtime,
      path: node.path,
      lang: langForNode(node)
    });
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
    renderedPreviewKey = '';
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

  /* 预览头操作 */
  pvHead.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !state.sel) return;
    const node = state.sel.node;
    if (btn.dataset.mode) {
      state.mode = btn.dataset.mode;
      renderPreview(true);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'reload') {
      btn.classList.add('spin');
      setTimeout(() => btn.classList.remove('spin'), 520);
      renderPreview(true);
    } else if (act === 'copy') {
      pv.copyText(node.path).then(() => toast('已复制路径：' + node.path));
    } else if (act === 'reveal') {
      pv.reveal(node.path);
    } else if (act === 'external') {
      openWithSystem(node);
    } else if (act === 'close') {
      togglePreview(false);
    }
  });

  /* 预览体操作 */
  pvBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn && state.sel) {
      if (btn.dataset.act === 'reload') {
        btn.classList.add('spin');
        setTimeout(() => btn.classList.remove('spin'), 520);
        renderPreview(true);
      } else if (btn.dataset.act === 'external') {
        openWithSystem(state.sel.node);
      }
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open && state.sel && state.sel.node.isDir) {
      const child = itemsOf(state.sel.col + 1).filter((c) => c.name === open.dataset.open)[0];
      if (child) selectNode(child, state.sel.col + 1);
    }
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

  /* 分隔条拖拽 */
  const gutter = $('#gutter');
  let dragging = false;
  gutter.addEventListener('pointerdown', (e) => {
    dragging = true;
    gutter.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  gutter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = $('#app-body').getBoundingClientRect();
    const w = rect.right - e.clientX;
    const max = Math.max(320, rect.width - 380);
    $('#preview').style.width = Math.min(Math.max(w, 320), max) + 'px';
  });
  gutter.addEventListener('pointerup', (e) => {
    dragging = false;
    gutter.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
    pv.setState({ previewWidth: Math.round($('#preview').getBoundingClientRect().width) });
  });

  /* 窗口尺寸变化：重排虚拟列表窗口 */
  window.addEventListener('resize', () => {
    for (let ci = 0; ci < state.path.length; ci++) renderColumnWindow(ci);
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
    if (state.sel && !state.sel.node.isDir && state.sel.node.path.startsWith(dir)) {
      // 选中项的元信息到齐后刷新预览头
      renderedPreviewKey = '';
      renderPreview();
    }
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

  /* ============================ 启动 ============================ */
  (async function init() {
    const st = await pv.getState();
    document.documentElement.dataset.theme = st.theme === 'dark' ? 'dark' : 'light';
    state.theme = st.theme === 'dark' ? 'dark' : 'light';
    $('#theme-ic').innerHTML = state.theme === 'light' ? PV.icons.ICONS.moon : PV.icons.ICONS.sun;
    state.previewOpen = st.previewOpen !== false;
    $('#btn-preview').classList.toggle('is-on', !state.previewOpen);
    state.hideDot = !!st.hideDot;
    state.favoritesByRoot = st.favorites && typeof st.favorites === 'object' ? st.favorites : {};
    // 主进程有可能在读取设置期间就已经把工作区打开了，这时补上该工作区的快速访问项
    if (state.root) {
      state.favs = normalizeFavorites(state.favoritesByRoot[favKey(state.root)]);
      render();
    }
    if (st.previewWidth > 0) $('#preview').style.width = st.previewWidth + 'px';
    applyMaximized(await pv.isMaximized());
    // 主进程可能在读设置的同时已经把工作区打开了，这里不能反过来盖住它
    if (!st.lastRoot && !state.root) {
      setWelcome(true);
      render();
    }
  })();
})();
