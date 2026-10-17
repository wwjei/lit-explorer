/**
 * 代码高亮客户端：调度 Worker 分词、按窗口渲染 DOM、执行降级策略。
 * 方案与阈值见 docs/highlighting.md。
 *
 * 与旧实现（逐行正则）的区别：
 * - 分词在有状态的 TextMate 语法上一次性完成，跨行注释/模板字符串不会错
 * - 语言与主题按需加载，只有用到才拉对应 chunk
 * - 双主题 token 用 CSS 变量输出，切主题只换 CSS，不重新分词
 */
(function () {
  'use strict';

  const LINE_H = 20;
  const OVERSCAN = 40;
  /** 少于这个行数直接全量渲染，不做窗口化 */
  const ALL_RENDER_MAX = 500;
  /** 单行超过这个长度不参与高亮（交给 TextMate 跳过，避免正则回溯爆炸） */
  const MAX_TOKENIZE_LINE = 2000;
  /** 单行渲染上限，超出截断显示 */
  const MAX_RENDER_LINE = 20000;
  /** 超过这个大小默认不高亮 */
  const BIG_FILE = 5 * 1024 * 1024;
  /** 超过这个大小或行数，只分词前 HEAD_LINES 行 */
  const MEDIUM_FILE = 1 * 1024 * 1024;
  const MEDIUM_LINES = 50000;
  const HEAD_LINES = 3000;
  /** 单次分词输入体积上限 */
  const TOKENIZE_BUDGET = 1024 * 1024;
  /** 自动换行模式下允许的最大行数（换行后行高不定，无法窗口化） */
  const WRAP_MAX_LINES = 5000;
  const CACHE_MAX = 24;
  const TOKENIZE_TIMEOUT = 20000;

  /* ============================ 语言映射 ============================ */
  const EXT_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    json: 'json', jsonc: 'jsonc', json5: 'json',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less', styl: 'css',
    html: 'html', htm: 'html', xhtml: 'html', vue: 'vue', svelte: 'svelte',
    md: 'markdown', markdown: 'markdown',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
    properties: 'ini', env: 'ini', xml: 'xml', svg: 'xml', plist: 'xml',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    swift: 'swift', dart: 'dart', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
    cs: 'csharp', php: 'php', rb: 'ruby', sql: 'sql',
    sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'shellscript',
    ps1: 'powershell', bat: 'bat', cmd: 'bat',
    lua: 'lua', r: 'r', pl: 'perl', pm: 'perl',
    graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
    dockerfile: 'dockerfile', mk: 'make', csv: 'csv', tsv: 'csv', nginx: 'nginx'
  };

  const NAME_LANG = {
    dockerfile: 'dockerfile',
    makefile: 'make',
    'cmakelists.txt': 'make',
    'nginx.conf': 'nginx',
    'package.json': 'json',
    '.babelrc': 'json',
    '.eslintrc': 'json',
    'tsconfig.json': 'json'
  };

  /** 由文件名推断 Shiki 语言 id，未知返回 null（纯文本） */
  function langFor(name) {
    if (!name) return null;
    const lower = String(name).toLowerCase();
    if (NAME_LANG[lower]) return NAME_LANG[lower];
    const dot = lower.lastIndexOf('.');
    if (dot <= 0) return null;
    return EXT_LANG[lower.slice(dot + 1)] || null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = Number(bytes) || 0;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
  }

  /* ============================ Worker ============================ */
  let worker = null;
  let workerDead = false;
  let jobSeq = 0;
  const jobs = new Map();

  function failAll(reason) {
    for (const [, job] of jobs) job.reject(new Error(reason));
    jobs.clear();
  }

  function getWorker() {
    if (workerDead) throw new Error('高亮 Worker 不可用');
    if (worker) return worker;
    worker = new Worker('vendor/highlight-worker.js', { type: 'module' });
    worker.onmessage = (event) => {
      const data = event.data || {};
      const job = jobs.get(data.jobId);
      if (!job) return;
      jobs.delete(data.jobId);
      clearTimeout(job.timer);
      if (data.ok) job.resolve(data);
      else job.reject(new Error(data.error || '分词失败'));
    };
    worker.onerror = (event) => {
      workerDead = true;
      // 打包产物缺失或加载失败时，退回纯文本而不是白屏
      failAll('高亮模块加载失败' + (event && event.message ? '：' + event.message : ''));
      worker = null;
    };
    return worker;
  }

  function tokenize(code, lang) {
    const w = getWorker();
    const jobId = ++jobSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (jobs.delete(jobId)) reject(new Error('分词超时'));
      }, TOKENIZE_TIMEOUT);
      jobs.set(jobId, { resolve, reject, timer });
      w.postMessage({ jobId, code, lang });
    });
  }

  /* ============================ 缓存（LRU） ============================ */
  // key 不含主题：token 输出的是双主题 CSS 变量，切主题不需要重新分词
  const cache = new Map();

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  function cacheSet(key, value) {
    cache.set(key, value);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /* ============================ 降级决策 ============================ */
  function plan(text, size, force, headOverride) {
    const lines = text.split('\n');
    const lineCount = lines.length;
    let maxLen = 0;
    for (let i = 0; i < lineCount; i++) {
      if (lines[i].length > maxLen) maxLen = lines[i].length;
    }

    const base = { lines: lines, lineCount: lineCount, maxLen: maxLen, headLines: lineCount, truncated: false, canForce: false, reason: null };

    if (!force && size > BIG_FILE) {
      base.level = 'plain';
      base.reason = '文件超过 5 MB，已关闭高亮';
      base.canForce = true;
      return base;
    }

    if (maxLen > 5000) {
      base.level = 'plain';
      base.reason = '存在超长行（最长 ' + maxLen + ' 字符，可能是压缩或单行文件），已按纯文本显示';
      return base;
    }

    let head = headOverride || 0;
    if (!head) {
      head = lineCount;
      if (size > MEDIUM_FILE || lineCount > MEDIUM_LINES) head = Math.min(lineCount, HEAD_LINES);
      let chars = 0;
      for (let i = 0; i < head; i++) {
        chars += lines[i].length + 1;
        if (chars > TOKENIZE_BUDGET) { head = i; break; }
      }
    }
    base.level = 'highlight';
    base.headLines = Math.min(head, lineCount);
    base.truncated = base.headLines < lineCount;
    return base;
  }

  /* ============================ 渲染 ============================ */
  const stats = { last: null };

  function tokenHtml(token) {
    const style = token.htmlStyle;
    let attr = '';
    if (style) {
      let css = '';
      for (const key of Object.keys(style)) css += key + ':' + style[key] + ';';
      attr = ' style="' + css + '"';
    } else if (token.color) {
      attr = ' style="color:' + token.color + '"';
    }
    let cls = '';
    const fs = token.fontStyle || 0;
    if (fs & 1) cls += ' tk-i';
    if (fs & 2) cls += ' tk-b';
    if (fs & 4) cls += ' tk-u';
    return '<span' + (cls ? ' class="' + cls.trim() + '"' : '') + attr + '>' + escapeHtml(token.content) + '</span>';
  }

  /** 把一整个文件挂载成可滚动的代码视图（含降级与状态条） */
  function mount(container, options) {
    const text = String(options.text == null ? '' : options.text);
    const size = options.size || text.length;
    const lang = options.lang || null;
    const filePath = options.path || '';
    const mtime = options.mtime || 0;

    let state = plan(text, size, !!options.force, options.headLines);
    if (!lang) {
      state = Object.assign(state, { level: 'plain', reason: null, canForce: false });
    }

    const root = document.createElement('div');
    root.className = 'codeview';
    root.innerHTML =
      '<div class="cv-notice" hidden></div>' +
      '<div class="cv-scroll"><div class="cv-space"><div class="cv-win"></div></div></div>' +
      '<div class="cv-status"><span class="cv-metrics"></span>'
      + '<button class="cv-wrap" type="button">自动换行</button></div>';
    container.appendChild(root);

    const notice = root.querySelector('.cv-notice');
    const scroll = root.querySelector('.cv-scroll');
    const space = root.querySelector('.cv-space');
    const win = root.querySelector('.cv-win');
    const metrics = root.querySelector('.cv-metrics');
    const wrapBtn = root.querySelector('.cv-wrap');

    let tokens = null;
    let tokenMs = null;
    let renderMs = null;
    let jobId = 0;
    let renderStart = -1;
    let renderEnd = -1;
    let wrap = false;
    let destroyed = false;
    let frame = 0;

    if (state.lineCount > WRAP_MAX_LINES) {
      wrapBtn.disabled = true;
      wrapBtn.title = '行数过多（' + state.lineCount + ' 行），自动换行已禁用';
    }

    function buildRow(i) {
      const line = state.lines[i];
      const tooLong = line.length > MAX_RENDER_LINE;
      const lineTokens = !tooLong && tokens && i < tokens.length ? tokens[i] : null;
      let content;
      if (lineTokens && lineTokens.length) {
        let html = '';
        for (let k = 0; k < lineTokens.length; k++) html += tokenHtml(lineTokens[k]);
        content = html;
      } else {
        content = escapeHtml(tooLong ? line.slice(0, MAX_RENDER_LINE) + '…' : line);
      }
      const row = document.createElement('div');
      row.className = 'cl';
      row.innerHTML = '<span class="ln">' + (i + 1) + '</span><span class="lc">' + content + '</span>';
      return row;
    }

    function renderWindow(force) {
      if (destroyed) return;
      const total = state.lineCount;
      const viewH = scroll.clientHeight || 600;
      let start;
      let end;
      if (wrap || total <= ALL_RENDER_MAX) {
        start = 0;
        end = total;
      } else {
        start = Math.max(0, Math.floor(scroll.scrollTop / LINE_H) - OVERSCAN);
        end = Math.min(total, start + Math.ceil(viewH / LINE_H) + OVERSCAN * 2 + 2);
      }
      if (!force && start === renderStart && end === renderEnd) return;

      const t = performance.now();
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) frag.appendChild(buildRow(i));
      win.textContent = '';
      win.appendChild(frag);
      win.style.transform = wrap ? 'none' : 'translateY(' + (start * LINE_H) + 'px)';
      space.style.height = wrap ? 'auto' : (total * LINE_H) + 'px';
      renderStart = start;
      renderEnd = end;
      renderMs = performance.now() - t;
      updateStatus();
    }

    function updateStatus() {
      const parts = [state.lineCount + ' 行', fmtSize(size)];
      if (tokenMs != null) parts.push('分词 ' + tokenMs + 'ms');
      if (renderMs != null) parts.push('渲染 ' + Math.round(renderMs) + 'ms');
      if (renderEnd > renderStart) parts.push('DOM ' + (renderEnd - renderStart) + ' 行');
      parts.push(state.level === 'plain'
        ? (lang && state.canForce ? '纯文本（可手动高亮）' : '纯文本')
        : (state.truncated ? '部分高亮' : '完整高亮'));
      metrics.textContent = parts.join(' · ');
    }

    function updateNotice() {
      if (state.level === 'plain') {
        if (!state.reason) { notice.hidden = true; return; }
        notice.hidden = false;
        notice.innerHTML = '<span>' + escapeHtml(state.reason) + '</span>'
          + (state.canForce ? '<button type="button" data-force>仍然高亮</button>' : '');
        return;
      }
      if (state.truncated) {
        notice.hidden = false;
        notice.innerHTML = '<span>已高亮前 ' + state.headLines + ' 行</span>'
          + '<button type="button" data-more>继续加载</button>';
        return;
      }
      notice.hidden = true;
      notice.innerHTML = '';
    }

    function onScroll() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        renderWindow();
      });
    }

    async function run() {
      updateNotice();
      if (state.level === 'plain') {
        renderWindow(true);
        return;
      }
      const head = state.headLines;
      const headText = head >= state.lineCount ? text : state.lines.slice(0, head).join('\n');
      const key = [filePath, mtime, head, lang].join('\u0001');

      const hit = cacheGet(key);
      if (hit) {
        tokens = hit.tokens;
        tokenMs = hit.tokenizeMs;
        renderWindow(true);
        return;
      }

      const mine = ++jobId;
      try {
        const t = performance.now();
        const res = await tokenize(headText, lang);
        if (destroyed || mine !== jobId) return; // 已经切到别的文件
        tokens = res.tokens;
        tokenMs = res.tokenizeMs;
        cacheSet(key, { tokens: tokens, tokenizeMs: tokenMs });
        stats.last = {
          path: filePath, lang: lang, lines: state.lineCount, head: head,
          readyMs: res.readyMs, tokenizeMs: res.tokenizeMs, totalMs: res.totalMs,
          roundTripMs: Math.round(performance.now() - t)
        };
        renderWindow(true);
      } catch (err) {
        if (destroyed || mine !== jobId) return;
        state = Object.assign(state, {
          level: 'plain',
          reason: '高亮不可用：' + err.message,
          canForce: false
        });
        updateNotice();
        renderWindow(true);
      }
    }

    function setWrap(next) {
      if (wrap === next) return;
      wrap = next;
      root.classList.toggle('is-wrap', wrap);
      wrapBtn.classList.toggle('is-on', wrap);
      wrapBtn.setAttribute('aria-pressed', wrap ? 'true' : 'false');
      renderWindow(true);
    }

    wrapBtn.addEventListener('click', () => setWrap(!wrap));

    notice.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      // 布尔属性在 dataset 里是空字符串，必须用 hasAttribute 判断
      if (btn.hasAttribute('data-force')) {
        // 手动高亮：仍按降级阶梯处理，大文件只分词前 3000 行
        state = plan(text, size, true, 0);
        tokens = null;
        tokenMs = null;
        updateNotice();
        renderWindow(true);
        run();
      } else if (btn.hasAttribute('data-more')) {
        const next = Math.min(state.lineCount, state.headLines + HEAD_LINES);
        state = plan(text, size, true, next);
        updateNotice();
        run();
      }
    });

    scroll.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => renderWindow());
    observer.observe(scroll);

    renderWindow(true);
    run();

    return {
      destroy() {
        destroyed = true;
        jobId++;
        observer.disconnect();
        scroll.removeEventListener('scroll', onScroll);
      }
    };
  }

  /* ============================ Markdown 代码块升级 ============================ */
  /** 把 markdown 里的围栏代码块异步升级为高亮（原地替换内容，不改变布局） */
  async function highlightFences(rootEl) {
    if (!rootEl) return;
    const blocks = Array.from(rootEl.querySelectorAll('pre[data-lang]'));
    for (const pre of blocks) {
      const lang = langFor('x.' + pre.dataset.lang);
      if (!lang) continue;
      // textContent 会还原实体，拿到的是原始代码
      const code = pre.textContent || '';
      if (code.length > 200000) continue;
      try {
        const res = await tokenize(code, lang);
        if (!pre.isConnected) return;
        pre.innerHTML = '<code>' + res.tokens
          .map((line) => line.map(tokenHtml).join(''))
          .join('\n') + '</code>';
      } catch (err) {
        /* 升级失败就保留已转义的纯文本 */
      }
    }
  }

  window.PV = window.PV || {};
  window.PV.highlight = {
    mount: mount,
    highlightFences: highlightFences,
    langFor: langFor,
    escapeHtml: escapeHtml,
    LINE_H: LINE_H,
    /** 最近一次分词的分段耗时，供性能核对使用 */
    stats: stats
  };
})();
