/* 预览内查找
 *
 * Ctrl+F 在「渲染成真实 DOM 的预览」里查关键字：
 *   - 参与查找：Markdown 预览、Word / PPT 内嵌预览
 *   - 不参与：代码视图（按窗口渲染，DOM 里只有可见的几十行）、图片、PDF、HTML（在 iframe 里）
 * 命中处原地包一层 <mark>，当前命中再加 .is-current 并滚到视口中间。
 *
 * 查找条长在窗格上（pane.findEl），所以「窗格没了 / 换内容了 / 被收起来了」都要
 * 通知到这里：窗格那边调 closeIfOn / revalidate / afterRender / carryFrom。
 * 窗格本身的信息（哪个可见、最近操作的是谁、点在谁身上）一律问 PV.pane。
 *
 * 加载顺序：shared/contracts.js → paths.js → icons.js → highlight.js → markdown.js →
 *           vendor/docpreview.js → pane.js → preview-body.js → webview.js → svgedit.js →
 *           find.js → projects.js → app.js。
 */
(function () {
  'use strict';

  const { icon } = PV.icons;

  /** 单次查找最多标记多少个命中，避免超大文档把主线程卡住 */
  const FIND_MAX = 2000;

  /** 最近一次指针位置：Ctrl+F 优先作用在指针下的那个窗格 */
  const pointer = { x: -1, y: -1 };
  let findState = null;   // { pane, query, hits, index, capped }

  document.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }, { passive: true });

  function isOpen() {
    return !!findState;
  }

  /** 这一列支不支持查找：正文得是渲染成真实 DOM 的那种 */
  function canFind(pane) {
    if (!pane || !pane.node || pane.node.isDir) return false;
    if (pane.el.hidden) return false;
    const box = pane.body;
    if (!box || box.classList.contains('is-empty')) return false;
    if (box.querySelector('.codeview, .img-wrap, .imgseq, iframe')) return false;
    return !!box.querySelector('.prose, .docview');
  }

  /** Ctrl+F 会落在哪个窗格：指针下的 → 最近点过的 → 最左的可见窗格 */
  function targetPane() {
    const list = PV.pane.visiblePanes().filter((p) => !p.el.hidden);
    if (!list.length) return null;
    const hovered = PV.pane.paneOf(document.elementFromPoint(pointer.x, pointer.y));
    if (hovered && list.indexOf(hovered) >= 0) return hovered;
    const active = PV.pane.active();
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
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-find]');
      if (!btn) return;
      if (btn.dataset.find === 'prev') stepFind(-1);
      else if (btn.dataset.find === 'next') stepFind(1);
      else close();
    });
    return el;
  }

  function open(pane) {
    if (!pane) return false;
    if (findState && findState.pane !== pane) close();
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
  function close() {
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

  /** 查找条长在这个窗格上就关掉（窗格被销毁、或正文被换成不能查的东西） */
  function closeIfOn(pane) {
    if (findState && findState.pane === pane) close();
  }

  /** 布局变了：查找条所在的那一列被收起来时一并关掉 */
  function revalidate() {
    if (findState && findState.pane.el.hidden) close();
  }

  /** 正文重渲染完成后重新落高亮；已经不是当前那次渲染就跳过 */
  function afterRender(pane, task, done) {
    if (!findState || findState.pane !== pane) return;
    Promise.resolve(done).then(() => {
      if (findState && findState.pane === pane && !task.stale) refresh();
    });
  }

  /** 把查询词从一列交给另一列（固定住内容时），返回是否真的交了 */
  function carryFrom(from, to) {
    if (!findState || findState.pane !== from || !findState.query) return false;
    const query = findState.query;
    // 正文由窗格重渲染后自动重新落高亮，这里只搬查询词
    close();
    const bar = ensureFindBar(to);
    bar.hidden = false;
    bar.querySelector('.find-input').value = query;
    findState = { pane: to, query: query, hits: [], index: -1, capped: false };
    return true;
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

  function applyFind(keepIndex) {
    const f = findState;
    if (!f) return;
    // 文本被外部重写（比如代码高亮完成）时可以保留当前命中序号，避免视图跳回第一条
    const prev = keepIndex && f.index >= 0 ? f.index : -1;
    clearMarks(f.pane.body);
    f.hits = [];
    f.index = -1;
    f.capped = false;
    if (f.query) {
      const res = markMatches(f.pane.body, f.query);
      f.hits = res.hits;
      f.capped = res.capped;
      if (f.hits.length) {
        f.index = prev >= 0 ? Math.min(prev, f.hits.length - 1) : 0;
        focusFindHit();
      }
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

  /** 正文重渲染之后重新落高亮；keepIndex=true 时保留当前命中序号 */
  function refresh(keepIndex) {
    const f = findState;
    if (!f) return;
    if (f.pane.el.hidden || !canFind(f.pane)) { close(); return; }
    applyFind(keepIndex);
  }

  /** 只有这块正文正在被查找时才刷新（代码高亮完成时用） */
  function refreshIn(root) {
    if (findState && root && findState.pane.body.contains(root)) refresh(true);
  }

  window.PV = window.PV || {};
  PV.find = {
    open: open,
    close: close,
    isOpen: isOpen,
    canFind: canFind,
    targetPane: targetPane,

    /* 给窗格模块的回调 */
    closeIfOn: closeIfOn,
    revalidate: revalidate,
    afterRender: afterRender,
    carryFrom: carryFrom,
    refresh: refresh,
    refreshIn: refreshIn
  };
})();
