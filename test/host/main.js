// 仅用于渲染器契约测试的 Node 宿主；不提供产品窗口或发布入口。
'use strict';
const { app, protocol, ipcMain } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fsApi = require('./fs-api');
const store = require('./store');
const contracts = require('../../src/shared/contracts');
const DEV_ROOT = path.join(__dirname, '..', '..');
let win = null;
function assetPath(name) { return path.join(DEV_ROOT, name); }
protocol.registerSchemesAsPrivileged([{scheme:'pv',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
const referenceDirs = require('./reference-dirs').createReferenceDirs({fsApi,store,pick:async()=>null});
const directoryPlugins = { activate() {} };
function filePathFromUrl(rawUrl) {
  let p = decodeURIComponent(new URL(rawUrl).pathname);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // Windows 盘符前会多一个斜杠
  return p;
}

function toPreviewUrl(filePath) {
  const abs = path.resolve(filePath);
  const normalized = abs.split(path.sep).join('/');
  const prefix = normalized.startsWith('/') ? '' : '/';
  return 'pv://local' + prefix + normalized.split('/').map(encodeURIComponent).join('/');
}

/* ------------------------------------------------------------------ *
 * Markdown 图片地址 -> pv://
 * 本地地址相对 md 文件所在目录；以 / 或 \ 开头的按工作区根。
 * 每个候选都过 assertAllowed()：越界（含 junction / 符号链接）一律拒绝。
 * ------------------------------------------------------------------ */
const IMG_SRC_MAX = 2048;
const IMG_MAX_PER_DOC = contracts.MAX_MD_IMAGES;
const IMG_MAX_BYTES = 32 * 1024 * 1024;

function codedError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/** 图片 / HTML / PDF 的预览地址都带文件版本，保存后重新渲染才能拿到新内容 */
function previewVersion(st) {
  return '?v=' + Math.round(st.mtimeMs) + '-' + st.size;
}

/** 去掉 <> 包裹、片段与查询串并解码；控制字符 / 协议头 / UNC 一律判无效 */
function cleanImageSrc(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.length > IMG_SRC_MAX) return '';
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  // 本地文件没有查询串与片段；文件名里真带 # 的会落到「文件不存在」
  s = s.replace(/[?#].*$/, '');
  try { s = decodeURIComponent(s); } catch { /* 保持原样 */ }
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return '';
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  // 单字母是 Windows 盘符；UNC 路径会真的去连网络主机，也不收
  if ((scheme && scheme[1].length > 1) || s.startsWith('//') || s.startsWith('\\\\')) return '';
  return s;
}

async function resolveImageTargets(mdPath, srcs) {
  const base = await fsApi.assertAllowed(mdPath);
  const dir = path.dirname(base);
  // openWorkspace() 每次都先 resetAllowedRoots() 再只允许当前根，所以这里唯一的一项
  // 就是当前工作区；将来真有多个授权根，这个取法要跟着改。
  const root = fsApi.allowedRootList()[0];
  return Promise.all(srcs.slice(0, IMG_MAX_PER_DOC).map(async (raw) => {
    const src = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
    try {
      const clean = cleanImageSrc(src);
      if (!clean) throw codedError('EBAD_SRC');
      const abs = /^[\\/]/.test(clean) && root
        ? path.resolve(root, clean.replace(/^[\\/]+/, ''))
        : path.resolve(dir, clean);
      const real = await fsApi.assertAllowed(abs);
      const st = await fsp.stat(real);
      if (!st.isFile()) throw codedError('ENOT_FILE');
      if (st.size > IMG_MAX_BYTES) throw codedError('ETOO_LARGE');
      const kind = fsApi.kindFor(real);
      if (kind !== 'image' && kind !== 'svg') throw codedError('ENOT_IMAGE');
      // 与 fs:preview-url 一样带文件版本：改了图再刷新要拿到新内容
      return { src: src, url: toPreviewUrl(real) + previewVersion(st) };
    } catch (err) {
      return { src: src, error: (err && err.code) || 'EIMG' };
    }
  }));
}

function registerPreviewProtocol() {
  protocol.handle('pv', async (request) => {
    let abs;
    try {
      abs = await fsApi.assertAllowed(filePathFromUrl(request.url));
    } catch {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await fsp.readFile(abs);
      return new Response(data, {
        headers: {
          'content-type': fsApi.mimeFor(abs),
          'cache-control': 'no-store',
          // 预览 iframe 是不透明源（sandbox 无 allow-same-origin），
          // ES module / fetch 会走 CORS，必须允许跨源读取
          'access-control-allow-origin': '*'
        }
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

let workspaceSeq = 0;

async function openWorkspace(dir, options = {}) {
  const seq = ++workspaceSeq;
  const abs = path.resolve(dir);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) {
    if (!options.silent) {
      dialog.showMessageBox(win, {
        type: 'warning',
        message: '无法打开该目录',
        detail: abs + '\n\n目录不存在或不可访问。'
      });
    }
    return { error: 'NOT_A_DIRECTORY' };
  }

  // 登记并统一使用真实路径：用户可能挑了一个符号链接 / junction，
  // 后续所有路径校验都在真实路径上做，界面里也用同一份地址。
  // 先异步解析，再同步「清空 + 登记」：两次切换重叠时，先发起的那次若在
  // 后一次清空之后才登记，就会留下两个授权根（A 已切走却仍然可读）。
  const root = await fsApi.resolveReal(abs);
  const references = await referenceDirs.prepare(root);
  if (seq !== workspaceSeq) return { error: 'SUPERSEDED' };
  fsApi.resetAllowedRoots();
  fsApi.allowResolvedRoot(root);
  referenceDirs.activate(root, references);
  directoryPlugins.activate(root);
  // 打开过的目录也算「给过渲染进程」：它之后可以再打开一次
  fsApi.offerRoot(root);
  const state = await store.load();
  const recent = [root, ...(state.recentRoots || []).filter((p) => p !== root)].slice(0, 8);
  await store.patch({ lastRoot: root, recentRoots: recent });
  win.setTitle(path.basename(root) + ' · lit explorer');
  win.webContents.send('workspace:opened', root);
  return { root: root };
}


function registerIpc() {
  ipcMain.handle('workspace:sample', () => fsApi.offerRoot(assetPath('sample-project')));
  ipcMain.handle('workspace:open', async (_e,dir) => fsApi.isOfferedRoot(dir) ? openWorkspace(dir,{silent:true}) : {error:'NOT_OFFERED'});
  ipcMain.handle('fs:preview-url', async (_e, filePath) => {
    try {
      const abs = await fsApi.assertAllowed(filePath);
      // 同一路径的图片会按 URL 命中 Chromium 的内存缓存，no-store 也拦不住；
      // 带上文件版本，保存后重新渲染才会取到新内容
      let version = '';
      try {
        const st = await fsp.stat(abs);
        version = previewVersion(st);
      } catch { /* 取不到版本就用不带查询串的地址，能不能读交给协议判断 */ }
      return { url: toPreviewUrl(abs) + version };
    } catch (err) {
      return { error: err.code || 'EURL' };
    }
  });

  // Markdown 里的本地图片：一次把整篇的地址解析完，渲染进程据此出 <img> 或占位
  ipcMain.handle('fs:resolve-images', async (_e, mdPath, srcs) => {
    try {
      if (!Array.isArray(srcs) || !srcs.length) return { items: [] };
      return { items: await resolveImageTargets(mdPath, srcs) };
    } catch (err) {
      return { error: err.code || 'EIMG', items: [] };
    }
  });

}
