/* SVG 轻量编辑
 *
 * 预览列里的 SVG 默认还是 <img>。点列头的铅笔进入编辑模式后，这个文件接管正文：
 *   - 用 DOMParser 解析成真正的 SVG DOM，交给预览区直接渲染（不再是图片）；
 *   - 单击选中形状，拖动移动；矩形额外提供八个缩放手柄；
 *   - 双击文字进入单行编辑，Enter / 失焦提交，Esc 取消；
 *   - Delete / Backspace 删除选中的形状；
 *   - 每次改动自动写回磁盘（通过 pv.writeSvg），Ctrl+Z / Ctrl+Shift+Z 撤销重做。
 *
 * 安全边界：
 *   - SVG 是不可信输入。挂进宿主 DOM 前先清洗：脚本、foreignObject、SMIL、
 *     事件属性、javascript: / 危险 data: 链接全部摘掉；一旦摘掉了东西就把这个文件
 *     标成「只读」，不允许保存——避免用户的一次保存把文件里的合法脚本悄悄删掉。
 *   - 页面里的 <a> 链接在编辑模式下不跟随，防止把整个应用窗口导航走。
 *   - 写文件只走主进程的 fs:write-svg：工作区内已存在的 .svg、带版本冲突检测。
 *
 * 保存是自动的：拖动 / 缩放松手、文字提交、删除、撤销各写一次。写入按顺序排队，
 * 每次带上读取时的 size / mtime；磁盘上已经变了就停在「保存冲突」，不覆盖别人的修改。
 *
 * 加载顺序：shared/contracts.js → paths.js → icons.js → highlight.js → markdown.js →
 *           pane.js → preview-body.js → webview.js → svgedit.js →
 *           find.js → projects.js → app.js。
 */
