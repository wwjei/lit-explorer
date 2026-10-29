/* 预览正文与头部：画成什么样
 *
 * 窗格「什么时候画、画到哪一列」由 pane.js 管（PV.pane）；这个文件只管正文与头部
 * 画成什么样，由 app.js 通过 PV.body.init() 注入进窗格。正文一律通过任务对象写
 * （task.write / task.replace）：晚到的旧响应写不进去，所以下面每个分支都不用自己
 * 检查「我是不是还属于当前那次」。
 *
 * 分派是一张有序的 RENDERERS 表（见「正文分派」）：每个渲染器声明 match / key /
 * render，正文与内容身份都从同一处判断。pane.js 与头部按钮只问 capabilities()，
 * 不再自己认 node.kind；加一种格式只改本文件。
 *   Markdown → 手写渲染器（markdown.js），源码视图走代码视图
 *   HTML / PDF / 图片 / SVG → 交给 pv:// 协议地址，直接由 iframe 或 <img> 渲染
 *   SVG 编辑模式 → 交给 svgedit.js（可编辑 DOM、自动保存）
 *   docx / pptx → 首次打开时按需加载 vendor/docpreview.js（约 1.4 MB），再整份字节解析
 *   其余 → 代码视图（分词在 Worker 里做，主线程只渲染可见窗口）
 *
 * 需要外面提供的东西（都是「本模块不该自己拿主意」的）：
 *   root()            工作区根目录（头部副标题显示相对路径）
 *   previewPrefs()    Word / PPT 内嵌预览是否开着（进内容身份，设置里可关）
 *   itemsInDir(dir)   某个目录当前的条目（连续预览的顺序要跟栏内一致）
 *   toast(msg)        轻提示
 *   setMeta(metas)    主进程异步补发的 size / mtime
 *
 * 网页预览（kind = 'web'）不在这里画页面：正文只放加载 / 失败卡片，真正的页面由
 * 主进程的 WebContentsView 覆盖在窗格正文上（见 webview.js 与 main/web-views.js）。
 *
 * 加载顺序：shared/contracts.js → paths.js → icons.js → highlight.js → markdown.js →
 *           pane.js → preview-body.js → webview.js → svgedit.js → find.js → projects.js → app.js。
 *           vendor/docpreview.js 不在这里：第一次打开 docx / pptx 时由 loadDocPreview() 注入。
 */
