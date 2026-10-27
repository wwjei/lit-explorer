/**
 * 把共享渲染层与资源拷进 mygo/frontend/，供 go:embed 打包。
 *
 * 两个 shell 共用 src/renderer 与 src/shared；这里只带渲染层、资源与示例项目，
 * 不带 src/main（Electron 主进程）与 docs/（MyGo 版的菜单不引用这些文档）。
 * 示例项目要落到磁盘上才能当工作区打开（见 main.go 的 GetSampleRoot）。
 * 许可声明在资源复制后按实际 Go 依赖生成；失败时删除本次 stage，禁止嵌入半成品。
 *
 * 用法：npm run build && node mygo/stage-frontend.mjs（需要 Go）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'mygo', 'frontend');

try {
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
  // 先有 frontend，go list -deps 才能解析 go:embed；合并 npm 与 Go 许可供菜单打开。
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-mygo-notices.mjs')], {
    cwd: root, stdio: 'inherit',
  });

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
} catch (error) {
  fs.rmSync(out, { recursive: true, force: true });
  console.error('[mygo] frontend staging failed: ' + error.message);
  process.exit(1);
}
