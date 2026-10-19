/**
 * 高亮 Worker：在 Worker 里做一次完整分词，只把 token 结构回传主线程。
 *
 * 为什么必须在 Worker：Shiki 用的是 TextMate 语法，分词是有状态的过程
 * （跨行注释、模板字符串、多行字符串），一次大文件分词会占用几十到几百毫秒，
 * 放在主线程会卡住界面。主线程只负责把 token 渲染成可见窗口内的 DOM。
 *
 * 语言与主题都按需加载：每个 import() 在打包时会被切成独立 chunk，
 * 只有真正用到某个语言时才加载它。
 */

import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const THEME_LIGHT = 'github-light';
const THEME_DARK = 'github-dark';

const THEMES = {
  [THEME_LIGHT]: () => import('@shikijs/themes/github-light'),
  [THEME_DARK]: () => import('@shikijs/themes/github-dark')
};

const LANGS = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  html: () => import('@shikijs/langs/html'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  xml: () => import('@shikijs/langs/xml'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  dart: () => import('@shikijs/langs/dart'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  sql: () => import('@shikijs/langs/sql'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  bat: () => import('@shikijs/langs/bat'),
  lua: () => import('@shikijs/langs/lua'),
  r: () => import('@shikijs/langs/r'),
  perl: () => import('@shikijs/langs/perl'),
  graphql: () => import('@shikijs/langs/graphql'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  make: () => import('@shikijs/langs/make'),
  csv: () => import('@shikijs/langs/csv'),
  nginx: () => import('@shikijs/langs/nginx')
};

/** 超长行的门槛：超过就交给 TextMate 的跳过机制按纯文本处理，避免正则回溯爆炸 */
const MAX_TOKENIZE_LINE = 2000;

let highlighter = null;
let initPromise = null;
const loaded = new Set();
const loading = new Map();

/**
 * 初始化只做一次：onmessage 是异步的，并发请求会在 await 处交错，
 * 各自看到 highlighter === null 就会建出两个实例、互相覆盖全局引用。
 * 共享同一个 Promise 可以保证「loaded 里有的语言」一定在最终实例里。
 */
function init(firstLang) {
  if (!initPromise) {
    initPromise = createHighlighterCore({
      themes: [THEMES[THEME_LIGHT](), THEMES[THEME_DARK]()],
      langs: [LANGS[firstLang]()],
      engine: createJavaScriptRegexEngine({ forgiving: true })
    }).then((hl) => {
      highlighter = hl;
      loaded.add(firstLang);
      return hl;
    });
  }
  return initPromise;
}

/** 语言按需加载，同一个语言的并发请求也只加载一次 */
function loadLang(lang) {
  if (loaded.has(lang)) return Promise.resolve();
  let pending = loading.get(lang);
  if (!pending) {
    pending = highlighter.loadLanguage(LANGS[lang]()).then(
      () => { loaded.add(lang); loading.delete(lang); },
      (err) => { loading.delete(lang); throw err; }   // 失败不缓存，下次还能重试
    );
    loading.set(lang, pending);
  }
  return pending;
}

async function ensure(lang) {
  await init(lang);
  await loadLang(lang);
  return highlighter;
}

self.onmessage = async (event) => {
  const job = event.data || {};
  const { jobId, code, lang } = job;
  const started = performance.now();

  if (!LANGS[lang]) {
    self.postMessage({ jobId, ok: false, error: 'unsupported-language:' + lang });
    return;
  }

  try {
    const hl = await ensure(lang);
    const readyMs = performance.now() - started;
    const tokenStart = performance.now();
    const result = hl.codeToTokens(code, {
      lang,
      themes: { light: THEME_LIGHT, dark: THEME_DARK },
      defaultColor: false,
      tokenizeMaxLineLength: MAX_TOKENIZE_LINE
    });
    self.postMessage({
      jobId,
      ok: true,
      lang,
      tokens: result.tokens,
      fg: result.fg,
      bg: result.bg,
      // 分段耗时：readyMs 是语言/主题模块加载与引擎初始化，tokenizeMs 是真正的分词
      readyMs: Math.round(readyMs),
      tokenizeMs: Math.round(performance.now() - tokenStart),
      totalMs: Math.round(performance.now() - started)
    });
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: String((err && err.message) || err) });
  }
};
