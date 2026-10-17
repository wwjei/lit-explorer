/**
 * 打包渲染进程里需要模块化的部分。
 *
 * 目前只有高亮 Worker：Shiki 的产物是 ESM 且用裸模块名（@shikijs/core 等），
 * 浏览器无法直接解析，必须打包；用 splitting 把每个按需 import() 的语言/主题
 * 切成独立 chunk，保持"只加载用到的那一种语言"。
 *
 * 用法：node scripts/build-renderer.mjs [--watch]
 */

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    'highlight-worker': path.join(root, 'src/renderer/highlight/worker.js')
  },
  outdir: path.join(root, 'src/renderer/vendor'),
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

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build] watching…');
} else {
  const result = await build(options);
  const out = Object.keys(result.metafile.outputs).filter((f) => f.endsWith('.js'));
  const total = out.reduce((sum, f) => sum + result.metafile.outputs[f].bytes, 0);
  console.log('[build] ' + out.length + ' 个产物，合计 ' + Math.round(total / 1024) + ' KB');
}
