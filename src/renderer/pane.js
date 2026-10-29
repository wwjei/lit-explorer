/* 预览窗格：生命周期与布局
 *
 * 预览区由若干「列」组成，每列可以放一到两个窗格（上下分屏，只支持一级）：
 *   - 临时预览列：只跟随「选中文件」更新。选中文件夹不动它（文件夹没有预览）
 *   - 固定列：由图钉固定下来，最多 MAX_PINS 列，新固定的排在旧固定的左边
 * 一列里有两个窗格时，上下各占一半，中间的分隔条可以再调比例。
 * 选中项已经出现在某个固定窗格里时，临时预览不再重复展示同一份内容。
 * 每个窗格头部左边的小抓手可以拖动：换列的位置，或拖到某一列的下 1/3 分屏。
 * 拖动临时预览列的抓手到右侧，等于把它固定成一列。
 *
 * 这个文件管的是「窗格作为一个单元」的全部事情：
 *   - 身份：内容身份 bodyKey（该显示什么）与任务身份 reqId（这是不是我那一次）
 *   - 渲染任务：晚到的旧响应写不进正文（见 beginTask）
 *   - 创建 / 销毁 / 视图卸载
 *   - 迁移：固定或分屏时把正文整块搬到新窗格
 *   - 宽度与排列：每列独立宽度、按可用空间压缩、拖动改宽、抓手换位置 / 分屏
 *
 * 正文与头部「画成什么样」不在这里：app.js 把 preview-body.js 的三个口子装进来
 * （PV.pane.init 的 renderHead / renderBody / bodyKey）。查找条长在窗格上，所以本文件
 * 会通知 PV.find（closeIfOn / revalidate / afterRender / carryFrom）——都是在函数体里
 * 引用，与加载顺序无关。
 *
 * 加载顺序：shared/contracts.js → paths.js → icons.js → highlight.js → markdown.js →
 *           pane.js → preview-body.js → webview.js → svgedit.js →
 *           find.js → projects.js → app.js。
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const panesEl = $('#panes');
  const previewEl = $('#preview');

  /** 最多固定几列预览（每列最多两个窗格，所以固定窗格最多 MAX_PINS * 2 个） */
  const MAX_PINS = PV.contracts.MAX_PINS;
  const MAX_PANES_PER_COL = PV.contracts.MAX_PANES_PER_COL;
  const PANE_MIN = 240;        // 单列的最小宽度（分屏的两个窗格共享这一列宽）
  const MAIN_HARD_MIN = 260;   // 栏区的绝对下限（约一栏宽），手动拖动也不越过
  const SPLIT_MIN = 0.2;       // 上下分屏时上面那一格的最小占比
  const SPLIT_MAX = 0.8;
  /** 允许从设置里恢复的预览类型；web 单独处理，不能靠 path 当文件读 */
  const PANE_KINDS = new Set(PV.contracts.PINNED_KINDS);

  /**
   * app.js 注入的接口：本文件只管「什么时候」，画成什么样由它们决定。
   *   mode()                  临时预览列当前用的模式（固定列各记一份，见 modeOf）
   *   selection()             当前选中的 { col, node } 或 null
   *   renderHead(pane, node)  头部 HTML
   *   renderBody(...)         正文渲染，返回 Promise（见 renderPane 的调用处）
   *   bodyKey(pane,node,mode) 内容身份
   *   capabilities(node,mode) 这个节点能做什么（图片 / 连续预览 / SVG 编辑 / 源码）
   *   afterLayout()           布局变了：网页视图的矩形要跟着重算（webview.js）
   */
  const hooks = {
    toast: function () {},
    mode: function () { return 'preview'; },
    selection: function () { return null; },
    renderHead: function () { return ''; },
    renderBody: function () { return null; },
    bodyKey: function () { return ''; },
    capabilities: function () {
      return { image: false, continuous: false, svgEdit: false, source: false };
    },
    afterLayout: function () {},
    /** 用户改了固定列 / 宽度 / 分屏比例：app.js 用它把布局记进当前项目 */
    layoutChanged: function () {},
    /** 从设置恢复固定列时，只接受当前工作区内的文件路径 */
    allowPinnedPath: function () { return true; }
  };

  /** 临时预览列是否显示（固定列不受它影响） */
  let previewOpen = true;
  /** 最近操作过的窗格：↑↓ 滚谁、Ctrl+F 落在谁身上 */
  let activePaneId = 0;

  let paneSeq = 0;
  const panes = new Map();
  let columnSeq = 0;
  const columns = new Map();
  /** 固定住的预览列（最多 MAX_PINS 个），[0] 在最左；新固定的插到最左，可拖动换位置 */
  let pins = [];

  function createPane(opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.className = 'pane' + (o.pinned ? ' is-pinned' : '');
    const head = document.createElement('div');
    head.className = 'pv-head';
    const body = document.createElement('div');
    body.className = 'pv-body is-empty';
    el.appendChild(head);
    el.appendChild(body);
    const pane = {
      id: ++paneSeq,
      pinned: !!o.pinned,
      el: el,
      head: head,
      body: body,
      col: null,          // 所在的列（见 createColumn）
      node: o.node || null,
      mode: o.mode || 'preview',
      bodyKey: '',        // 内容身份：决定「该显示什么」
      reqId: 0,           // 任务身份：每次真正重渲染都换一个，用来丢弃晚到的旧响应
      pending: 0,         // 还在读/还在解析的渲染任务数，>0 说明正文是加载态空壳
      view: null,
      findEl: null,
      svgEdit: false,     // SVG 编辑模式：正文交给 svgedit.js
      svgEditPath: '',    // 编辑模式跟着哪个文件（换文件就退出）
      zoom: o.zoom || 0,  // 图片缩放：0 = 适应窗口，其余是倍数
      continuous: !!o.continuous, // 连续预览：同目录图片竖着排下来
      images: [],         // 当前窗格里的 <img>，改缩放时直接落到它们身上
      changed: false,     // 磁盘上的版本和当前显示的不一样（刷新按钮高亮）
      known: null         // 当前显示版本 { path, size, mtime }，由变更监测维护
    };
    el.dataset.pane = String(pane.id);
    panes.set(pane.id, pane);
    return pane;
  }

  /**
   * 一列预览：宽度属于列，列里可以放 1 个或 2 个窗格（上下）。
   * DOM 结构：.pane-col > [宽度抓手, .pane-stack > 窗格 / 分隔条 / 窗格, 分屏落点提示]
   */
  function createColumn(opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.className = 'pane-col';
    const grip = document.createElement('div');
    grip.className = 'pane-resize';
    grip.title = '拖动调整此列宽度';
    const stack = document.createElement('div');
    stack.className = 'pane-stack';
    const splitEl = document.createElement('div');
    splitEl.className = 'pane-split';
    splitEl.title = '拖动调整上下比例';
    splitEl.hidden = true;
    stack.appendChild(splitEl);
    const hint = document.createElement('div');
    hint.className = 'split-hint';
    el.appendChild(grip);
    el.appendChild(stack);
    el.appendChild(hint);
    const col = {
      id: ++columnSeq,
      el: el,
      grip: grip,
      stack: stack,
      splitEl: splitEl,
      hint: hint,
      panes: [],
      w: Math.max(0, o.w || 0),
      split: 0.5,
      temp: !!o.temp
    };
    el.dataset.col = String(col.id);
    columns.set(col.id, col);
    if (o.pane) addPaneToColumn(col, o.pane);
    return col;
  }

  /** 临时预览列：始终在最左，内容跟随选中的文件；临时列只有一格，不参与上下分屏 */
  const tempPane = createPane({});
  const tempCol = createColumn({ pane: tempPane, temp: true });

  function columnOfEl(el) {
    const host = el && el.closest ? el.closest('.pane-col') : null;
    return host ? columns.get(Number(host.dataset.col)) || null : null;
  }

  /* ---- 列内窗格的增删与上下布局 ---- */

  function addPaneToColumn(col, pane) {
    if (!col || !pane || col.panes.length >= MAX_PANES_PER_COL) return false;
    col.panes.push(pane);
    pane.col = col;
    pane.el.hidden = false;
    if (pane.el.parentNode !== col.stack) col.stack.appendChild(pane.el);
    layoutColumn(col);
    return true;
  }

  /**
   * 把一列里的窗格按 col.panes 的顺序摆好。单格时隐藏分隔条；
   * 两格时用 flex-grow 分配上下比例（col.split 是上面那一格的占比）。
   * 不重新 append 已经在该列里的窗格：重新插回文档会清掉它内部的滚动位置。
   */
  function layoutColumn(col) {
    if (!col) return;
    const stack = col.stack;
    const top = col.panes[0];
    const bottom = col.panes[1];
    if (!top) {
      col.splitEl.hidden = true;
      col.el.classList.remove('is-split');
      return;
    }
    if (top.el.parentNode !== stack) stack.appendChild(top.el);
    if (bottom) {
      if (bottom.el.parentNode !== stack) stack.appendChild(bottom.el);
      if (col.splitEl.parentNode !== stack) stack.appendChild(col.splitEl);
      // 顺序固定为 [上窗格, 分隔条, 下窗格]
      if (top.el.nextSibling !== col.splitEl) stack.insertBefore(col.splitEl, top.el.nextSibling);
      if (col.splitEl.nextSibling !== bottom.el) stack.insertBefore(bottom.el, col.splitEl.nextSibling);
      col.splitEl.hidden = false;
      top.el.style.flexGrow = String(col.split);
      bottom.el.style.flexGrow = String(1 - col.split);
    } else {
      col.splitEl.hidden = true;
      top.el.style.flexGrow = '1';
    }
    col.el.classList.toggle('is-split', !!bottom);
  }

  /** 把窗格从它所在的列摘下来；列空了也不删列，调用方决定是丢列还是保留 */
  function removePaneFromColumn(col, pane) {
    if (!col || !pane) return false;
    const at = col.panes.indexOf(pane);
    if (at < 0) return false;
    col.panes.splice(at, 1);
    pane.col = null;
    if (pane.el.parentNode) pane.el.remove();
    if (col.panes.length) layoutColumn(col);
    else {
      col.splitEl.hidden = true;
      col.el.classList.remove('is-split');
    }
    return true;
  }

  /** 固定列空了：从 pins 和 DOM 里一起移除（临时列不走这里） */
  function dropEmptyColumn(col) {
    if (!col || col.temp || col.panes.length) return;
    const at = pins.indexOf(col);
    if (at >= 0) pins.splice(at, 1);
    columns.delete(col.id);
    if (col.el.parentNode) col.el.remove();
  }

  function destroyPane(pane) {
    // 查找条长在这个窗格里，窗格没了查找状态也就没意义了
    PV.find.closeIfOn(pane);
    dropPaneView(pane);
    panes.delete(pane.id);
    if (pane.el.parentNode) pane.el.remove();
    pane.col = null;
  }

  function destroyColumn(col) {
    if (!col) return;
    for (const pane of col.panes.slice()) destroyPane(pane);
    col.panes.length = 0;
    columns.delete(col.id);
    if (col.el.parentNode) col.el.remove();
  }

  /** 代码视图自带 ResizeObserver，换内容前必须销毁，否则越挂越多 */
  function dropPaneView(pane) {
    if (pane.view && pane.view.destroy) pane.view.destroy();
    pane.view = null;
  }

  /** 换工作区：固定列装的是上一个工作区的文件，一律清掉 */
  function clearPins() {
    for (const col of pins.slice()) destroyColumn(col);
    pins = [];
    mainFloor = 0;
  }

  /** 换工作区：临时预览列清空（正文与内容身份一起复位） */
  function resetTemp() {
    tempPane.node = null;
    // 让还在读 / 解析的旧任务回来后写不进已清空的临时列
    if (tempPane.pending > 0) tempPane.reqId++;
    tempPane.svgEdit = false;
    tempPane.svgEditPath = '';
    clearPaneBody(tempPane);
  }

  /** 清掉窗格的正文与内容身份；调用方负责先作废还在跑的渲染任务 */
  function clearPaneBody(pane) {
    dropPaneView(pane);
    pane.bodyKey = '';
    pane.images = [];
    pane.body.className = 'pv-body is-empty';
    pane.body.innerHTML = '';
  }

  /**
   * 临时列被收起时只隐藏。
   * clear=true 用于「内容已经在固定窗格里 / 没有内容了」：此时正文不会再回来，清掉它，
   * 免得隐藏的 DOM 里留着代码视图的 ResizeObserver、SVG 编辑器的事件，下次显示时
   * 又按旧 bodyKey 跳过渲染，正文成了空壳。
   * clear=false 用于用户只是关掉预览面板：正文和编辑器原样留着，展开时接着看。
   */
  function hideTempPane(clear) {
    tempPane.el.hidden = true;
    if (!clear) return;
    // 让挂起的旧渲染回来后写不进隐藏的临时列（否则会留下隐藏的编辑器 / ResizeObserver）
    if (tempPane.pending > 0) tempPane.reqId++;
    if (tempPane.bodyKey !== '' || tempPane.view || tempPane.body.firstChild) {
      clearPaneBody(tempPane);
    }
  }

  function paneOf(el) {
    const host = el && el.closest ? el.closest('.pane') : null;
    if (!host) return null;
    return panes.get(Number(host.dataset.pane)) || null;
  }

  function modeOf(pane) {
    return pane.pinned ? pane.mode : hooks.mode();
  }

  function allColumns() {
    return [tempCol].concat(pins);
  }

  /** 所有窗格（临时列永远排第一，app.js 依赖 allPanes()[0] 拿临时列） */
  function allPanes() {
    const list = [tempPane];
    for (const col of pins) for (const pane of col.panes) list.push(pane);
    return list;
  }

  /** 临时预览列是否多余：用户关掉了它，或者内容已经在固定窗格里 */
  function tempPaneHidden() {
    if (!previewOpen) return true;
    if (!pins.length) return false;
    if (!tempPane.node) return true;
    return isPinnedPath(tempPane.node.path);
  }

  function isPinnedPath(path) {
    for (const col of pins) {
      for (const pane of col.panes) {
        if (pane.node && PV.paths.same(pane.node.path, path)) return true;
      }
    }
    return false;
  }

  function visibleColumns() {
    const list = [];
    if (!tempPaneHidden()) list.push(tempCol);
    for (const col of pins) list.push(col);
    return list;
  }

  /** 实际显示出来的窗格：临时预览（若不多余）在最左，固定列按视觉顺序从右往左排 */
  function visiblePanes() {
    const list = [];
    for (const col of visibleColumns()) {
      for (const pane of col.panes) list.push(pane);
    }
    return list;
  }

  /**
   * 临时预览列只在这两种情况下更新：
   * 1. 选中了一个文件，且这个文件没有出现在任何固定窗格里
   * 2. 都不满足时保持原样——选中文件夹、或选中「已经固定住的文件」都不动它
   *    （比如固定了 A、临时列在看 B，再点回 A 时 B 要留着）
   */
  function syncTempPane() {
    const sel = hooks.selection();
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
  function syncColumnOrder(list) {
    for (let i = 0; i < list.length; i++) {
      const col = list[i];
      if (col.el.parentNode !== panesEl) panesEl.appendChild(col.el);
      col.el.style.order = String(i);
    }
  }

  /* ---- 列宽度：每列独立，拖动左边界只改这一列 ---- */
  /** 本次渲染各列实际用的宽度（col.w 是用户设定，这里是被压缩后的结果） */
  let columnWidths = new Map();
  /** 手动把最左那一列拖宽过之后留下的栏区宽度（0 = 按默认预留） */
  let mainFloor = 0;

  function bodyWidth() {
    return $('#app-body').clientWidth || window.innerWidth;
  }

  /** 栏区的舒适宽度：新增预览列、窗口变窄时按这个值给它留位 */
  function mainComfortWidth() {
    return Math.max(320, Math.round(bodyWidth() * 0.32));
  }

  function defaultColumnWidth() {
    return Math.max(PANE_MIN, Math.round(bodyWidth() * 0.46));
  }

  /**
   * 预览列可用的总宽度：固定列多了以后栏区让步到一栏宽，好让临时预览列保住自己的宽度。
   * mainFloor 是「手动把最左那一列拖宽过」之后留下的栏区宽度：这时栏区按这个下限让位，
   * 拖出来的宽度不会被右邻列抢回去。
   */
  function paneBudget() {
    const n = visibleColumns().length;
    const auto = n >= 3 ? MAIN_HARD_MIN : mainComfortWidth();
    const reserve = mainFloor ? Math.max(MAIN_HARD_MIN, Math.min(auto, mainFloor)) : auto;
    return Math.max(PANE_MIN * n, bodyWidth() - reserve);
  }

  /** 手动拖动时的上限：可以把栏区压到一栏宽，但不允许更窄 */
  function paneDragMax() {
    return Math.max(PANE_MIN, bodyWidth() - MAIN_HARD_MIN);
  }

  function ensureColumnWidths() {
    if (!tempCol.w) tempCol.w = defaultColumnWidth();
    for (const col of pins) {
      if (!col.w) col.w = defaultColumnWidth();
    }
  }

  /**
   * 空间不够时按比例压缩，但**只压渲染宽度、不改用户设定的宽度**——
   * col.w 是「我希望它多宽」，关掉几个预览列后要能原样回来。
   * 压缩顺序也有讲究：先让固定列让位（它们是参考用的，240px 也看得清），
   * 临时预览列是正在读的那一列，尽量保住用户拖出来的宽度。
   */
  function squeezeInto(list, eff, amount) {
    const flex = list.filter((col) => eff.get(col) > PANE_MIN);
    if (!flex.length) return;
    const cap = flex.reduce((s, col) => s + (eff.get(col) - PANE_MIN), 0);
    const cut = Math.min(amount, cap);
    flex.forEach((col) => {
      eff.set(col, eff.get(col) - Math.round(cut * (eff.get(col) - PANE_MIN) / cap));
    });
  }

  function fitColumnWidths() {
    ensureColumnWidths();
    const list = visibleColumns();
    const budget = paneBudget();
    const eff = new Map();
    for (const col of list) eff.set(col, col.w);
    const total = () => list.reduce((s, col) => s + eff.get(col), 0);
    let over = total() - budget;
    if (over > 0) {
      const pinList = list.filter((col) => col !== tempCol);
      for (let guard = 0; guard < 8 && over > 0; guard++) {
        squeezeInto(pinList, eff, over);
        over = total() - budget;
      }
      for (let guard = 0; guard < 8 && over > 0; guard++) {
        squeezeInto(list, eff, over);
        over = total() - budget;
      }
    }
    columnWidths = eff;
  }

  /** 某一列当前实际渲染的宽度 */
  function effWidth(col) {
    const w = columnWidths.get(col);
    return w === undefined ? col.w : w;
  }

  function applyColumnWidths() {
    fitColumnWidths();
    for (const col of allColumns()) {
      if (col.el.hidden) continue;
      col.el.style.width = Math.round(effWidth(col)) + 'px';
    }
  }

  /**
   * 手动拖动之前，把「现在看到的宽度」记成各列的设定宽度。
   * 这样拖动时各列加起来正好等于当前总宽，分界线就是 1:1 跟着指针走，
   * 不会再出现「拖了没反应」——因为可用宽度早已被别的列的设定值占满。
   * 代价是这些列不再回弹到更早的设定值：手拖过的布局就是新的设定。
   */
  function freezeColumnWidths() {
    fitColumnWidths();
    for (const col of visibleColumns()) {
      col.w = Math.max(PANE_MIN, Math.floor(effWidth(col)));
    }
  }

  /* ============================ 渲染任务 ============================ */

  /**
   * 起一个正文渲染任务。任务记在窗格上：
   *   reqId   任务身份：新任务一开始就作废之前所有任务
   *   pending 还没回来的任务数：>0 说明正文是加载态空壳（固定、迁移要看它）
   *
   * 正文只能通过任务对象写进去（write / replace）：晚到的旧任务写不动，
   * 所以各渲染分支不需要各自记着「先比一下 key 或编号再写 DOM」。
   */
  function beginTask(pane, key) {
    const req = ++pane.reqId;
    pane.pending++;
    let settled = false;
    const task = {
      pane: pane,
      key: key,
      /** 已经被更新的一次渲染取代 */
      get stale() { return pane.reqId !== req; },
      /** 把正文换成一段 HTML；不是当前任务就什么都不做 */
      write: function (html) {
        if (task.stale) return false;
        pane.body.innerHTML = html;
        return true;
      },
      /** 把正文换成一个现成的节点（图片列这类自己拼 DOM 的） */
      replace: function (el) {
        if (task.stale) return false;
        pane.body.innerHTML = '';
        pane.body.appendChild(el);
        return true;
      },
      settle: function () {
        if (settled) return;
        settled = true;
        pane.pending--;
      }
    };
    return task;
  }

  /** 跑一次正文渲染任务；正文落地后由查找模块决定要不要重落高亮 */
  function runTask(pane, key, mode, node) {
    const task = beginTask(pane, key);
    const done = Promise.resolve(hooks.renderBody(pane, node, mode, key, task)).finally(task.settle);
    pane.ready = done;
    PV.find.afterRender(pane, task, done);
  }

  /** 窗格头部左边的小抓手：只有这一小块可以拖动换位置 / 分屏 */
  function addDragGrip(pane) {
    if (!pane.head || pane.head.querySelector('.pv-grip')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pv-grip';
    btn.title = '拖动换位置；拖到某一列的下 1/3 分屏';
    btn.setAttribute('aria-label', '拖动此窗格');
    btn.innerHTML = PV.icons.icon('grip', '', 14);
    pane.head.insertBefore(btn, pane.head.firstChild);
  }

  /** 渲染一个窗格：头部每次重建（元信息会异步补发），正文按内容 key 增量渲染 */
  function renderPane(pane, force) {
    const node = pane.node;
    // 换文件时旧文件的「有变化」不能带到新文件头上
    if (pane.known && (!node || pane.known.path !== node.path)) {
      pane.changed = false;
      pane.known = null;
    }
    // SVG 编辑 / 连续预览只对特定类型有意义：类型知识统一问 PV.body，
    // 布局模块不再认 node.kind
    const mode = modeOf(pane);
    const caps = node ? hooks.capabilities(node, mode) : null;
    // SVG 编辑只属于「当初进入编辑的那个文件 + 预览模式」；换文件或切源码就退出
    if (pane.svgEdit && (!node || !caps.svgEdit || node.path !== pane.svgEditPath)) {
      pane.svgEdit = false;
      pane.svgEditPath = '';
    }
    // 连续预览只对「图片 + 预览模式」有意义，切到别的文件/源码视图时自动退出
    if (pane.continuous && !(caps && caps.continuous)) {
      pane.continuous = false;
    }
    pane.head.innerHTML = node ? hooks.renderHead(pane, node) : '';
    if (node) addDragGrip(pane);

    if (!node) {
      // 没有内容可查
      PV.find.closeIfOn(pane);
      if (!force && pane.bodyKey === 'none') return;
      pane.bodyKey = 'none';
      dropPaneView(pane);
      pane.images = [];
      pane.body.className = 'pv-body is-empty';
      runTask(pane, 'none', 'preview', null);
      return;
    }

    const key = hooks.bodyKey(pane, node, mode);
    if (!force && key === pane.bodyKey) return;
    pane.bodyKey = key;
    pane.body.className = 'pv-body';
    dropPaneView(pane);
    runTask(pane, key, mode, node);
  }

  function renderPreview(force) {
    syncTempPane();
    // 关掉临时预览列不影响固定列：整块预览区只在「一列都没有」时才收起
    const cols = visibleColumns();
    previewEl.hidden = cols.length === 0;
    if (!cols.length) {
      for (const col of allColumns()) col.el.hidden = true;
      hideTempPane(false);   // 只是整块预览收起来了，正文留着
      hooks.afterLayout();
      return;
    }

    const shown = new Set(cols);
    for (const col of allColumns()) col.el.hidden = !shown.has(col);
    if (shown.has(tempCol)) tempPane.el.hidden = false;
    // 预览开着、临时列却不在：内容已经固定到别处（或没有内容），清掉旧正文；
    // 只是用户关掉预览面板时保留正文，展开后接着看
    else hideTempPane(previewOpen);
    syncColumnOrder(cols);

    applyColumnWidths();   // 里面会按可用宽度重算每列的实际宽度

    for (const col of cols) {
      for (const pane of col.panes) {
        pane.el.hidden = false;
        renderPane(pane, force);
      }
    }
    // 临时预览列被收起来（内容已经在固定列里）时，挂在它上面的查找条一并收掉
    PV.find.revalidate();
    // 头部高度、列宽、显隐都定了，网页视图的矩形现在才准
    hooks.afterLayout();
  }

  /* ============================ 固定与迁移 ============================ */

  /**
   * 把临时预览的内容做成一格固定窗格。正文整块搬过去（不走重渲染），
   * 滚动位置、已经解码好的图片、连续预览的列表都原样跟着走。
   * 编辑模式不搬家：编辑器的 DOM 与事件属于临时列，固定列按磁盘内容重新渲染；
   * 改动本来就是自动保存的。临时列如果因此被收起，它的编辑器在这里一并卸载。
   */
  function makePinPaneFromTemp() {
    if (!tempPane.node) return null;
    const wasEditing = tempPane.svgEdit;
    const pane = createPane({
      pinned: true,
      node: tempPane.node,
      mode: modeOf(tempPane),
      zoom: tempPane.zoom,
      continuous: tempPane.continuous
    });
    if (wasEditing) {
      tempPane.svgEdit = false;
      tempPane.svgEditPath = '';
      clearPaneBody(tempPane);
    }
    // 正在看的那一屏整块搬过去；还在读的时候返回 null，让新窗格自己重渲染
    const keep = wasEditing ? null : adoptPaneBody(pane, tempPane);
    // 查找条长在窗格上：内容被固定到新列时，查询词与高亮一并跟过去
    const carried = wasEditing ? false : PV.find.carryFrom(tempPane, pane);
    return { pane: pane, keep: keep, carried: carried };
  }

  function pinCurrent() {
    if (!tempPane.node) return;
    if (pins.length >= MAX_PINS) {
      hooks.toast('最多固定 ' + MAX_PINS + ' 个预览列，先取消一个再固定（或拖到某一列的下 1/3 分屏）');
      return;
    }
    const made = makePinPaneFromTemp();
    if (!made) return;
    // 新固定的排在已有固定列的左边：它本来就在临时预览列的位置上，固定后原地不动
    const col = createColumn({
      pane: made.pane,
      w: Math.max(PANE_MIN, tempCol.w || defaultColumnWidth())
    });
    pins.unshift(col);
    renderPreview();
    // 位置要等这一列挂进文档、有了布局之后才落得下去（搬家的元素在文档外读不到高度）
    if (made.keep) restorePaneTop(made.pane, made.keep);
    // 正文是搬过来的，没有走重渲染那条路，高亮在这里补落一次
    if (made.carried) PV.find.refresh();
    hooks.toast('已固定：' + made.pane.node.name);
    noteLayout();
  }

  function adoptPaneBody(to, from) {
    // 还在读/还在解析时不能搬：搬过去只是个「读取中…」的空壳，而这次读取属于
    // 原来那一列、回来时会被丢弃，固定列就永远停在加载态。这种情况让新列自己重渲染。
    if (from.pending > 0) return null;
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

  function unpinPane(pane) {
    const col = pane.col;
    if (!col || col === tempCol) return;
    removePaneFromColumn(col, pane);
    destroyPane(pane);
    if (!col.panes.length) dropEmptyColumn(col);
    else layoutColumn(col);
    renderPreview();
    hooks.toast('已取消固定：' + ((pane.node && pane.node.name) || ''));
    noteLayout();
  }

  /* ============================ 项目布局快照 ============================ */

  /** 固定列的数据形态：顺序、宽度、上下比例、每格的内容与模式 */
  function savedPaneData(pane) {
    const node = pane.node;
    // 云文档链接可能临时签名；持久化挂载身份，不把解析出的 URL 写进布局。
    if (!node || node.cloudMountId || typeof node.path !== 'string' || !node.path) return null;
    const item = {
      path: node.path,
      kind: node.kind || 'txt',
      mode: modeOf(pane),
      zoom: pane.zoom || 0,
      continuous: !!pane.continuous
    };
    // 文件名从路径现取，改名后不会留下旧标题；网页的名字是用户起的，得存
    if (node.kind === 'web') {
      item.name = node.name || '';
      item.url = node.url || node.path;
    }
    return item;
  }

  function layoutSnapshot() {
    return {
      mainFloor: Math.round(mainFloor || 0),
      pins: pins.map((col) => ({
        w: Math.round(col.w || 0),
        split: col.split,
        panes: col.panes.map(savedPaneData).filter(Boolean)
      })).filter((col) => col.panes.length)
    };
  }

  /** 用户改了固定列 / 宽度 / 分屏比例：交给 app.js 记进当前项目 */
  function noteLayout() {
    hooks.layoutChanged();
  }

  function clampSavedWidth(w) {
    return Math.min(10000, Math.max(PANE_MIN, Math.round(w)));
  }

  function nodeFromSaved(saved) {
    if (!saved || typeof saved !== 'object') return null;
    if (saved.kind === 'web') {
      const url = typeof saved.url === 'string' ? saved.url : '';
      if (!/^https?:\/\//i.test(url)) return null;
      return { name: saved.name || url, kind: 'web', url: url, path: url, isDir: false };
    }
    const filePath = typeof saved.path === 'string' ? saved.path : '';
    if (!filePath || !hooks.allowPinnedPath(filePath)) return null;
    const name = saved.name || PV.paths.baseName(filePath) || filePath;
    const kind = PANE_KINDS.has(saved.kind) ? saved.kind : 'txt';
    return { path: filePath, name: name, isDir: false, kind: kind };
  }

  /** 恢复一个项目的固定列；调用前固定列已清空，这里按保存顺序重建 */
  function restoreLayout(layout) {
    if (!layout || typeof layout !== 'object') return;
    if (Number.isFinite(layout.mainFloor)) {
      mainFloor = Math.min(10000, Math.max(0, Math.round(layout.mainFloor)));
    }
    const savedCols = Array.isArray(layout.pins) ? layout.pins.slice(0, MAX_PINS) : [];
    for (const data of savedCols) {
      if (!data || typeof data !== 'object') continue;
      const made = [];
      const savedPanes = Array.isArray(data.panes) ? data.panes.slice(0, MAX_PANES_PER_COL) : [];
      for (const saved of savedPanes) {
        const node = nodeFromSaved(saved);
        if (!node) continue;
        made.push(createPane({
          pinned: true,
          node: node,
          mode: saved.mode === 'source' ? 'source' : 'preview',
          zoom: Number.isFinite(saved.zoom) ? saved.zoom : 0,
          continuous: !!saved.continuous
        }));
      }
      if (!made.length) continue;
      const col = createColumn({
        pane: made[0],
        w: Number.isFinite(data.w) ? clampSavedWidth(data.w) : defaultColumnWidth()
      });
      if (made[1]) addPaneToColumn(col, made[1]);
      if (Number.isFinite(data.split)) {
        col.split = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, data.split));
        layoutColumn(col);
      }
      pins.push(col);
    }
    // pins 按保存顺序 push，[0] 就是最左；渲染一次把正文与宽度落下去
    if (pins.length) renderPreview();
  }

  /* ============================ 滚动位置 ============================ */

  const PANE_SCROLLERS = ['.prose-wrap', '.cv-scroll', '.imgseq', '.img-wrap', '.docview', '.pdfview'];

  /** 窗格里的滚动容器；mustScroll=true 时只算当前真能滚的那个 */
  function paneScrollHost(pane, mustScroll) {
    for (const sel of PANE_SCROLLERS) {
      const el = pane.body.querySelector(sel);
      if (!el) continue;
      if (!mustScroll || el.scrollHeight > el.clientHeight + 2) return el;
    }
    return null;
  }

  /** 返回是否真的滚了：焦点在预览里但这一列没得滚时，按键就到此为止 */
  function scrollPaneBy(pane, dir) {
    const el = paneScrollHost(pane, true);
    if (!el) return false;
    const step = Math.max(72, Math.round(el.clientHeight * 0.15));
    el.scrollTop += dir * step;
    return true;
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

  /**
   * 拖动期间先把内嵌网页视图藏起来：WebContentsView 是原生视图，鼠标移到它上面
   * 事件会被它吃掉，拖动的 move / up 就断了，分屏落点也被它盖住。只藏不销毁，
   * 松手后 afterLayout 会把视图按新矩形放回来。
   */
  function setWebDrag(on) {
    if (PV.web && PV.web.setDragHidden) PV.web.setDragHidden(!!on);
  }

  /* ============================ 拖动改宽 ============================ */
  /** 手动拖动列左侧边界：分界线跟着指针走，左邻那一列让出 / 收回同样的宽度 */
  let colDrag = null;

  function endColDrag() {
    if (!colDrag) return;
    const drag = colDrag;
    colDrag = null;
    drag.col.grip.classList.remove('is-drag');
    document.body.classList.remove('resizing');
    if (drag.webHidden) setWebDrag(false);
    noteLayout();
  }

  panesEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest ? e.target.closest('.pane-resize') : null;
    if (!grip) return;
    const col = columnOfEl(grip);
    if (!col) return;
    e.preventDefault();
    colDrag = {
      col: col,
      x: e.clientX,
      pointerId: e.pointerId,
      w: effWidth(col),
      tempW: tempCol.w,
      frozen: false,
      webHidden: false
    };
    grip.classList.add('is-drag');
    // 合成事件没有真实指针，捕获失败不影响拖动
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.classList.add('resizing');
  });
  panesEl.addEventListener('pointermove', (e) => {
    if (!colDrag || e.pointerId !== colDrag.pointerId) return;
    if (!colDrag.webHidden) {
      colDrag.webHidden = true;
      setWebDrag(true);
    }
    const col = colDrag.col;
    if (!colDrag.frozen) {
      // 以「现在看到的宽度」作为各列的设定宽度再开始拖：这时它们加起来正好是当前总宽，
      // 分界线就是 1:1 跟着指针走，不会被「按比例压缩」那一套稀释掉
      freezeColumnWidths();
      const list = visibleColumns();
      const at = list.indexOf(col);
      colDrag.left = at > 0 ? list[at - 1] : null;
      colDrag.w = col.w;
      colDrag.leftW = colDrag.left ? colDrag.left.w : 0;
      colDrag.frozen = true;
    }
    const dx = e.clientX - colDrag.x;   // 向左拖为负
    if (colDrag.left) {
      // 这两列加起来不变：一列变宽，另一列就变窄，各自都不低于下限
      const pair = colDrag.w + colDrag.leftW;
      const want = Math.min(pair - PANE_MIN, Math.max(PANE_MIN, colDrag.w - dx));
      col.w = want;
      colDrag.left.w = pair - want;
    } else {
      // 最左那一列：左边是栏区，加宽就从栏区借，栏区不低于硬下限
      const list = visibleColumns();
      const others = list.reduce((s, c) => s + (c === col ? 0 : c.w), 0);
      const max = Math.max(PANE_MIN, paneDragMax() - others);
      col.w = Math.min(max, Math.max(PANE_MIN, colDrag.w - dx));
      // 记下这一拖给栏区留了多宽：拖动结束后按这个下限留住它，
      // 不然刚拖出来的宽度会被「按比例压缩」分给右边的固定列
      const left = bodyWidth() - (col.w + others);
      const auto = list.length >= 3 ? MAIN_HARD_MIN : mainComfortWidth();
      mainFloor = left >= auto ? 0 : left;
    }
    applyColumnWidths();
    hooks.afterLayout();
  });
  panesEl.addEventListener('pointerup', (e) => {
    if (!colDrag || e.pointerId !== colDrag.pointerId) return;
    const drag = colDrag;
    const col = drag.col;
    endColDrag();
    // 临时预览列的宽度沿用原来的设置项，重启后恢复（它自己拖动、或被左邻让出宽度都算）
    if (col === tempCol) pv.setState({ previewWidth: col.w });
    else if (tempCol.w !== drag.tempW) pv.setState({ previewWidth: tempCol.w });
  });
  panesEl.addEventListener('pointercancel', () => endColDrag());

  /* ============================ 拖动分屏比 ============================ */
  let splitDrag = null;

  function endSplitDrag() {
    if (!splitDrag) return;
    const drag = splitDrag;
    splitDrag = null;
    document.body.classList.remove('resizing-v');
    if (drag.webHidden) setWebDrag(false);
    noteLayout();
  }

  panesEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest ? e.target.closest('.pane-split') : null;
    if (!el) return;
    const col = columnOfEl(el);
    if (!col || col.panes.length < 2) return;
    e.preventDefault();
    splitDrag = {
      col: col,
      y: e.clientY,
      split: col.split,
      h: col.stack.clientHeight || 1,
      pointerId: e.pointerId,
      webHidden: true
    };
    // 分隔条只有 6px 高，按下就先藏网页视图：指针第一次移动就可能落进原生视图
    setWebDrag(true);
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.classList.add('resizing-v');
  });
  panesEl.addEventListener('pointermove', (e) => {
    if (!splitDrag || e.pointerId !== splitDrag.pointerId) return;
    const dy = e.clientY - splitDrag.y;
    const ratio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, splitDrag.split + dy / splitDrag.h));
    splitDrag.col.split = ratio;
    layoutColumn(splitDrag.col);
    hooks.afterLayout();
  });
  panesEl.addEventListener('pointerup', (e) => {
    if (!splitDrag || e.pointerId !== splitDrag.pointerId) return;
    endSplitDrag();
  });
  panesEl.addEventListener('pointercancel', () => endSplitDrag());

  /* ============================ 拖动换位置 / 分屏 ============================ */
  /**
   * 按住窗格头部左边的小抓手可以拖动：
   *   - 落在其它列的空白处：换位置（固定列的先后）
   *   - 落在某个「只有一格」的固定列的下 1/3：并到那一列的下半屏
   *   - 临时预览列的抓手拖到右侧：自动固定成一列
   *
   * 拖动期间不实时重排：只在目标缝隙上画一条竖线 / 给分屏列染色，松手时一次性落位。
   * 实时重排会让相邻列在指针底下反复移位，反而不好瞄准。
   */
  const HEAD_DRAG_SLOP = 4;
  let headDrag = null;

  function clearHeadHints() {
    for (const pane of panes.values()) {
      pane.el.classList.remove('is-moving');
      if (pane.head) pane.head.classList.remove('drop-before', 'drop-after');
    }
    for (const col of allColumns()) col.el.classList.remove('is-split-target');
    document.body.classList.remove('pane-moving');
  }

  /**
   * 算落点。返回：
   *   { mode:'none' }                         没有可落的固定位置
   *   { mode:'split', col }                   分到这一列的下半屏
   *   { mode:'insert', rest, index, blocked } 插到 rest[index] 的位置（新开一列）
   * rest 是「不包含即将被移走的源列」的固定列列表；blocked 是列数已满时的提示。
   */
  function dropInfo(d, x, y) {
    const pane = d.pane;
    if (!pane.pinned) {
      // 临时列只有拖到它右边才固定；在原列里左右晃不算
      const tr = tempCol.el.getBoundingClientRect();
      if (x <= tr.right - 8) return { mode: 'none' };
    }

    const cols = visibleColumns();
    let over = null;
    for (const col of cols) {
      const r = col.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right) { over = col; break; }
    }

    // 下 1/3 分屏：目标必须是固定列、只有一格，且不是自己被拖出来的那一列
    if (over && over !== tempCol && over.panes.length === 1 && over !== pane.col) {
      const r = over.el.getBoundingClientRect();
      if (y >= r.top + r.height * (2 / 3)) return { mode: 'split', col: over };
    }

    let rest;
    if (!pane.pinned) {
      rest = pins.slice();
    } else {
      const src = pane.col;
      // 源列只有这一格时，移走等于把整列移走，插入位置按「不含源列」的列表算
      rest = (src && src.panes.length === 1) ? pins.filter((c) => c !== src) : pins.slice();
    }

    const addsColumn = !pane.pinned || !pane.col || pane.col.panes.length !== 1;
    if (addsColumn && pins.length >= MAX_PINS) {
      return {
        mode: 'insert',
        rest: rest,
        index: 0,
        blocked: pane.pinned
          ? '固定列已满（最多 ' + MAX_PINS + ' 列），先把某一列取消固定'
          : '固定列已满（最多 ' + MAX_PINS + ' 列），可拖到某一列的下 1/3 分屏'
      };
    }

    let idx = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const r = rest[i].el.getBoundingClientRect();
      if (x < r.left + r.width / 2) { idx = i; break; }
    }
    return { mode: 'insert', rest: rest, index: idx, blocked: null };
  }

  function paintDrop(d, info) {
    for (const pane of panes.values()) {
      if (pane.head) pane.head.classList.remove('drop-before', 'drop-after');
    }
    for (const col of allColumns()) col.el.classList.remove('is-split-target');
    if (!info) return;

    if (info.mode === 'split') {
      info.col.el.classList.add('is-split-target');
      return;
    }
    if (info.mode !== 'insert' || info.blocked) return;

    const pane = d.pane;
    // 源列只有一格、插回原位：什么都不变，不画线
    if (pane.pinned && pane.col && pane.col.panes.length === 1) {
      if (pins.indexOf(pane.col) === info.index) return;
    }
    const rest = info.rest;
    if (!rest.length) {
      // 还没有固定列：临时列拖到右侧时，在它自己右边画一条线表示「新列落这里」
      if (!pane.pinned) pane.head.classList.add('drop-after');
      return;
    }
    if (info.index < rest.length) rest[info.index].panes[0].head.classList.add('drop-before');
    else rest[rest.length - 1].panes[0].head.classList.add('drop-after');
  }

  /** 把一格并到目标列的下半屏；源列只剩一格时整列移除，源列原本就是分屏时留下另一格 */
  function applySplit(d, info) {
    const target = info.col;
    if (!target || target === tempCol || target.panes.length >= MAX_PANES_PER_COL) return;
    const pane = d.pane;

    if (pane.pinned) {
      const src = pane.col;
      if (!src || src === target) return;
      const keep = paneScrollKeep(paneScrollHost(pane));
      removePaneFromColumn(src, pane);
      if (!src.panes.length) dropEmptyColumn(src);
      addPaneToColumn(target, pane);
      renderPreview();
      if (keep) restorePaneTop(pane, keep);
      hooks.toast('已分屏：' + pane.node.name);
      noteLayout();
      return;
    }

    const made = makePinPaneFromTemp();
    if (!made) return;
    addPaneToColumn(target, made.pane);
    renderPreview();
    if (made.keep) restorePaneTop(made.pane, made.keep);
    if (made.carried) PV.find.refresh();
    hooks.toast('已分屏：' + made.pane.node.name);
    noteLayout();
  }

  /** 新开一列插到固定列的指定位置；临时列的内容会在这里固定 */
  function applyInsert(d, info) {
    if (!info || info.blocked) return;
    const pane = d.pane;

    if (!pane.pinned) {
      const made = makePinPaneFromTemp();
      if (!made) return;
      const col = createColumn({
        pane: made.pane,
        w: Math.max(PANE_MIN, tempCol.w || defaultColumnWidth())
      });
      pins.splice(info.index, 0, col);
      renderPreview();
      if (made.keep) restorePaneTop(made.pane, made.keep);
      if (made.carried) PV.find.refresh();
      hooks.toast('已固定：' + made.pane.node.name);
      noteLayout();
      return;
    }

    const src = pane.col;
    if (!src) return;
    if (src.panes.length === 1) {
      // 整列移动：只改 pins 的顺序，不碰 DOM，滚动位置原样保留
      const from = pins.indexOf(src);
      if (from < 0 || from === info.index) return;
      pins.splice(from, 1);
      pins.splice(info.index, 0, src);
      renderPreview();
      noteLayout();
      return;
    }

    // 从分屏里抽出一格，另开一列
    const keep = paneScrollKeep(paneScrollHost(pane));
    removePaneFromColumn(src, pane);
    const col = createColumn({
      pane: pane,
      w: Math.max(PANE_MIN, src.w || defaultColumnWidth())
    });
    pins.splice(info.index, 0, col);
    renderPreview();
    if (keep) restorePaneTop(pane, keep);
    hooks.toast('已移到新列：' + pane.node.name);
    noteLayout();
  }

  function endHeadDrag(commit) {
    const d = headDrag;
    headDrag = null;
    if (!d) return;
    clearHeadHints();
    const info = d.info;
    const restoreWeb = d.webHidden;
    if (commit && d.active && info) {
      if (info.blocked) hooks.toast(info.blocked);
      else if (info.mode === 'split') applySplit(d, info);
      else if (info.mode === 'insert') applyInsert(d, info);
    }
    if (restoreWeb) setWebDrag(false);
  }

  panesEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || headDrag) return;
    const grip = e.target.closest ? e.target.closest('.pv-grip') : null;
    if (!grip) return;
    const pane = paneOf(grip);
    if (!pane || !pane.node) return;
    e.preventDefault();
    headDrag = {
      pane: pane,
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      active: false,
      info: null,
      webHidden: false
    };
    // 拖出窗格边界也要继续收到 move / up；合成事件没有真实指针，捕获失败不影响判定
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  panesEl.addEventListener('pointermove', (e) => {
    const d = headDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.x) < HEAD_DRAG_SLOP && Math.abs(e.clientY - d.y) < HEAD_DRAG_SLOP) return;
      d.active = true;
      d.pane.el.classList.add('is-moving');
      document.body.classList.add('pane-moving');
      d.webHidden = true;
      setWebDrag(true);
    }
    const info = dropInfo(d, e.clientX, e.clientY);
    d.info = info;
    paintDrop(d, info);
  });

  panesEl.addEventListener('pointerup', (e) => {
    if (!headDrag || e.pointerId !== headDrag.pointerId) return;
    endHeadDrag(true);
  });
  panesEl.addEventListener('pointercancel', () => endHeadDrag(false));
  // 拖到一半窗口失焦（Alt+Tab）：收掉拖动中的样式，免得光标和变淡的标题卡住
  window.addEventListener('blur', () => {
    endColDrag();
    endSplitDrag();
    endHeadDrag(false);
  });

  /* ============================ 对外接口 ============================ */
  window.PV = window.PV || {};
  PV.pane = {
    /** app.js 注入 toast / selection / renderHead / renderBody / bodyKey */
    init: function (h) { Object.assign(hooks, h); },

    /* 渲染与布局 */
    renderPreview: renderPreview,
    renderPane: renderPane,
    captureView: function (pane) { return paneScrollKeep(paneScrollHost(pane)); },
    restoreView: restorePaneTop,
    relayout: function () {
      ensureColumnWidths();
      fitColumnWidths();
      applyColumnWidths();
      hooks.afterLayout();
    },

    /* 显示开关（预览区整体是否显示） */
    previewOpen: function () { return previewOpen; },
    setPreviewOpen: function (on) { previewOpen = !!on; },

    /* 临时预览列与固定列 */
    setTempWidth: function (w) { tempCol.w = Math.max(PANE_MIN, w); },
    resetTemp: resetTemp,
    clearPins: clearPins,
    /** 当前项目的固定列布局（顺序 / 宽度 / 分屏比例 / 内容） */
    layoutSnapshot: layoutSnapshot,
    /** 切换项目后按保存的布局重建固定列 */
    restoreLayout: restoreLayout,

    /* 固定 / 取消固定 */
    pinCurrent: pinCurrent,
    unpinPane: unpinPane,

    /* 最近操作的窗格 */
    active: function () { return panes.get(activePaneId) || null; },
    setActive: function (pane) { activePaneId = pane ? pane.id : 0; },
    clearActive: function () { activePaneId = 0; },

    /* 查询 */
    paneOf: paneOf,
    allPanes: allPanes,
    modeOf: modeOf,
    visiblePanes: visiblePanes,
    scrollPaneBy: scrollPaneBy
  };
})();
