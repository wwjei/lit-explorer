'use strict';

/**
 * 文件系统访问层：读操作 + 一个收得很窄的 SVG 编辑保存入口。
 * 所有对外路径都会先经过 assertAllowed() 校验，比较的是「真实路径」——
 * 指向工作区之外的符号链接 / junction 也越不过这条边界。
 *
 * 唯一的写能力是 writeSvgFile：只能覆盖已授权工作区内、已经存在的 `.svg`，
 * 调用方要带上读取时的 size / mtime（磁盘上变了就拒绝），先写临时文件再 rename。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

/** 允许访问的根目录集合（由主进程在打开工作区时登记） */
const allowedRoots = new Set();

/**
 * 主进程「给过」渲染进程的候选目录（示例项目、最近打开、上次的工作区、已打开过的）。
 * 渲染进程请求打开工作区时只认这份名单——它不能凭一个自己拼出来的路径，把任意现存
 * 目录登记成新的授权根。这拦不住已经在合法宿主页面里跑起来的脚本（那要靠预览侧的
 * 注入防线），但它去掉了「注入之后顺手把 C:\ 变成工作区」这条放大路径。
 */
const offeredRoots = new Set();

/** 文本预览上限：超过则只读前 5 MB 并标记截断 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** docx/pptx 要整份交给渲染进程解析，超过这个大小就不内嵌预览（IPC 也要拷贝一份） */
const MAX_DOC_BYTES = 25 * 1024 * 1024;

/** SVG 编辑保存上限（按 UTF-8 字节算）：序列化后的文本不该比这更大 */
const MAX_SVG_WRITE_BYTES = 20 * 1024 * 1024;

/** 判二进制时检查的头部长度 */
const SNIFF_BYTES = 8192;

const KIND_BY_EXT = {
  html: ['html', 'htm', 'xhtml'],
  md: ['md', 'markdown', 'mdx'],
  docx: ['docx'],
  pptx: ['pptx'],
  pdf: ['pdf'],
  js: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'],
  json: ['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml', 'plist'],
  css: ['css', 'scss', 'sass', 'less', 'styl'],
  svg: ['svg'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'],
  txt: ['txt', 'log', 'text', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'properties', 'env',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'py', 'rb', 'go', 'rs',
    'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'r',
    'pl', 'dart', 'gradle', 'lock', 'map']
};

const KIND_BY_NAME = {
  dockerfile: 'txt',
  makefile: 'txt',
  'cmakelists.txt': 'txt',
  license: 'txt',
  licence: 'txt',
  readme: 'txt',
  changelog: 'txt',
  notice: 'txt',
  procfile: 'txt',
  '.gitignore': 'txt',
  '.gitattributes': 'txt',
  '.npmrc': 'txt',
  '.editorconfig': 'txt',
  '.env': 'txt',
  '.babelrc': 'json',
  '.eslintrc': 'json'
};

const EXT_KIND = (() => {
  const map = Object.create(null);
  for (const [kind, exts] of Object.entries(KIND_BY_EXT)) {
    for (const ext of exts) map[ext] = kind;
  }
  return map;
})();

/** 这些扩展名不必读内容即可判定为二进制，避免为了嗅探去读大文件 */
const BINARY_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'exe', 'dll', 'so',
  'dylib', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'flac', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'pdf', 'doc', 'docx',
  'xls', 'xlsx', 'ppt', 'pptx', 'class', 'jar', 'pyc', 'o', 'obj', 'lib', 'node', 'wasm',
  'iso', 'dmg', 'psd', 'ai', 'sketch', 'apk', 'ipa']);

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonc: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf'
};

/** 按文件名推断类型，用于选择预览渲染器与图标 */
function kindFor(name) {
  const ext = path.extname(name).toLowerCase().replace(/^\./, '');
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  const byName = KIND_BY_NAME[name.toLowerCase()];
  if (byName) return byName;
  return 'txt';
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return MIME[ext] || 'application/octet-stream';
}

/** Windows 路径比较不区分大小写 */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** abs 是否在 root 之内（按路径分段，不用裸前缀比较，避免 C:\a 匹配到 C:\ab） */
function within(root, abs) {
  if (samePath(root, abs)) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return process.platform === 'win32'
    ? abs.toLowerCase().startsWith(prefix.toLowerCase())
    : abs.startsWith(prefix);
}

/**
 * 取路径的真实位置：能 realpath 就 realpath，路径还不存在时解析最长的已存在前缀，
 * 再把剩下的部分接回去（这样也能为「将来要创建的文件」做校验）。
 * 只做字符串前缀判断挡不住 junction / 符号链接——它们会指向根目录之外，
 * 而后续的读写由文件系统跟随链接，所以必须比较真实路径。
 */