(function () {
  'use strict';

  const { icon, nodeIcon } = PV.icons;
  const { escapeHtml: esc } = PV.highlight;
  const mdToHtml = PV.markdown.toHtml;

  const hooks = {
    canWrite: function () { return true; },
    root: function () { return ''; },
    previewPrefs: function () { return { docx: true, pptx: true }; },
    itemsInDir: function () { return null; },
    toast: function () {},
    /** 正文真的落地后上报显示版本（路径 / size / mtime），变更监测拿它当基线 */
    loaded: function () {},
    openLocal: async function () {}
  };

  /** 路径 -> { size, mtime }，由主进程异步补发 */
  const meta = new Map();

  /* ============================ 类型能力 ============================ *
   * 窗格（pane.js）与头部按钮只问「这个节点能做什么」，不再自己判断 node.kind。
   * 加一种格式时只改这里和下面的 RENDERERS，别让类型知识再漏回布局模块。
   * ------------------------------------------------------------------ */
  function isImageNode(node) {
    return !!node && !node.isDir && (node.kind === 'image' || node.kind === 'svg');
  }

  function capabilities(node, mode) {
    const preview = mode === 'preview';
    const kind = node && !node.isDir ? node.kind : '';
    return {
      image: isImageNode(node),
      continuous: preview && isImageNode(node),
      svgEdit: preview && kind === 'svg' && hooks.canWrite(node),
      source: kind === 'html' || kind === 'md' || kind === 'svg'
    };
  }

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
    const root = hooks.root();
    if (!root || !node) return '';
    return PV.paths.relUnder(root, node.path);
  }

  /* ============================ 状态卡片与外壳 ============================ */

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

  /* ============================ docx / pptx ============================ */

  /**
   * vendor/docpreview.js 是 1.4 MB 的打包产物。它不是每次启动都需要：
   * 第一次真的打开 Word / PPT 时再注入 <script>，之后共用同一个 Promise。
   * 构建缺失或加载失败时返回 null，调用方落兜底卡片。
   */
  let docPreviewLoading = null;

  function loadDocPreview() {
    if (PV.docpreview) return Promise.resolve(PV.docpreview);
    if (docPreviewLoading) return docPreviewLoading;
    docPreviewLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'vendor/docpreview.js';
      s.async = true;
      // 失败后允许下次再试（开发时先开文档、后跑 build 的常见顺序）
      s.onload = () => {
        if (PV.docpreview) { resolve(PV.docpreview); return; }
        docPreviewLoading = null;
        resolve(null);
      };
      s.onerror = () => { docPreviewLoading = null; resolve(null); };
      document.head.appendChild(s);
    });
    return docPreviewLoading;
  }

  /** docx / pptx：整份字节读进渲染进程，交给按需加载的纯前端解析器 */
  async function renderDocPreview(pane, node, kind, task) {
    task.write(loadingState('正在解析 ' + (kind === 'docx' ? 'Word' : 'PowerPoint') + ' 文档…'));
    const docpreview = await loadDocPreview();
    if (!docpreview) {
      task.write(fallbackCard(node, '预览组件未构建：请先运行 npm run build'));
      return;
    }
    // 等脚本的这段时间里用户可能已经切走了，别再白读整份文件
    if (task.stale) return;
    const res = await pv.readBytes(node.path);
    if (res.error) { task.write(fallbackCard(node, '读取失败：' + res.error)); return; }
    if (res.tooLarge) {
      task.write(fallbackCard(node, '文件较大（' + fmtSize(res.size) + '），暂不内嵌预览'));
      return;
    }

    const raw = res.data;
    let buf = raw;
    if (raw instanceof Uint8Array) buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    else if (raw && raw.type === 'Buffer' && Array.isArray(raw.data)) buf = new Uint8Array(raw.data).buffer;

    const wrap = document.createElement('div');
    wrap.className = 'docview';
    if (!task.replace(wrap)) return;
    try {
      if (kind === 'docx') await docpreview.renderDocx(buf, wrap);
      else await docpreview.renderPptx(buf, wrap);
    } catch (err) {
      console.error('[docpreview]', err);
      // 失败卡片也要先看这次渲染是不是已经被取代：用户可能已经切走了，
      // 这时候写进去会盖掉新文件的预览
      task.write(fallbackCard(node, '预览失败：' + ((err && err.message) || err)));
      return;
    }
    noteLoaded(pane, node, { size: res.size }, task);
  }

  /* ============================ 头部与内容身份 ============================ */

  /** 源码视图用的语言 id：按当前窗格的模式取，未知语言返回 null（纯文本） */
  function langForNode(node, mode) {
    if (mode === 'source') {
      if (node.kind === 'md') return 'markdown';
      if (node.kind === 'html') return 'html';
      if (node.kind === 'svg') return 'xml';
    }
    return PV.highlight.langFor(node.name);
  }

  /** 网页列加载失败：视图已经藏起来，正文给一张能重试 / 外开的卡片 */
  function webErrorCard(node) {
    const err = node.webError || {};
    const detail = err.code === 'RENDER_GONE'
      ? '网页进程已退出，可以重新加载或改用浏览器打开。'
      : '无法在应用内加载这个页面'
        + (err.code ? '（' + err.code + '）' : '')
        + (err.desc ? '：' + err.desc : '') + '。';
    return '<div class="state">'
      + '<div class="big">' + icon('globe', '', 26) + '</div>'
      + '<h4>' + esc(node.name) + '</h4>'
      + '<p>' + esc(detail) + '</p>'
      + '<p class="web-fail-url">' + esc(node.url) + '</p>'
      + '<div class="state-action">'
      + '<button class="btn-quiet" data-act="web-reload">' + icon('refresh', '', 14)
      + '<span>重新加载</span></button>'
      + '<button class="btn-quiet" data-act="external">' + icon('external', '', 14)
      + '<span>在浏览器中打开</span></button>'
      + '</div></div>';
  }

  /**
   * 网页列的头部：标题是用户起的名字，副标题显示当前地址（站内跳转后会更新）。
   * 没有「在资源管理器中显示」，在浏览器中打开保留为兜底出口。
   */
  function webHeadHtml(pane, node) {
    const shown = node.webCurrentUrl || node.url;
    const facts = ['网页'];
    if (node.webError) facts.push('加载失败');
    return '<span class="pv-ic">' + nodeIcon(node, 17) + '</span>'
      + '<div class="pv-name"><button type="button" data-act="copy-path" class="pv-nm" title="' + esc(shown + ' · ' + facts.join(' · ')) + '">' + esc(node.name) + '</button>'
      + '<div class="pv-sub"><button type="button" class="pv-path" data-act="copy-path" title="单击复制链接：'
      + esc(shown) + '">' + esc(shown) + '</button>'
      + '<span class="pv-facts"> · ' + esc(facts.join(' · ')) + '</span></div></div>'
      + '<div class="pv-actions"><div class="pv-btns">'
      + '<button class="iconbtn web-ext" data-act="external" title="在浏览器中打开">'
      + icon('external', '', 15) + '</button>'
      + '<button class="iconbtn pinbtn' + (pane.pinned ? ' is-on' : '') + '" data-act="pin" title="'
      + (pane.pinned ? '取消固定' : '固定此预览') + '" aria-label="固定预览">'
      + icon(pane.pinned ? 'pinFilled' : 'pin', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="close" title="' + (pane.pinned ? '关闭此预览列' : '收起预览') + '">'
      + icon('close', '', 15) + '</button>'
      + '</div></div>';
  }

  /** 窗格头部：元信息会异步补发，所以每次渲染都整块重建 */
  function paneHeadHtml(pane, node) {
    if (node.kind === 'web') return webHeadHtml(pane, node);
    const m = meta.get(node.path);
    const pathText = subPath(node) || node.name;
    const facts = [String(node.kind || '').toUpperCase()];
    if (m) { facts.push(fmtSize(m.size)); facts.push(fmtTime(m.mtime)); }
    if (pane.continuous) facts.push('连续预览');

    const mode = PV.pane.modeOf(pane);
    const caps = capabilities(node, mode);
    const canSource = caps.source;
    const seg = canSource
      ? '<div class="pv-seg"><div class="seg">'
        + '<button data-mode="preview" class="' + (mode === 'preview' ? 'is-on' : '') + '">预览</button>'
        + '<button data-mode="source" class="' + (mode === 'source' ? 'is-on' : '') + '">源码</button>'
        + '</div></div>'
      : '';

    // 图片：− [适应/150%] + 的缩放档位，以及进入连续预览的向下箭头
    // （SVG 进入编辑模式后正文是可编辑 DOM，缩放 / 连续预览让位）
    const imageBar = (caps.continuous && !pane.svgEdit)
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

    // SVG 可以进编辑模式：改文字、拖动、缩放矩形、删除形状（编辑模式会自己保存）
    const svgBtn = caps.svgEdit
      ? '<button class="iconbtn svgbtn' + (pane.svgEdit ? ' is-on' : '') + '" data-act="svg-edit" title="'
        + (pane.svgEdit ? '完成编辑' : '编辑文字与形状') + '" aria-label="编辑 SVG">'
        + icon('pencil', '', 15) + '</button>'
      : '';

    // 图钉 / 刷新 / 关闭放在最右，低频的排在左边；复制路径改成点标题下的路径
    return '<span class="pv-ic">' + nodeIcon(node, 17) + '</span>'
      + '<div class="pv-name"><button type="button" data-act="copy-path" class="pv-nm" title="' + esc(node.path + ' · ' + facts.join(' · ')) + '">' + esc(node.name) + '</button>'
      + '<div class="pv-sub"><button type="button" class="pv-path" data-act="copy-path" title="单击复制文件路径：'
      + esc(node.path) + '">' + esc(pathText) + '</button>'
      + '<span class="pv-facts"> · ' + esc(facts.join(' · ')) + '</span></div></div>'
      + '<div class="pv-actions">' + seg + imageBar
      + '<div class="pv-btns">'
      + '<button class="iconbtn" data-act="reveal" title="在资源管理器中显示">' + icon('reveal', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="external" title="用默认程序打开">' + icon('external', '', 15) + '</button>'
      + svgBtn
      + '<button class="iconbtn pinbtn' + (pane.pinned ? ' is-on' : '') + '" data-act="pin" title="'
      + (pane.pinned ? '取消固定' : '固定此预览') + '" aria-label="固定预览">'
      + icon(pane.pinned ? 'pinFilled' : 'pin', '', 15) + '</button>'
      + '<button class="iconbtn" data-act="close" title="' + (pane.pinned ? '关闭此预览列' : '收起预览') + '">'
      + icon('close', '', 15) + '</button>'
      + '</div></div>';
  }

  /**
   * 内容身份：说明「该显示什么」。同一个文件重新读取时它不变，所以只靠它分不出
   * 前后两次请求——那件事交给窗格的任务身份（reqId）。
   */
  function bodyKeyFor(pane, node, mode) {
    // 谁来渲染也属于内容身份：设置里换了解析方式（如 docx 回落到代码视图）必须重渲染
    const renderer = pickRenderer(pane, node, mode);
    if (!renderer) return [node.path, mode, 'none'].join('\u0001');
    // 网页的身份只有地址：加载失败 / 重新加载都靠强制重渲染，不靠 key 变化
    if (renderer.key) return renderer.key(pane, node, mode);
    return [node.path, mode, renderer.id, pane.continuous ? 'seq' : ''].join('\u0001');
  }

  /* ============================ 正文分派 ============================ */

  /**
   * 正文真的落地了才记版本基线。晚到的旧读取（同一文件被重新读取取代）
   * 不应该把基线拉回旧值，否则下一次轮询会误报「有变化」。
   */
  function noteLoaded(pane, node, info, task) {
    if (task && task.stale) return;
    hooks.loaded(pane, node, info || null);
  }

  /**
   * 图片解码失败（远程图挂了 / 文件其实不是图片）时换成占位，别在正文里
   * 留一个碎图标。error 事件不冒泡，所以逐张挂；已经失败过的立刻换。
   */
  function markBrokenImages(pane) {
    const swap = (img) => {
      const src = img.getAttribute('src') || '';
      const span = document.createElement('span');
      span.className = 'md-img-missing';
      span.title = '图片无法显示：' + src;
      span.appendChild(document.createTextNode(img.alt || src || '图片无法显示'));
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = '无法显示';
      span.appendChild(why);
      // 晚到的错误可能来自已经被换掉的旧正文：没有父节点时 replaceWith 是空操作
      img.replaceWith(span);
    };
    for (const img of pane.body.querySelectorAll('.prose img')) {
      if (img.complete && !img.naturalWidth) swap(img);
      else img.addEventListener('error', () => swap(img), { once: true });
    }
  }

  /* ============================ 正文分派 ============================ *
   * 一张有序表：match 决定接不接，key 决定内容身份，render 决定画什么。
   * 顺序就是优先级；最后一个 text 渲染器兜底，所以它永远接得住。
   * ------------------------------------------------------------------ */

  /** 读文本类内容；失败 / 二进制直接落卡片并返回 null，调用方不用各写一遍 */
  async function readTextNode(ctx) {
    const { node, task } = ctx;
    task.write(loadingState());
    const res = await pv.read(node.path);
    if (res.error) {
      task.write(fallbackCard(node, res.error === 'IS_DIR' ? '这是一个目录' : '读取失败：' + res.error));
      return null;
    }
    if (res.binary) {
      task.write(fallbackCard(node, '该类型暂不支持内嵌预览'));
      return null;
    }
    const notice = [];
    if (res.truncated) notice.push('文件较大，仅显示前 5 MB');
    if (res.lossy) notice.push('编码无法识别，可能存在乱码');
    res.noticeHtml = notice.length ? '<div class="notice">' + notice.join(' · ') + '</div>' : '';
    return res;
  }

  async function renderMarkdown(ctx) {
    const { pane, node, task } = ctx;
    const res = await readTextNode(ctx);
    if (!res) return;

    // 本地图片先由主进程解析成 pv:// 地址再渲染：正文是整块替换，
    // 晚到的解析结果会被 task.write 的归属检查丢掉，不用另做一套。
    const images = new Map();
    const srcs = PV.markdown.imageSources(res.text);
    if (srcs.length) {
      const resolved = await pv.resolveImages(node.path, srcs);
      for (const item of (resolved && resolved.items) || []) images.set(item.src, item);
    }
    if (!task.write(res.noticeHtml + '<div class="prose-wrap"><article class="prose">'
      + mdToHtml(res.text, images) + '</article></div>')) return;
    noteLoaded(pane, node, { size: res.size, mtime: res.mtime }, task);
    PV.highlight.highlightFences(pane.body.querySelector('.prose'));
    markBrokenImages(pane);
    pane.body.querySelector('.prose').addEventListener('click', (event) => {
      const a = event.target.closest('a');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || /^(https?:|mailto:)/i.test(href)) return;
      event.preventDefault();
      if (href.startsWith('#')) return;
      hooks.openLocal(node.path, href).catch((err) => hooks.toast('无法打开链接：' + err.message));
    });
  }

  async function renderText(ctx) {
    const { pane, node, mode, task } = ctx;
    const res = await readTextNode(ctx);
    if (!res) return;

    // 其余一律走代码视图：分词在 Worker 里做，主线程只渲染可见窗口
    if (!task.write(res.noticeHtml)) return;
    noteLoaded(pane, node, { size: res.size, mtime: res.mtime }, task);
    pane.view = PV.highlight.mount(pane.body, {
      text: res.text,
      size: res.size,
      mtime: res.mtime,
      path: node.path,
      lang: langForNode(node, mode)
    });
  }

  function renderWeb(ctx) {
    const { node, task } = ctx;
    // 正文只是加载 / 失败卡片，真实页面由主进程的 WebContentsView 盖在上面
    if (node.webError) { task.write(webErrorCard(node)); return; }
    task.write(loadingState('正在打开网页…'));
  }

  /** 交给 pv:// 协议地址直接渲染的几种类型共用这一步 */
  async function previewUrlFor(ctx) {
    const { pane, node, task } = ctx;
    task.write(loadingState());
    const res = await pv.previewUrl(node.path);
    if (!res.url) { task.write(fallbackCard(node, '无法生成预览地址')); return ''; }
    // 这几类不走 fs:read，拿不到读取时的 size / mtime，交给外部补一次 stat
    noteLoaded(pane, node, null, task);
    return res.url;
  }

  async function renderHtml(ctx) {
    const url = await previewUrlFor(ctx);
    if (url) ctx.task.write(browserChrome(ctx.node, url));
  }

  async function renderPdf(ctx) {
    const url = await previewUrlFor(ctx);
    if (url) ctx.task.write(pdfFrame(ctx.node, url));
  }

  async function renderImage(ctx) {
    const { pane, node, task } = ctx;
    const url = await previewUrlFor(ctx);
    if (!url) return;
    if (pane.continuous) { await renderImageSeq(pane, node, task); return; }
    renderImageView(pane, node, url, task);
  }

  function renderSvgEdit(ctx) {
    // 正文是可交互的 SVG DOM（解析、清洗、保存都在 svgedit.js）
    return PV.svgedit.mount(ctx.pane, ctx.node, ctx.task, {
      toast: hooks.toast,
      noteSaved: noteLoaded
    });
  }

  function renderDocx(ctx) { return renderDocPreview(ctx.pane, ctx.node, 'docx', ctx.task); }
  function renderPptx(ctx) { return renderDocPreview(ctx.pane, ctx.node, 'pptx', ctx.task); }

  const RENDERERS = [
    { id: 'web', match: function (p, n) { return n.kind === 'web'; },
      key: function (p, n) { return 'web\u0001' + n.url; }, render: renderWeb },
    { id: 'svg-edit', match: function (p, n, m) { return m === 'preview' && n.kind === 'svg' && p.svgEdit; },
      render: renderSvgEdit },
    { id: 'html', match: function (p, n, m) { return m === 'preview' && n.kind === 'html'; }, render: renderHtml },
    { id: 'pdf', match: function (p, n, m) { return m === 'preview' && n.kind === 'pdf'; }, render: renderPdf },
    { id: 'image', match: function (p, n, m) { return m === 'preview' && isImageNode(n); }, render: renderImage },
    { id: 'docx', match: function (p, n) { return n.kind === 'docx' && hooks.previewPrefs().docx; },
      render: renderDocx },
    { id: 'pptx', match: function (p, n) { return n.kind === 'pptx' && hooks.previewPrefs().pptx; },
      render: renderPptx },
    { id: 'markdown', match: function (p, n, m) { return n.kind === 'md' && m === 'preview'; },
      render: renderMarkdown },
    // 兜底：二进制会由 readTextNode 落成兜底卡片，源码视图也走这里
    { id: 'text', match: function () { return true; }, render: renderText }
  ];

  function pickRenderer(pane, node, mode) {
    for (let i = 0; i < RENDERERS.length; i++) {
      if (RENDERERS[i].match(pane, node, mode)) return RENDERERS[i];
    }
    return null;
  }

  async function renderPaneBody(pane, node, mode, key, task) {
    // node 为 null：临时预览列被清空（换工作区），正文回到「未选择文件」
    if (!node) { task.write(emptyState()); return; }
    const renderer = pickRenderer(pane, node, mode);
    if (!renderer) { task.write(fallbackCard(node, '该类型暂不支持内嵌预览')); return; }
    try {
      await renderer.render({ pane: pane, node: node, mode: mode, key: key, task: task });
    } catch (err) {
      // 单个渲染器失败只坏这一个窗格：换成带原因的兜底卡片，其他窗格继续
      console.error('[preview] ' + renderer.id, err);
      task.write(fallbackCard(node, '预览失败：' + ((err && err.message) || err)));
    }
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
      stepZoom(PV.pane.paneOf(host) || pane, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  /** 只造 <img> 并挂好缩放回调；是否进 pane.images 由调用方在正文落地后再决定 */
  function newImage(pane, node, url, lazy) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = node.name;
    img.draggable = false;
    if (lazy) img.loading = 'lazy';
    // 图片可能已经跟着内容搬到了别的窗格，缩放要落在它现在那一列上
    img.addEventListener('load', () => applyZoom(PV.pane.paneOf(img) || pane));
    return img;
  }

  function renderImageView(pane, node, url, task) {
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    const img = newImage(pane, node, url, false);
    wrap.appendChild(img);
    // 晚到的旧请求不能改 pane.images：那会让缩放落到一张已经不在 DOM 里的图上
    if (!task.replace(wrap)) return;
    pane.images = [img];
    applyZoom(pane);
    bindZoomWheel(pane, wrap);
  }

  /**
   * 同目录里的图片。顺序与栏内一致（搜索过滤也算），所以优先问栏要条目；
   * 这个目录没开在栏里（固定列可能指向别处）时直接问一次文件系统。
   */
  async function imageSequence(node) {
    const dir = node.path.replace(/[\\/][^\\/]*$/, '');
    let entries = hooks.itemsInDir(dir);
    if (!entries) {
      const res = await pv.list(dir);
      entries = res && res.entries ? res.entries.slice() : [];
      entries.sort(PV.paths.compareNodes);
    }
    return entries.filter(isImageNode);
  }

  async function renderImageSeq(pane, node, task) {
    const seq = await imageSequence(node);
    if (task.stale) return;

    let at = seq.findIndex((e) => e.path === node.path);
    if (at < 0) at = 0;
    const rest = seq.slice(at);
    const shown = rest.slice(0, SEQ_MAX);

    const urls = await Promise.all(shown.map((e) => pv.previewUrl(e.path)));
    if (task.stale) return;

    const imgs = [];
    const box = document.createElement('div');
    box.className = 'imgseq';
    for (let i = 0; i < shown.length; i++) {
      const fig = document.createElement('figure');
      fig.className = 'imgseq-item' + (shown[i].path === node.path ? ' is-current' : '');
      fig.dataset.path = shown[i].path;
      if (urls[i] && urls[i].url) {
        const img = newImage(pane, shown[i], urls[i].url, i > 0);
        imgs.push(img);
        fig.appendChild(img);
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
    if (!task.replace(box)) return;
    pane.images = imgs;
    applyZoom(pane);
    bindZoomWheel(pane, box);
    box.scrollTop = 0;
  }

  function toggleSeq(pane) {
    pane.continuous = !pane.continuous;
    hooks.toast(pane.continuous ? '连续预览：向下滚动看同目录后面的图片' : '已退出连续预览');
    PV.pane.renderPane(pane, true);
  }

  window.PV = window.PV || {};
  PV.body = {
    /** app.js 注入 root / previewPrefs / itemsInDir / toast */
    init: function (h) { Object.assign(hooks, h); },

    /** 主进程补发的 size / mtime（头部副标题与兜底卡片要用） */
    setMeta: function (metas) {
      for (const key of Object.keys(metas || {})) {
        if (metas[key]) meta.set(key, metas[key]);
      }
    },

    /* 交给窗格模块的三个口子 */
    head: paneHeadHtml,
    render: renderPaneBody,
    key: bodyKeyFor,

    /** 窗格与头部按钮问「这个节点能做什么」，不要自己判断 node.kind */
    capabilities: capabilities,

    /** 按需加载 docx / pptx 解析器（首次打开文档时才会真正注入） */
    loadDocPreview: loadDocPreview,

    /* 顶部按钮分派用 */
    setZoom: setZoom,
    stepZoom: stepZoom,
    toggleSeq: toggleSeq
  };
})();
