/**
 * 把 Electron 版的前端资源拷进 mygo/frontend/，供 go:embed 打包。
 *
 * 渲染层（src/renderer）与资源原样复用，只额外带上文档与示例项目：
 * 示例项目要落到磁盘上才能当工作区打开（见 main.go 的 GetSampleRoot）。
 *
 * 用法：npm run build && node mygo/stage-frontend.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'mygo', 'frontend');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const dir of ['src', 'assets', 'docs', 'sample-project']) {
  fs.cpSync(path.join(root, dir), path.join(out, dir), { recursive: true });
}
for (const file of ['FEATURES.md', 'LICENSE', 'README.md']) {
  const from = path.join(root, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, file));
}

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else {
      files++;
      bytes += fs.statSync(abs).size;
    }
  }
})(out);

console.log(`[mygo] frontend staged: ${files} files, ${(bytes / 1048576).toFixed(1)} MB → mygo/frontend`);