(function () {
  'use strict';

  const MAX_UNDO = 50;
  const MOVE_SLOP = 3;      // 屏幕像素：小于它算点击，不算拖动
  const MIN_RECT = 2;       // 矩形缩到的最小用户单位
  const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'path', 'text', 'image', 'use']);
  const BLOCKED_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed',
    'audio', 'video', 'canvas', 'set', 'animate', 'animatetransform', 'animatemotion',
    'discard']);
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i;

  const esc = PV.highlight.escapeAttr;

  /** 保留两位小数，避免 transform 里出现一长串浮点尾巴 */
  function fmt(n) {
    const v = Math.round(n * 100) / 100;
    return String(Object.is(v, -0) ? 0 : v);
  }

  function numAttr(el, name) {
    const raw = el.getAttribute(name);
    if (raw === null || raw === '') return 0;
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  }

  function unsafeHref(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    if (!s) return false;
    if (s.startsWith('#')) return false;
    if (s.startsWith('http:') || s.startsWith('https:') || s.startsWith('mailto:')) return false;
    if (s.startsWith('data:')) return !DATA_IMAGE.test(s);
    // file: 与相对路径：内联后基准是宿主页面而不是 SVG 所在目录，既解析错位，
    // 也可能顺着 file: 读到工作区外的文件。这类文件只读显示，不保存。
    return true;
  }

  /** CSS 里能加载外部资源的位置：@import / url(...)；只放行片段、http(s) 与内嵌图片/字体 */
  function cssUnsafe(text) {
    if (/@import/i.test(text)) return true;
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let m;
    while ((m = re.exec(text))) {
      const u = m[2].trim().toLowerCase();
      if (!u || u.startsWith('#')) continue;
      if (u.startsWith('http:') || u.startsWith('https:')) continue;
      if (/^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp)|font\/)/.test(u)) continue;
      return true;
    }
    return false;
  }

  /**
   * 解析并清洗。返回值里的 risky 表示「原文件里有东西被摘掉了」：
   * 这种文件只显示、不编辑，也就永远不会被序列化写回。
   */
  function parseSvg(text) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    } catch {
      return { error: 'PARSE' };
    }
    const root = doc && doc.documentElement;
    if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
      return { error: 'PARSE' };
    }
    const risky = sanitize(root);
    return { root: root, risky: risky };
  }

  function sanitize(root) {
    let risky = false;
    const all = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = root; n; n = walker.nextNode()) all.push(n);
    for (const el of all) {
      if (BLOCKED_TAGS.has(el.localName.toLowerCase())) {
        risky = true;
        el.remove();
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          risky = true;
          el.removeAttribute(attr.name);
          continue;
        }
        if (name === 'style' && cssUnsafe(attr.value)) {
          risky = true;
          el.removeAttribute(attr.name);
          continue;
        }
        if (name !== 'href' && !name.endsWith(':href')
          && /url\s*\(/i.test(attr.value) && cssUnsafe(attr.value)) {
          // fill / clip-path / marker-* 这类表现属性也可能加载外部资源
          risky = true;
          el.removeAttribute(attr.name);
          continue;
        }
        if (name === 'href' || name.endsWith(':href')) {
          if (unsafeHref(attr.value)) {
            risky = true;
            el.removeAttribute(attr.name);
          }
        }
      }
    }
    // <style> 里的 @import / 外部 url() 同样按不安全处理，整块摘掉
    for (const el of Array.from(root.querySelectorAll('style'))) {
      if (cssUnsafe(el.textContent)) {
        risky = true;
        el.remove();
      }
    }
    return risky;
  }

  /** 从事件目标找到可选择 / 可移动的形状；点在 tspan 上时归到它所在的 text */
  function shapeTarget(node, root) {
    if (!node || !root.contains(node)) return null;
    let cur = node;
    while (cur && cur !== root && cur.nodeType === 1) {
      if (cur.localName === 'tspan') return cur.closest('text');
      if (SHAPE_TAGS.has(cur.localName)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /** 双击文字时真正要编辑的节点；一段 text 由多个 tspan 拼成时只编辑具体那一行 */
  function textTarget(node, root) {
    if (!node || !root.contains(node)) return null;
    let cur = node;
    while (cur && cur !== root && cur.nodeType === 1) {
      if (cur.localName === 'tspan') {
        return cur.querySelector('tspan, textPath') ? null : cur;
      }
      if (cur.localName === 'text') {
        if (cur.querySelector('tspan, textPath')) return null;
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * 双击点可能落在两个字形之间的空隙里（浏览器不会把 text 当成整块可点区域），
   * 这时用包围盒再找一次：取包含该点、面积最小的 text / tspan。
   */
  function textAtPoint(root, x, y) {
    let best = null;
    for (const el of root.querySelectorAll('tspan, text')) {
      if (el.querySelector('tspan, textPath')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (!best || area < best.area) best = { el: el, area: area };
    }
    return best ? best.el : null;
  }

  function canResize(el) {
    if (!el || el.localName !== 'rect') return false;
    const w = numAttr(el, 'width');
    const h = numAttr(el, 'height');
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
    for (const name of ['x', 'y']) {
      const raw = el.getAttribute(name);
      if (raw !== null && !Number.isFinite(Number(raw))) return false;
    }
    return true;
  }

  /**
   * 矩形框里的文字：图里一个「框」通常是 rect + 几段独立的 text（不是 g），
   * 只拖 rect 会把标题留在原地。这里按「文字中心落在矩形内」把同级的 text 找出来，
   * 拖动时一起平移、缩放时跟着框中心移动、删除时一起删掉。
   */
  function enclosedTexts(rect) {
    if (!rect || rect.localName !== 'rect') return [];
    const box = rect.getBoundingClientRect();
    const out = [];
    for (const el of Array.from(rect.parentElement ? rect.parentElement.children : [])) {
      if (el === rect || el.localName !== 'text') continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) out.push(el);
    }
    return out;
  }

  function card(text) {
    return '<div class="state"><div class="big">' + PV.icons.icon('image', '', 26) + '</div>'
      + '<h4>无法编辑这个 SVG</h4><p>' + esc(text) + '</p></div>';
  }

  function toolbarHtml(risky) {
    const hint = risky
      ? '<span class="svg-warn">这个 SVG 含脚本或外部对象，只做安全显示，编辑已禁用</span>'
      : '<span class="svg-hint">单击选择 · 双击文字编辑 · 拖动移动 · 矩形拖角缩放 · Delete 删除</span>';
    return '<div class="svg-bar">' + hint
      + '<span class="svg-status">' + (risky ? '只读' : '已保存') + '</span>'
      + '<span class="svg-zoom">'
      + '<button type="button" data-svg="zoom-out" title="缩小">−</button>'
      + '<button type="button" class="svg-zoom-val" data-svg="zoom-reset" title="回到适应宽度">适应</button>'
      + '<button type="button" data-svg="zoom-in" title="放大">+</button>'
      + '</span>'
      + '<button type="button" data-svg="undo" title="撤销 (Ctrl+Z)" disabled>撤销</button>'
      + '<button type="button" data-svg="redo" title="重做 (Ctrl+Shift+Z)" disabled>重做</button>'
      + '<button type="button" data-svg="exit" title="完成编辑">完成</button>'
      + '</div>';
  }

  /**
   * 挂载编辑器。由 preview-body 在 mode=preview 且 pane.svgEdit 时调用；
   * 返回的 Promise 只负责把正文写进去，之后的生命周期挂在 pane.view.destroy 上。
   */
  async function mount(pane, node, task, hooks) {
    const res = await pv.read(node.path);
    if (task.stale) return;
    if (res.error) { task.write(card('读取失败：' + res.error)); return; }
    if (res.binary) { task.write(card('这个文件不是文本格式的 SVG')); return; }
    if (res.truncated) { task.write(card('文件超过 5 MB，暂不支持编辑')); return; }
    if (res.lossy) { task.write(card('编码无法识别，暂不支持编辑（保存会破坏原有编码）')); return; }
    if (res.encoding && res.encoding !== 'utf8') {
      task.write(card('文件是 ' + res.encoding.toUpperCase()
        + ' 编码，暂不支持编辑（保存会写成 UTF-8）'));
      return;
    }

    const hadBom = res.text.charCodeAt(0) === 0xFEFF;
    const source = hadBom ? res.text.slice(1) : res.text;
    const decl = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(source);
    if (decl && !/^utf-?8$/i.test(decl[1])) {
      task.write(card('XML 声明的编码是 ' + decl[1] + '，暂不支持编辑（保存会写成 UTF-8）'));
      return;
    }
    const hadDecl = /^\s*<\?xml\b/i.test(source);
    const trailingNewline = /\n\s*$/.test(res.text);
    const parsed = parseSvg(source);
    if (parsed.error) { task.write(card('这个文件不是有效的 SVG')); return; }

    const wrap = document.createElement('div');
    wrap.className = 'svg-edit' + (parsed.risky ? ' is-risky' : '');
    wrap.tabIndex = 0;
    wrap.innerHTML = toolbarHtml(parsed.risky);
    const scroll = document.createElement('div');
    scroll.className = 'svg-scroll';
    const stage = document.createElement('div');
    stage.className = 'svg-stage';
    const box = document.createElement('div');
    box.className = 'svg-sel';
    box.hidden = true;
    for (const name of HANDLES) {
      const grip = document.createElement('i');
      grip.className = 'svg-grip';
      grip.dataset.h = name;
      box.appendChild(grip);
    }
    stage.appendChild(parsed.root);
    stage.appendChild(box);
    scroll.appendChild(stage);
    wrap.appendChild(scroll);

    if (!task.replace(wrap)) return;
    hooks.noteSaved(pane, node, { size: res.size, mtime: res.mtime });

    const editor = createEditor({
      pane: pane, node: node, wrap: wrap, stage: stage, box: box, root: parsed.root,
      risky: parsed.risky, hooks: hooks, size: res.size, mtime: res.mtime,
      hadBom: hadBom, hadDecl: hadDecl, trailingNewline: trailingNewline
    });
    pane.view = editor;
  }

  function createEditor(ctx) {
    const pane = ctx.pane;
    const node = ctx.node;
    const wrap = ctx.wrap;
    const stage = ctx.stage;
    const box = ctx.box;
    const h = ctx.hooks;
    const risky = ctx.risky;

    let root = ctx.root;
    let selected = null;
    let input = null;
    let drag = null;
    let resize = null;
    let undo = [];
    let redo = [];
    let expected = { size: ctx.size, mtime: ctx.mtime };
    let savedXml = serialize();
    let queue = Promise.resolve();
    let disposed = false;

    const bar = wrap.querySelector('.svg-bar');
    const statusEl = wrap.querySelector('.svg-status');
    const undoBtn = wrap.querySelector('[data-svg="undo"]');
    const redoBtn = wrap.querySelector('[data-svg="redo"]');
    const zoomVal = wrap.querySelector('.svg-zoom-val');

    /** 缩放：0 = 适应宽度，其余是相对 SVG 自然尺寸的倍数（大图上改字时用） */
    const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    let zoom = 0;

    function naturalWidth() {
      const vb = root.viewBox && root.viewBox.baseVal;
      if (vb && vb.width > 0) return vb.width;
      const w = Number(root.getAttribute('width'));
      return Number.isFinite(w) && w > 0 ? w : 0;
    }

    function applyZoom() {
      stage.style.width = zoom ? (naturalWidth() * zoom) + 'px' : '100%';
      zoomVal.textContent = zoom ? Math.round(zoom * 100) + '%' : '适应';
      placeBox();
    }

    function stepZoom(dir) {
      if (!naturalWidth()) return;
      if (!zoom) {
        zoom = dir > 0 ? 1 : 0.75;
      } else {
        const at = ZOOM_STEPS.indexOf(zoom);
        const from = at < 0 ? (dir > 0 ? 0 : ZOOM_STEPS.length - 1) : at + dir;
        zoom = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, from))];
      }
      applyZoom();
    }

    const resizeObserver = new ResizeObserver(() => placeBox());
    resizeObserver.observe(root);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);

    /* ---- 序列化与保存 ---- */

    function serialize() {
      return new XMLSerializer().serializeToString(root);
    }

    function fileText(xml) {
      let out = xml;
      if (ctx.hadDecl && !/^\s*<\?xml\b/i.test(out)) {
        out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
      }
      if (ctx.hadBom) out = '\uFEFF' + out;
      if (ctx.trailingNewline && !/\n$/.test(out)) out += '\n';
      return out;
    }

    function setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = 'svg-status' + (cls ? ' is-' + cls : '');
    }

    function updateUndo() {
      undoBtn.disabled = !undo.length;
      redoBtn.disabled = !redo.length;
    }

    function pushUndo(xml) {
      undo.push(xml);
      if (undo.length > MAX_UNDO) undo.shift();
      redo.length = 0;
      updateUndo();
    }

    /** 当前 DOM 与磁盘不一致时排队写一次；expected 在任务真正执行时才取 */
    function save() {
      if (risky || disposed) return;
      const xml = serialize();
      if (xml === savedXml) { setStatus('已保存'); return; }
      setStatus('保存中…', 'busy');
      const payload = fileText(xml);
      queue = queue.then(async () => {
        if (disposed) return;
        let res;
        try {
          res = await pv.writeSvg(node.path, payload, expected);
        } catch (err) {
          res = { error: 'EWRITE', message: String((err && err.message) || err) };
        }
        if (disposed) return;
        if (res && res.ok) {
          savedXml = xml;
          expected = { size: res.size, mtime: res.mtime };
          setStatus('已保存');
          h.noteSaved(pane, node, { size: res.size, mtime: res.mtime });
          // 头部「磁盘上有变化」的红点要跟着灭掉
          PV.pane.renderPane(pane, false);
          return;
        }
        if (res && res.error === 'CONFLICT') {
          setStatus('保存冲突', 'error');
          h.toast('文件已在磁盘上变化，请点列头刷新后再编辑');
          return;
        }
        setStatus('保存失败', 'error');
        h.toast('保存失败：' + ((res && res.message) || (res && res.error) || '未知错误'));
      }).catch(() => {});
    }

    /* ---- 选择框 ---- */

    function placeBox() {
      if (!selected || !selected.isConnected || disposed) { box.hidden = true; return; }
      const r = selected.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      box.hidden = false;
      box.style.left = Math.round(r.left - s.left) + 'px';
      box.style.top = Math.round(r.top - s.top) + 'px';
      box.style.width = Math.max(2, Math.round(r.width)) + 'px';
      box.style.height = Math.max(2, Math.round(r.height)) + 'px';
      box.classList.toggle('has-grips', !risky && canResize(selected));
    }

    function select(el) {
      selected = el;
      if (el) wrap.focus({ preventScroll: true });
      placeBox();
    }

    /* ---- 文字编辑 ---- */

    function openInput(target) {
      if (input) commitInput();
      const r = target.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const cs = getComputedStyle(target);
      const ctm = target.getScreenCTM();
      const scale = ctm ? Math.hypot(ctm.a, ctm.b) || 1 : 1;
      const anchor = target.getAttribute('text-anchor')
        || (target.parentElement && target.parentElement.getAttribute('text-anchor')) || '';
      const el = document.createElement('input');
      el.type = 'text';
      el.className = 'svg-textinput';
      el.spellcheck = false;
      el.value = target.textContent;
      el.style.left = Math.round(r.left - s.left - 4) + 'px';
      el.style.top = Math.round(r.top - s.top - 4) + 'px';
      el.style.width = Math.max(80, Math.round(r.width + 28)) + 'px';
      el.style.height = Math.max(20, Math.round(r.height + 8)) + 'px';
      el.style.fontSize = Math.max(10, Math.round(parseFloat(cs.fontSize) * scale * 10) / 10) + 'px';
      el.style.fontFamily = cs.fontFamily;
      el.style.fontWeight = cs.fontWeight;
      el.style.fontStyle = cs.fontStyle;
      el.style.color = cs.fill && cs.fill !== 'none' ? cs.fill : cs.color;
      el.style.textAlign = anchor === 'middle' ? 'center' : (anchor === 'end' ? 'right' : 'left');
      el.addEventListener('keydown', onInputKey);
      el.addEventListener('blur', commitInput);
      stage.appendChild(el);
      input = { el: el, target: target, before: serialize() };
      el.focus();
      el.select();
    }

    function onInputKey(e) {
      // 输入框里的按键不要流到全局快捷键（尤其 Esc 会清空选中项）
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); commitInput(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancelInput(); }
    }

    function commitInput() {
      if (!input) return;
      const cur = input;
      input = null;
      const value = cur.el.value;
      cur.el.remove();
      if (value === cur.target.textContent) { placeBox(); return; }
      pushUndo(cur.before);
      cur.target.textContent = value;
      select(cur.target.closest('text') || cur.target);
      save();
    }

    function cancelInput() {
      if (!input) return;
      const el = input.el;
      input = null;
      el.remove();
      placeBox();
    }

    /* ---- 拖动与缩放 ---- */

    function toLocal(el, clientX, clientY, own) {
      const matrix = own ? el.getScreenCTM() : (el.parentElement || root).getScreenCTM();
      if (!matrix) return null;
      return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    }

    function startDrag(e, el) {
      const p = toLocal(el, e.clientX, e.clientY, false);
      if (!p) return;
      // 矩形连同框里的文字一起走；拖文字 / 其它形状时只动它自己
      const members = [{ el: el, base: el.getAttribute('transform') || '' }];
      if (el.localName === 'rect') {
        for (const t of enclosedTexts(el)) {
          members.push({ el: t, base: t.getAttribute('transform') || '' });
        }
      }
      drag = {
        el: el,
        members: members,
        pointerId: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        x: p.x,
        y: p.y,
        before: serialize(),
        moved: false
      };
      // 拖出窗口也要收到 pointerup。捕获必须设在被点的元素上，不能设在 stage：
      // 捕获到 stage 会把同一串输入里的 mouseup / click / dblclick 也重定向过去，
      // 浏览器就认为两次点击没落在文字上，双击编辑永远打不开。
      try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    }

    function onMove(e) {
      if (disposed) return;
      // 鼠标键已经松开（例如松开在窗口外没收掉）：结束这次手势，不再跟着指针走
      if (e.pointerType === 'mouse' && e.buttons === 0) { drag = null; resize = null; return; }
      if (drag && e.pointerId === drag.pointerId) {
        const p = toLocal(drag.el, e.clientX, e.clientY, false);
        if (!p) return;
        if (!drag.moved
          && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < MOVE_SLOP) return;
        if (!drag.moved) { drag.moved = true; pushUndo(drag.before); }
        const dx = p.x - drag.x;
        const dy = p.y - drag.y;
        const t = 'translate(' + fmt(dx) + ' ' + fmt(dy) + ')';
        for (const m of drag.members) {
          m.el.setAttribute('transform', m.base ? t + ' ' + m.base : t);
        }
        placeBox();
        e.preventDefault();
        return;
      }
      if (resize && e.pointerId === resize.pointerId) {
        const p = toLocal(resize.el, e.clientX, e.clientY, true);
        if (!p) return;
        if (!resize.moved
          && Math.hypot(e.clientX - resize.sx, e.clientY - resize.sy) < MOVE_SLOP) return;
        if (!resize.moved) { resize.moved = true; pushUndo(resize.before); }
        applyResize(p.x - resize.x, p.y - resize.y);
        placeBox();
        e.preventDefault();
      }
    }

    function onUp(e) {
      if (disposed) return;
      if (drag && e.pointerId === drag.pointerId) {
        const moved = drag.moved;
        drag = null;
        if (moved) save();
        return;
      }
      if (resize && e.pointerId === resize.pointerId) {
        const moved = resize.moved;
        resize = null;
        if (moved) save();
      }
    }

    function onCancel() {
      drag = null;
      resize = null;
    }

    function startResize(e, grip) {
      const el = selected;
      if (!el || !canResize(el)) return;
      const p = toLocal(el, e.clientX, e.clientY, true);
      if (!p) return;
      const rect = {
        x: numAttr(el, 'x'), y: numAttr(el, 'y'),
        w: numAttr(el, 'width'), h: numAttr(el, 'height')
      };
      resize = {
        el: el,
        handle: grip.dataset.h,
        pointerId: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        x: p.x,
        y: p.y,
        rect: rect,
        // 框内文字按「框中心移动了多少」跟着平移；居中排版的标题会自然保持居中
        texts: enclosedTexts(el).map((t) => ({ el: t, base: t.getAttribute('transform') || '' })),
        cx: rect.x + rect.w / 2,
        cy: rect.y + rect.h / 2,
        before: serialize(),
        moved: false
      };
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }

    function applyResize(dx, dy) {
      const el = resize.el;
      const hd = resize.handle;
      const base = resize.rect;
      let x = base.x;
      let y = base.y;
      let w = base.w;
      let hgt = base.h;
      if (hd.indexOf('e') >= 0) w = base.w + dx;
      if (hd.indexOf('s') >= 0) hgt = base.h + dy;
      if (hd.indexOf('w') >= 0) { x = base.x + dx; w = base.w - dx; }
      if (hd.indexOf('n') >= 0) { y = base.y + dy; hgt = base.h - dy; }
      if (w < MIN_RECT) {
        if (hd.indexOf('w') >= 0) x -= MIN_RECT - w;
        w = MIN_RECT;
      }
      if (hgt < MIN_RECT) {
        if (hd.indexOf('n') >= 0) y -= MIN_RECT - hgt;
        hgt = MIN_RECT;
      }
      el.setAttribute('x', fmt(x));
      el.setAttribute('y', fmt(y));
      el.setAttribute('width', fmt(w));
      el.setAttribute('height', fmt(hgt));
      if (resize.texts.length) {
        const dxc = (x + w / 2) - resize.cx;
        const dyc = (y + hgt / 2) - resize.cy;
        const t = 'translate(' + fmt(dxc) + ' ' + fmt(dyc) + ')';
        for (const item of resize.texts) {
          item.el.setAttribute('transform', item.base ? t + ' ' + item.base : t);
        }
      }
    }

    /* ---- 删除与撤销 ---- */

    function deleteSelected() {
      if (!selected || risky) return;
      const el = selected;
      const extra = el.localName === 'rect' ? enclosedTexts(el) : [];
      pushUndo(serialize());
      for (const t of extra) t.remove();
      el.remove();
      select(null);
      save();
      h.toast(extra.length
        ? '已删除矩形与 ' + extra.length + ' 段文字（Ctrl+Z 撤销）'
        : '已删除所选图形（Ctrl+Z 撤销）');
    }

    function restore(xml) {
      const parsed = parseSvg(xml);
      if (parsed.error) return;
      const next = parsed.root;
      root.replaceWith(next);
      root = next;
      selected = null;
      resizeObserver.disconnect();
      resizeObserver.observe(root);
      placeBox();
    }

    function undoOnce() {
      if (risky || !undo.length) return;
      const prev = undo.pop();
      redo.push(serialize());
      restore(prev);
      updateUndo();
      save();
    }

    function redoOnce() {
      if (risky || !redo.length) return;
      const next = redo.pop();
      undo.push(serialize());
      restore(next);
      updateUndo();
      save();
    }

    /* ---- 事件 ---- */

    if (!risky) {
      stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (input) commitInput();
        const grip = e.target.closest ? e.target.closest('.svg-grip') : null;
        if (grip) { wrap.focus({ preventScroll: true }); startResize(e, grip); return; }
        const shape = shapeTarget(e.target, root);
        wrap.focus({ preventScroll: true });
        if (!shape) { select(null); return; }
        select(shape);
        startDrag(e, shape);
      });

      stage.addEventListener('dblclick', (e) => {
        if (input) return;
        const target = textTarget(e.target, root) || textAtPoint(root, e.clientX, e.clientY);
        if (!target) return;
        e.preventDefault();
        openInput(target);
      });

      // 拖动 / 缩放结束后不让点击落到页面里的链接上
      stage.addEventListener('dragstart', (e) => e.preventDefault());
    }

    // 编辑模式不跟随 SVG 里的链接，避免把应用主窗口导航到外部站点
    stage.addEventListener('click', (e) => {
      const link = e.target.closest ? e.target.closest('a') : null;
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      h.toast('编辑模式里不跟随 SVG 中的链接');
    }, true);
    stage.addEventListener('auxclick', (e) => {
      if (e.target.closest && e.target.closest('a')) e.preventDefault();
    }, true);

    wrap.addEventListener('keydown', (e) => {
      if (input) return;
      const k = String(e.key || '').toLowerCase();
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); select(null); return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); e.stopPropagation(); deleteSelected(); return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.isComposing) {
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undoOnce(); return; }
        if (k === 'y' || (k === 'z' && e.shiftKey)) {
          e.preventDefault(); e.stopPropagation(); redoOnce();
        }
      }
    });

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-svg]');
      if (!btn) return;
      const act = btn.dataset.svg;
      if (act === 'undo') undoOnce();
      else if (act === 'redo') redoOnce();
      else if (act === 'zoom-in') stepZoom(1);
      else if (act === 'zoom-out') stepZoom(-1);
      else if (act === 'zoom-reset') { zoom = 0; applyZoom(); }
      else if (act === 'exit') {
        pane.svgEdit = false;
        pane.svgEditPath = '';
        PV.pane.renderPane(pane, true);
      }
    });

    if (risky) {
      setStatus('只读');
      updateUndo();
    }

    return {
      destroy: function () {
        disposed = true;
        resizeObserver.disconnect();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (input) { const el = input.el; input = null; el.remove(); }
        drag = null;
        resize = null;
      }
    };
  }

  window.PV = window.PV || {};
  PV.svgedit = { mount: mount };
})();
