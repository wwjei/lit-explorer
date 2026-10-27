/**
 * 把共享渲染层与资源拷进 mygo/frontend/，供 go:embed 打包。
 *
 * 两个 shell 共用 src/renderer 与 src/shared；这里只带渲染层、资源与示例项目，
 * 不带 src/main（Electron 主进程）与 docs/（MyGo 版的菜单不引用这些文档）。
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

const copy = (rel) => {
  const from = path.join(root, rel);
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, path.join(out, rel), { recursive: true });
};
for (const rel of ['src/renderer', 'src/shared', 'assets', 'sample-project']) copy(rel);
for (const file of ['FEATURES.md', 'LICENSE', 'README.md']) {
  const from = path.join(root, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, file));
}
// 第三方许可声明随二进制分发（npm run notices 生成）；MyGo 菜单里有入口
const notices = path.join(root, 'build', 'notices', 'THIRD-PARTY-NOTICES.md');
if (fs.existsSync(notices)) {
  fs.mkdirSync(path.join(out, 'notices'), { recursive: true });
  fs.copyFileSync(notices, path.join(out, 'notices', 'THIRD-PARTY-NOTICES.md'));
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
