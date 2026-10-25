/* 预览窗格：生命周期与布局
 *
 * 预览区由若干「窗格」组成，每个窗格各自记住文件、模式与宽度：
 *   - 临时预览：只跟随「选中文件」更新。选中文件夹不动它（文件夹没有预览）
 *   - 固定列：由图钉固定下来，最多 MAX_PINS 个，新固定的排在旧固定的右边
 * 选中项已经出现在某个固定列里时，临时预览不再重复展示同一份内容。
 * 每个窗格左侧的边界都可以拖动，且只改这一列的宽度。
 *
 * 这个文件管的是「窗格作为一个单元」的全部事情：
 *   - 身份：内容身份 bodyKey（该显示什么）与任务身份 reqId（这是不是我那一次）
 *   - 渲染任务：晚到的旧响应写不进正文（见 beginTask）
 *   - 创建 / 销毁 / 视图卸载
 *   - 迁移：固定一列时把正文整块搬到新窗格
 *   - 宽度与排列：每列独立宽度、按可用空间压缩、拖动改宽、按住头部换位置
 *
 * 正文与头部「画成什么样」不在这里：app.js 把 preview-body.js 的三个口子装进来
 * （PV.pane.init 的 renderHead / renderBody / bodyKey）。查找条长在窗格上，所以本文件
 * 会通知 PV.find（closeIfOn / revalidate / afterRender / carryFrom）——都是在函数体里
 * 引用，与加载顺序无关。
 *
 * 加载顺序：icons.js → highlight.js → markdown.js → vendor/docpreview.js →
 *           pane.js → preview-body.js → webview.js → find.js → projects.js → app.js。
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const panesEl = $('#panes');
  const previewEl = $('#preview');

  /** 最多固定几个预览窗格（加上临时预览列，最多四列并行） */
  const MAX_PINS = 3;
  const PANE_MIN = 240;        // 单个窗格的最小宽度
  const MAIN_HARD_MIN = 260;   // 栏区的绝对下限（约一栏宽），手动拖动也不越过

  /**
   * app.js 注入的接口：本文件只管「什么时候」，画成什么样由它们决定。
   *   mode()                  临时预览列当前用的模式（固定列各记一份，见 modeOf）
   *   selection()             当前选中的 { col, node } 或 null
   *   renderHead(pane, node)  头部 HTML
   *   renderBody(...)         正文渲染，返回 Promise（见 renderPane 的调用处）
   *   bodyKey(pane,node,mode) 内容身份
   *   afterLayout()           布局变了：网页视图的矩形要跟着重算（webview.js）
   */
  const hooks = {
    toast: function () {},
    mode: function () { return 'preview'; },
    selection: function () { return null; },
    renderHead: function () { return ''; },
    renderBody: function () { return null; },
    bodyKey: function () { return ''; },
    afterLayout: function () {}
  };

  /** 临时预览列是否显示（固定列不受它影响） */
  let previewOpen = true;
  /** 最近操作过的窗格：↑↓ 滚谁、Ctrl+F 落在谁身上 */
  let activePaneId = 0;

  let paneSeq = 0;
  const panes = new Map();
  /** 固定住的预览列（最多 MAX_PINS 个），[0] 在最左；新固定的插到最左，可拖动换位置 */
  let pins = [];

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
      bodyKey: '',        // 内容身份：决定「该显示什么」
      reqId: 0,           // 任务身份：每次真正重渲染都换一个，用来丢弃晚到的旧响应
      pending: 0,         // 还在读/还在解析的渲染任务数，>0 说明正文是加载态空壳
      view: null,
      findEl: null,
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

  /** 临时预览列：始终在最左，内容跟随选中的文件 */
  const tempPane = createPane({});

  function destroyPane(pane) {
    // 查找条长在这个窗格里，窗格没了查找状态也就没意义了
    PV.find.closeIfOn(pane);
    dropPaneView(pane);
    panes.delete(pane.id);
    pane.el.remove();
  }

  /** 代码视图自带 ResizeObserver，换内容前必须销毁，否则越挂越多 */
  function dropPaneView(pane) {
    if (pane.view && pane.view.destroy) pane.view.destroy();
    pane.view = null;
  }

  /** 换工作区：固定列装的是上一个工作区的文件，一律清掉 */
  function clearPins() {
    while (pins.length) destroyPane(pins.pop());
  }

  /** 换工作区：临时预览列清空（正文与内容身份一起复位） */
  function resetTemp() {
    tempPane.node = null;
    tempPane.bodyKey = '';
  }

  function paneOf(el) {
    const host = el && el.closest ? el.closest('.pane') : null;
    if (!host) return null;
    return panes.get(Number(host.dataset.pane)) || null;
  }

  function modeOf(pane) {
    return pane.pinned ? pane.mode : hooks.mode();
  }

  function allPanes() {
    return [tempPane].concat(pins);
  }

  /** 临时预览列是否多余：用户关掉了它，或者内容已经在固定列里 */
  function tempPaneHidden() {
    if (!previewOpen) return true;
    if (!pins.length) return false;
    if (!tempPane.node) return true;
    return isPinnedPath(tempPane.node.path);
  }

  function isPinnedPath(path) {
    return pins.some((p) => p.node && p.node.path === path);
  }

  /** 实际显示出来的窗格：临时预览（若不多余）在最左，固定列按固定先后从右往左排 */
  function visiblePanes() {
    const list = [];
    if (!tempPaneHidden()) list.push(tempPane);
    for (let i = 0; i < pins.length; i++) list.push(pins[i]);
    return list;
  }

  /**
   * 临时预览列只在这两种情况下更新：
   * 1. 选中了一个文件，且这个文件没有出现在任何固定列里
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
      const pinList = list.filter((p) => p !== tempPane);
      for (let guard = 0; guard < 8 && over > 0; guard++) {
        squeezeInto(pinList, eff, over);
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
    PV.find.afterRender(pane, task, done);
  }

  /** 渲染一个窗格：头部每次重建（元信息会异步补发），正文按内容 key 增量渲染 */
  function renderPane(pane, force) {
    const node = pane.node;
    // 换文件时旧文件的「有变化」不能带到新文件头上
    if (pane.known && (!node || pane.known.path !== node.path)) {
      pane.changed = false;
      pane.known = null;
    }
    // 连续预览只对「图片 + 预览模式」有意义，切到别的文件/源码视图时自动退出
    if (pane.continuous && !(node && modeOf(pane) === 'preview' && isImageNode(node))) {
      pane.continuous = false;
    }
    pane.head.innerHTML = node ? hooks.renderHead(pane, node) : '';

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

    const mode = modeOf(pane);
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
    const list = visiblePanes();
    previewEl.hidden = list.length === 0;
    if (!list.length) {
      hooks.afterLayout();
      return;
    }

    for (const pane of allPanes()) pane.el.hidden = list.indexOf(pane) < 0;
    syncPaneOrder(list);

    ensurePaneWidths();
    applyPaneWidths();   // 里面会按可用宽度重算每列的实际宽度

    for (let i = 0; i < list.length; i++) renderPane(list[i], force);
    // 临时预览列被收起来（内容已经在固定列里）时，挂在它上面的查找条一并收掉
    PV.find.revalidate();
    // 头部高度、列宽、显隐都定了，网页视图的矩形现在才准
    hooks.afterLayout();
  }

  /* ============================ 固定与迁移 ============================ */

  function pinCurrent() {
    if (!tempPane.node) return;
    if (pins.length >= MAX_PINS) {
      hooks.toast('最多固定 ' + MAX_PINS + ' 个预览，先取消一个再固定');
      return;
    }
    // 新固定的排在已有固定列的左边：它本来就在临时预览列的位置上，固定后原地不动
    const pane = createPane({
      pinned: true,
      node: tempPane.node,
      mode: modeOf(tempPane),
      w: Math.max(PANE_MIN, tempPane.w || Math.round(bodyWidth() * 0.46)),
      zoom: tempPane.zoom,
      continuous: tempPane.continuous
    });
    pins.unshift(pane);
    // 正在看的那一屏整块搬过去：连续预览滚到第几张、文档读到哪一段都原地保留
    const keep = adoptPaneBody(pane, tempPane);
    // 查找条长在窗格上：内容被固定到新列时，查询词与高亮一并跟过去
    const carried = PV.find.carryFrom(tempPane, pane);
    renderPreview();
    // 位置要等这一列挂进文档、有了布局之后才落得下去（搬家的元素在文档外读不到高度）
    if (keep) restorePaneTop(pane, keep);
    // 正文是搬过来的，没有走重渲染那条路，高亮在这里补落一次
    if (carried) PV.find.refresh();
    hooks.toast('已固定：' + pane.node.name);
  }

  /**
   * 把一列的内容整块交给另一列（DOM 直接搬家，不重新渲染）：
   * 滚动位置、已经解码好的图片、连续预览的列表都原样跟着走——固定住一列
   * 不会让它又从第一张图 / 文首开始。
   * 返回搬家前的位置，等新列进了文档再由 restorePaneTop 落回去；
   * 正文还在读的时候返回 null（见下）。
   */
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
    const at = pins.indexOf(pane);
    if (at < 0) return;
    pins.splice(at, 1);
    destroyPane(pane);
    renderPreview();
    hooks.toast('已取消固定：' + ((pane.node && pane.node.name) || ''));
  }

  /* ============================ 滚动位置 ============================ */

  const PANE_SCROLLERS = ['.prose-wrap', '.cv-scroll', '.imgseq', '.img-wrap', '.docview', '.pdfview'];

  /** 窗格里的滚动容器，不管它现在能不能滚（图片列的高度要等图片解码完才准） */
  function paneScrollHost(pane) {
    for (const sel of PANE_SCROLLERS) {
      const el = pane.body.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function paneScroller(pane) {
    for (const sel of PANE_SCROLLERS) {
      const el = pane.body.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 2) return el;
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

  /** 连续预览只对「图片 + 预览模式」有意义 */
  function isImageNode(node) {
    return !!node && !node.isDir && (node.kind === 'image' || node.kind === 'svg');
  }

  /* ============================ 拖动改宽 ============================ */
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
    hooks.afterLayout();
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

  /* ============================ 拖动换位置 ============================ */
  /**
   * 按住窗格头部的空白处可以拖动固定列，换到其它固定列的位置。
   * 只重排 pins（固定列），临时预览列始终在最左——拖它没有可换的位置，
   * 所以越过阈值时给一句「请先固定此栏」的提示。
   *
   * 拖动期间不实时重排：只在目标缝隙上画一条竖线，松手时一次性落位。
   * 实时重排会让相邻列在指针底下反复移位，反而不好瞄准。
   */
  const HEAD_DRAG_SLOP = 4;
  let headDrag = null;

  function endHeadDrag(commit) {
    const d = headDrag;
    headDrag = null;
    if (!d) return;
    d.pane.el.classList.remove('is-moving');
    document.body.classList.remove('pane-moving');
    for (const p of pins) p.head.classList.remove('drop-before', 'drop-after');
    if (!commit || !d.active) return;
    const from = pins.indexOf(d.pane);
    const to = d.target;
    if (from < 0 || to < 0 || from === to) return;
    pins.splice(from, 1);
    pins.splice(to, 0, d.pane);
    renderPreview();
  }

  /** 指针落在哪个缝隙：对除自己以外的固定列取中点，返回插入到 rest 里的下标 */
  function headDropIndex(x) {
    const rest = pins.filter((p) => p !== headDrag.pane);
    let idx = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const r = rest[i].el.getBoundingClientRect();
      if (x < r.left + r.width / 2) { idx = i; break; }
    }
    return idx;
  }

  function paintHeadDrop(idx) {
    for (const p of pins) p.head.classList.remove('drop-before', 'drop-after');
    const rest = pins.filter((p) => p !== headDrag.pane);
    // 落回原位时不画线：拖了半天又放回去，不该看起来像变了位置
    if (!rest.length || idx === pins.indexOf(headDrag.pane)) return;
    if (idx < rest.length) rest[idx].head.classList.add('drop-before');
    else rest[rest.length - 1].head.classList.add('drop-after');
  }

  panesEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const head = e.target.closest ? e.target.closest('.pv-head') : null;
    if (!head) return;
    // 头部里的按钮 / 路径 / 分段控件仍然是正常点击
    if (e.target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    const pane = paneOf(head);
    if (!pane || !pane.node) return;
    headDrag = { pane: pane, x: e.clientX, y: e.clientY, pointerId: e.pointerId, active: false, target: -1 };
    // 拖出窗格边界也要继续收到 move / up；合成事件没有真实指针，捕获失败不影响判定
    try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  panesEl.addEventListener('pointermove', (e) => {
    const d = headDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.x) < HEAD_DRAG_SLOP && Math.abs(e.clientY - d.y) < HEAD_DRAG_SLOP) return;
      if (!d.pane.pinned) {
        headDrag = null;
        hooks.toast('请先固定此栏，再拖动调整位置');
        return;
      }
      d.active = true;
      d.pane.el.classList.add('is-moving');
      document.body.classList.add('pane-moving');
    }
    const idx = headDropIndex(e.clientX);
    if (idx === d.target) return;
    d.target = idx;
    paintHeadDrop(idx);
  });

  panesEl.addEventListener('pointerup', (e) => {
    if (!headDrag || e.pointerId !== headDrag.pointerId) return;
    endHeadDrag(true);
  });
  panesEl.addEventListener('pointercancel', () => endHeadDrag(false));
  // 拖到一半窗口失焦（Alt+Tab）：收掉拖动中的样式，免得光标和变淡的标题卡住
  window.addEventListener('blur', () => endHeadDrag(false));

  /* ============================ 对外接口 ============================ */
  window.PV = window.PV || {};
  PV.pane = {
    /** app.js 注入 toast / selection / renderHead / renderBody / bodyKey */
    init: function (h) { Object.assign(hooks, h); },

    /* 渲染与布局 */
    renderPreview: renderPreview,
    renderPane: renderPane,
    relayout: function () { fitPaneWidths(); applyPaneWidths(); hooks.afterLayout(); },

    /* 显示开关（预览区整体是否显示） */
    previewOpen: function () { return previewOpen; },
    setPreviewOpen: function (on) { previewOpen = !!on; },

    /* 临时预览列与固定列 */
    setTempWidth: function (w) { tempPane.w = Math.max(PANE_MIN, w); },
    resetTemp: resetTemp,
    clearPins: clearPins,

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
    isImageNode: isImageNode,
    scrollPaneBy: scrollPaneBy
  };
})();
