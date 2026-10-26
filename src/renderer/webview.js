/* 内嵌网页视图的几何同步
 *
 * 网页不是 DOM，而是主进程叠在窗口上的 WebContentsView。这个文件只做一件事：
 * 把「每个网页预览列现在应该占哪块矩形」声明给主进程（web:sync），由它增删视图。
 *
 * 主进程按地址而不是窗格 id 认视图，所以固定一列时视图原地留下：滚动位置、
 * 登录态、页面里填了一半的表单都不会丢。
 *
 * 触发点（由 pane.js 的 afterLayout 与 app.js 的窗口事件驱动）：
 *   每次 renderPreview、列宽拖动、窗口缩放 / 最大化、预览收起、窗口失焦。
 * 用 requestAnimationFrame 合并，拖动分界线时不会每像素一次 IPC。
 *
 * 加载顺序：icons.js → highlight.js → markdown.js → vendor/docpreview.js →
 *           pane.js → preview-body.js → webview.js → find.js → projects.js → app.js。
 */
(function () {
  'use strict';

  /** 有弹层（网页表单、项目图标选择器）压住预览区时，先把所有网页视图藏起来 */
  let occluded = false;
  /** 拖动列 / 分隔条 / 窗格时也先藏起来：原生视图会吃掉鼠标事件，拖动会断 */
  let dragHidden = false;
  let frame = 0;

  function visibleInPane(pane) {
    if (occluded || dragHidden) return false;
    if (pane.el.hidden) return false;
    const preview = document.getElementById('preview');
    if (!preview || preview.hidden) return false;
    // 欢迎页是一个全屏 HTML 覆盖层；原生视图会盖在它上面，必须先藏起来
    const welcome = document.getElementById('welcome');
    if (welcome && !welcome.hidden) return false;
    if (document.hidden) return false;
    const r = pane.body.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }

  /** 当前需要的视图列表；同一个地址出现在多个窗格时只留一份 */
  function collect() {
    const list = new Map();
    let panes = [];
    try {
      panes = PV.pane.allPanes();
    } catch {
      return [];
    }
    for (const pane of panes) {
      const node = pane.node;
      if (!node || node.kind !== 'web' || !node.url) continue;
      const visible = !occluded && visibleInPane(pane);
      const r = visible ? pane.body.getBoundingClientRect() : null;
      const item = {
        url: node.url,
        visible: visible,
        rect: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null
      };
      const prev = list.get(node.url);
      // 固定住的列和还没收起的临时列可能同时指向同一个地址，优先显示的那一份
      if (prev && (prev.visible || !item.visible)) continue;
      list.set(node.url, item);
    }
    return Array.from(list.values());
  }

  function sync() {
    frame = 0;
    const list = collect();
    document.body.classList.toggle('has-web', list.some((item) => item.visible));
    try {
      const job = pv.webSync(list);
      if (job && typeof job.catch === 'function') job.catch(() => {});
    } catch { /* 测试环境或旧 preload 没有这个接口 */ }
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(sync);
  }

  function setOccluded(on) {
    occluded = !!on;
    schedule();
  }

  /** 拖动期间藏网页视图（只藏不销毁）；松手后 afterLayout 会按新矩形放回来 */
  function setDragHidden(on) {
    dragHidden = !!on;
    schedule();
  }

  window.PV = window.PV || {};
  PV.web = {
    sync: sync,
    schedule: schedule,
    setOccluded: setOccluded,
    setDragHidden: setDragHidden
  };
})();
