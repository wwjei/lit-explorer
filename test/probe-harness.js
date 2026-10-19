/**
 * 界面探针的骨架（在页面里跑，不是 node 模块）。
 *
 * 由 scripts/run-probe.mjs 拼在探针文件前面一起交给截图钩子的 --shot-js，
 * 所以探针文件里直接用 H.xxx 就行，不用自己重抄一遍选择器与等待。
 *
 *   npm run probe -- .tmp/my-probe.js --open=.tmp/panews
 *
 * 探针文件应当是一个返回对象的表达式（IIFE），返回值会以 [shot-js] {...}
 * 打到 stdout。
 *
 * 选择器约定（改界面结构时先看这里，别在探针里硬编码）：
 *   .col[data-col="0"] > .col-list .row   第 N 栏的行；行名在 .nm 里
 *   .panes > .pane                        预览列；.is-pinned 是固定列，hidden 是收起
 *   .pane .pv-nm / .pv-sub                列头里的文件名 / 副标题
 *   [data-act="..."]                      列头按钮：pin / close / reload / copy /
 *                                         reveal / external / zoom-in / zoom-out /
 *                                         zoom-reset / seq
 *   [data-mode="preview"|"source"]        预览 / 源码切换
 *   .prose / .prose-wrap                  Markdown 正文与它的滚动容器
 *   .codeview / .cv-scroll                代码视图与它的滚动容器
 *   .imgseq / .img-wrap                   连续预览 / 单张图片
 *   .docview                               docx / pptx 正文
 *   .find-bar / .find-input / mark.find-hit   预览内查找
 *   #toast                                轻提示
 */
(() => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const H = {
    sleep,
    q: (s) => document.querySelector(s),
    qa,

    /** 可见的预览列，按从左到右排 */
    vis() {
      return qa('.panes > .pane')
        .filter((p) => !p.hidden)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    },
    /** 临时预览列（最左那一列） */
    temp() {
      return H.vis().filter((p) => !p.classList.contains('is-pinned'))[0];
    },
    /** 固定列，按从左到右排 */
    pins() {
      return H.vis().filter((p) => p.classList.contains('is-pinned'));
    },
    pin(i) {
      return H.pins()[i || 0];
    },
    /** 按列头里的文件名找列 */
    paneNamed(name) {
      return H.vis().filter((p) => {
        const el = p.querySelector('.pv-nm');
        return el && el.textContent === name;
      })[0];
    },
    /** 列头里的文件名 */
    name(pane) {
      const el = pane && pane.querySelector('.pv-nm');
      return el ? el.textContent : null;
    },
    /** 某一栏的行；不传就是第一栏 */
    rows(col) {
      return qa('.col[data-col="' + (col || 0) + '"] > .col-list .row');
    },
    /** 按名字取行 */
    row(name, col) {
      return H.rows(col).filter((r) => {
        const el = r.querySelector('.nm');
        return el && el.textContent === name;
      })[0];
    },
    /** 点开某个文件并等预览落定 */
    async pick(name, wait) {
      const r = H.row(name);
      if (!r) throw new Error('列表里没有这一行：' + name);
      r.click();
      await sleep(wait === undefined ? 1400 : wait);
    },
    /** 点列头按钮 */
    click(pane, act) {
      const b = pane.querySelector('[data-act="' + act + '"]');
      if (!b) throw new Error('这一列没有按钮：' + act);
      b.click();
    },
    /** 模拟按键（应用级快捷键挂在 document 上） */
    key(el, k, opts) {
      (el || document).dispatchEvent(new KeyboardEvent('keydown',
        Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})));
    },
    /** 往输入框里打字：直接赋 value 不会触发监听，要补一个 input 事件 */
    type(input, value) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    /** 各列的名字与宽度，用来核对布局 */
    layout() {
      return H.vis().map((p) => ({
        name: H.name(p),
        pinned: p.classList.contains('is-pinned'),
        w: Math.round(p.getBoundingClientRect().width)
      }));
    },
    /** 某一列内容的滚动容器与滚动位置 */
    scroller(pane) {
      for (const sel of ['.prose-wrap', '.cv-scroll', '.imgseq', '.img-wrap', '.docview', '.pdfview']) {
        const el = pane.querySelector(sel);
        if (el) return el;
      }
      return null;
    },
    scrollTop(pane) {
      const sc = H.scroller(pane);
      return sc ? sc.scrollTop : null;
    },
    /** 正文里最上面那个可见标题（列宽变化后核对「读到的位置没变」用） */
    anchor(pane) {
      const sc = pane.querySelector('.prose-wrap');
      if (!sc) return null;
      const box = sc.getBoundingClientRect();
      for (const h of sc.querySelectorAll('.prose h2, .prose h3')) {
        const r = h.getBoundingClientRect();
        if (r.bottom > box.top + 2) {
          return { text: h.textContent.trim().slice(0, 22), off: Math.round(r.top - box.top) };
        }
      }
      return null;
    },
    /** 轻提示的文字（没显示时返回 null） */
    toast() {
      const el = H.q('#toast');
      return el && el.classList.contains('on') ? el.textContent : null;
    }
  };

  window.H = H;
})();
