/**
 * 打包渲染进程里需要模块化的部分。
 *
 * 1. 高亮 Worker：Shiki 的产物是 ESM 且用裸模块名（@shikijs/core 等），
 *    浏览器无法直接解析，必须打包；用 splitting 把每个按需 import() 的语言/主题
 *    切成独立 chunk，保持"只加载用到的那一种语言"。
 * 2. docx / pptx 预览：docx-preview、pptx-preview 同样是裸模块名，
 *    打成 IIFE 挂到 window.PV.docpreview 上由 index.html 直接加载。
 *
 * 用法：node scripts/build-renderer.mjs [--watch]
 */

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const outdir = path.join(root, 'src/renderer/vendor');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    'highlight-worker': path.join(root, 'src/renderer/highlight/worker.js')
  },
  outdir,
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  // Worker 里用到的动态 import 会被切成 chunk，命名保持可读
  chunkNames: 'chunks/[name]-[hash]',
  metafile: true
};

/** docx / pptx 预览：打成单个 IIFE，由 index.html 用 <script> 直接加载 */
const docOptions = {
  entryPoints: [path.join(root, 'src/renderer/docpreview.js')],
  outfile: path.join(outdir, 'docpreview.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  metafile: true
};

function report(result) {
  const out = Object.keys(result.metafile.outputs).filter((f) => f.endsWith('.js'));
  const total = out.reduce((sum, f) => sum + result.metafile.outputs[f].bytes, 0);
  console.log('[build] ' + out.length + ' 个产物，合计 ' + Math.round(total / 1024) + ' KB');
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  const docCtx = await context(docOptions);
  await docCtx.watch();
  console.log('[build] watching…');
} else {
  report(await build(options));
  const docResult = await build(docOptions);
  const key = Object.keys(docResult.metafile.outputs).find((f) => f.endsWith('docpreview.js'));
  const bytes = key ? docResult.metafile.outputs[key].bytes : 0;
  console.log('[build] docpreview.js ' + Math.round(bytes / 1024) + ' KB');
}