async function realPath(target) {
  const abs = path.resolve(target);
  let probe = abs;
  const tail = [];
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return abs;   // 退到盘符根仍不存在，按原样返回
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** 登记一个工作区根目录，存的是真实路径 */
async function allowRoot(dir) {
  if (!dir) return null;
  const real = await realPath(dir);
  allowedRoots.add(real);
  return real;
}

/**
 * 登记一个已经解析成真实路径的根（同步）。
 * 给「先异步解析、再原子地清空 + 登记」的调用方用，避免两次切换交错时各自留下一个根。
 */
function allowResolvedRoot(real) {
  if (real) allowedRoots.add(real);
  return real;
}

function allowedRootList() {
  return Array.from(allowedRoots);
}

/**
 * 清空已授权根，切换工作区时调用：读权限只跟着当前打开的那个工作区走，
 * 否则在 A 里打开过的目录，切到 B 之后照样可读。
 * 不动 offeredRoots —— 那是「渲染进程可以请求打开哪些目录」（含最近打开列表），
 * 属于另一个问题，清了会让最近打开失效。
 */
function resetAllowedRoots() {
  allowedRoots.clear();
}

/** 把某个目录提供给渲染进程时登记一下；返回原值，方便链式使用 */
function offerRoot(dir) {
  if (dir) offeredRoots.add(path.resolve(dir));
  return dir;
}

/** 渲染进程请求打开的这个目录，是不是主进程给过的 */
function isOfferedRoot(dir) {
  if (!dir) return false;
  const abs = path.resolve(String(dir));
  for (const p of offeredRoots) {
    if (samePath(p, abs)) return true;
  }
  return false;
}

function offeredRootList() {
  return Array.from(offeredRoots);
}

function isInsideAnyRoot(abs) {
  for (const root of allowedRoots) {
    if (within(root, abs)) return true;
  }
  return false;
}

/** 路径的真实位置必须在某个已授权根目录内，否则抛错；返回真实路径供调用方使用 */
async function assertAllowed(target) {
  const abs = await realPath(target);
  if (isInsideAnyRoot(abs)) return abs;
  const err = new Error('路径不在已授权的工作区内：' + abs);
  err.code = 'EACCES_ROOT';
  throw err;
}

function isDirEntry(dirent) {
  return dirent.isDirectory();
}

/** 读取一层目录（只做 readdir，不做 stat，保证大目录首屏足够快） */
async function listDir(dir) {
  const abs = await assertAllowed(dir);
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  const symlinks = [];

  for (const dirent of dirents) {
    let isDir = isDirEntry(dirent);
    if (dirent.isSymbolicLink()) symlinks.push(dirent.name);
    entries.push({
      name: dirent.name,
      path: path.join(abs, dirent.name),
      isDir,
      kind: isDir ? 'folder' : kindFor(dirent.name),
      link: dirent.isSymbolicLink()
    });
  }

  // 符号链接需要额外 stat 才能判断指向目录还是文件（数量通常极少）
  await Promise.all(symlinks.map(async (name) => {
    const entry = entries.find((e) => e.name === name);
    try {
      const st = await fsp.stat(entry.path);
      entry.isDir = st.isDirectory();
      entry.kind = entry.isDir ? 'folder' : kindFor(name);
      // 指向工作区之外的链接照样会被列出来，但点进去必然被 assertAllowed 挡住。
      // 标成不可进入，别让它以普通目录的样子出现、点一下才报错。
      if (!isInsideAnyRoot(await realPath(entry.path))) entry.blocked = true;
    } catch {
      entry.broken = true;
    }
  }));

  return { dir: abs, entries };
}

/** 并发受限的批量 stat，用于补全大小与修改时间 */
async function statEntries(dir, entries, concurrency = 24) {
  const abs = await assertAllowed(dir);
  const metas = Object.create(null);
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        const st = await fsp.stat(path.join(abs, entry.name));
        metas[entry.path] = { size: st.size, mtime: st.mtimeMs };
      } catch {
        metas[entry.path] = null;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length || 1) }, worker)
  );
  return metas;
}

function looksBinary(buf) {
  const head = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));
  if (head.includes(0)) return true;
  let control = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return head.length > 0 && control / head.length > 0.3;
}

