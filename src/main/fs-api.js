'use strict';

/**
 * 文件系统访问层：只做读操作，不提供任何写入/删除能力。
 * 所有对外路径都会先经过 assertAllowed() 校验，确保不越出已授权的工作区根目录。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

/** 允许访问的根目录集合（由主进程在打开工作区时登记） */
const allowedRoots = new Set();

/** 文本预览上限：超过则只读前 5 MB 并标记截断 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** 判二进制时检查的头部长度 */
const SNIFF_BYTES = 8192;

const KIND_BY_EXT = {
  html: ['html', 'htm', 'xhtml'],
  md: ['md', 'markdown', 'mdx'],
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

/** 登记一个工作区根目录 */
function allowRoot(dir) {
  if (!dir) return;
  allowedRoots.add(path.resolve(dir));
}

function allowedRootList() {
  return Array.from(allowedRoots);
}

/** 路径必须在某个已授权根目录内，否则抛错（防目录穿越） */
function assertAllowed(target) {
  const abs = path.resolve(target);
  for (const root of allowedRoots) {
    if (abs === root) return abs;
    if (abs.startsWith(root + path.sep)) return abs;
  }
  const err = new Error('路径不在已授权的工作区内：' + abs);
  err.code = 'EACCES_ROOT';
  throw err;
}

function isDirEntry(dirent) {
  return dirent.isDirectory();
}

/** 读取一层目录（只做 readdir，不做 stat，保证大目录首屏足够快） */
async function listDir(dir) {
  const abs = assertAllowed(dir);
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
    } catch {
      entry.broken = true;
    }
  }));

  return { dir: abs, entries };
}

/** 并发受限的批量 stat，用于补全大小与修改时间 */
async function statEntries(dir, entries, concurrency = 24) {
  const abs = assertAllowed(dir);
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
  const abs = assertAllowed(filePath);
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
  if (text.includes('\uFFFD')) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf);
      if (!gbk.includes('\uFFFD')) text = gbk;
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
    path: abs
  };
}

/** 单个路径的元信息（预览头、文件夹摘要用） */
async function statPath(target) {
  const abs = assertAllowed(target);
  const st = await fsp.stat(abs);
  return { path: abs, size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() };
}

module.exports = {
  allowRoot,
  allowedRootList,
  assertAllowed,
  kindFor,
  mimeFor,
  listDir,
  statEntries,
  statPath,
  readFileForPreview,
  MAX_TEXT_BYTES
};
