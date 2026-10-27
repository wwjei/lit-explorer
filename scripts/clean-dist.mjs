/**
 * 打包前清空 dist/。
 *
 * electron-builder 不会清理输出目录，历次打包的安装包与 blockmap 会一直堆在 dist/ 里。
 * 本地拿 dist/ 里的 exe 做装包验证时很容易装到旧版本；`scripts/build-checksums.mjs`
 * 虽然按当前版本号过滤，但「目录里有哪些版本」仍要靠自己确认。CI 上 dist/ 每次都是
 * 新的，所以这个问题只出现在本地。
 *
 * 用法：node scripts/clean-dist.mjs [dist 目录]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(root, process.argv[2] || 'dist');

fs.rmSync(dir, { recursive: true, force: true });
console.log('[clean-dist] 已清空 ' + path.relative(root, dir).replace(/\\/g, '/'));