/** 读取文件内容用于预览：超长截断、二进制识别、编码兜底 */
async function readFileForPreview(filePath) {
  const abs = await assertAllowed(filePath);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) return { error: 'IS_DIR' };

  const size = st.size;
  const ext = path.extname(abs).toLowerCase().replace(/^\./, '');
  if (BINARY_EXT.has(ext)) {
    return { binary: true, size, mtime: st.mtimeMs, path: abs };
  }

  const readLen = Math.min(size, MAX_TEXT_BYTES);
  const handle = await fsp.open(abs, 'r');
  let buf;
  try {
    buf = Buffer.alloc(readLen);
    await handle.read(buf, 0, readLen, 0);
  } finally {
    await handle.close();
  }

  if (looksBinary(buf)) {
    return { binary: true, size, mtime: st.mtimeMs, path: abs };
  }

  let text = buf.toString('utf8');
  // UTF-8 解码出现替换字符时，尝试用系统常见的 GBK 兜底（中文 Windows 场景）
  let lossy = false;
  let encoding = 'utf8';
  if (text.includes('\uFFFD')) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf);
      if (!gbk.includes('\uFFFD')) { text = gbk; encoding = 'gbk'; }
      else lossy = true;
    } catch {
      lossy = true;
    }
  }

  return {
    text,
    size,
    mtime: st.mtimeMs,
    truncated: size > readLen,
    lossy,
    encoding,
    path: abs
  };
}

/**
 * 读取整个文件的字节，交给渲染进程里的纯前端解析器（docx / pptx）。
 * 仍然只读，且必须通过 assertAllowed()；超过上限直接拒绝，不做部分读取。
 */
async function readFileBytes(filePath, maxBytes = MAX_DOC_BYTES) {
  const abs = await assertAllowed(filePath);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) return { error: 'IS_DIR' };
  if (st.size > maxBytes) return { tooLarge: true, size: st.size, path: abs };
  const data = await fsp.readFile(abs);
  return { data, size: st.size, path: abs };
}

/** 单个路径的元信息（预览头、文件夹摘要用） */
async function statPath(target) {
  const abs = await assertAllowed(target);
  const st = await fsp.stat(abs);
  return { path: abs, size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() };
}

/**
 * 保存 SVG 编辑结果。这是应用里唯一的写文件入口，边界刻意收得很窄：
 *   - 真实路径必须在当前授权根内（与读走同一条 assertAllowed）；
 *   - 只能覆盖已经存在的 `.svg` 普通文件；
 *   - 调用方带来读取时的 size / mtime，磁盘上已经变了就回 CONFLICT，
 *     避免把别人的修改（例如 agent 重新导出）盖掉；
 *   - 先写同目录临时文件再 rename，中途失败不会留下半个文件。
 * 返回 `{ ok, path, size, mtime }` 或 `{ error: 'CONFLICT', size, mtime }`；
 * 其余失败抛错，由 IPC 层转成 `{ error, message }`。
 */
async function writeSvgFile(filePath, content, expected) {
  const abs = await assertAllowed(filePath);
  if (path.extname(abs).toLowerCase() !== '.svg') {
    const err = new Error('只允许保存 SVG：' + abs);
    err.code = 'ENOT_SVG';
    throw err;
  }
  if (typeof content !== 'string') {
    const err = new Error('保存内容必须是字符串');
    err.code = 'EBAD_CONTENT';
    throw err;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SVG_WRITE_BYTES) {
    const err = new Error('SVG 超过保存上限');
    err.code = 'ETOO_LARGE';
    throw err;
  }
  const st = await fsp.stat(abs);
  if (!st.isFile()) {
    const err = new Error('只能保存到普通文件');
    err.code = 'ENOT_FILE';
    throw err;
  }
  // 没有版本基线就不允许写：漏传的调用方会静默盖掉别人的修改
  if (!expected || !Number.isFinite(expected.size) || !Number.isFinite(expected.mtime)) {
    const err = new Error('缺少保存前的版本基线');
    err.code = 'EBAD_BASELINE';
    throw err;
  }
  if (st.size !== expected.size || Math.abs(st.mtimeMs - expected.mtime) > 0.5) {
    return { error: 'CONFLICT', size: st.size, mtime: st.mtimeMs };
  }
  const tmp = path.join(path.dirname(abs),
    '.' + path.basename(abs) + '.' + process.pid + '-' + Date.now() + '.tmp');
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  const after = await fsp.stat(abs);
  return { ok: true, path: abs, size: after.size, mtime: after.mtimeMs };
}

module.exports = {
  allowRoot,
  allowResolvedRoot,
  resolveReal: realPath,
  allowedRootList,
  resetAllowedRoots,
  offerRoot,
  isOfferedRoot,
  offeredRootList,
  assertAllowed,
  kindFor,
  mimeFor,
  listDir,
  statEntries,
  statPath,
  readFileForPreview,
  readFileBytes,
  writeSvgFile,
  MAX_TEXT_BYTES,
  MAX_DOC_BYTES,
  MAX_SVG_WRITE_BYTES
};
