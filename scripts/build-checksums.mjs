/**
 * 为 dist/ 下的安装包生成 SHA256SUMS.txt。
 *
 * 项目没有配置代码签名，Windows 会提示「未知发布者」，所以校验和是用户唯一
 * 能自己核对「下载到的东西就是 CI 构建出来的那一份」的手段。
 *
 * 输出格式与 `sha256sum -c SHA256SUMS.txt` 兼容：每行「64 位十六进制 + 两个空格 + 文件名」，
 * 换行用 LF（PowerShell 的 Set-Content 会写成 CRLF，那样 -c 会把 \r 当成文件名的一部分）。
 *
 * 用法：node scripts/build-checksums.mjs [dist 目录]
 */

import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(root, process.argv[2] || 'dist');

if (!fs.existsSync(dir)) {
  console.error('[checksums] 找不到目录：' + dir + '，先跑 npm run dist');
  process.exit(1);
}

// 只认当前版本号：本地 dist/ 里可能还堆着以前几次打包的 exe，
// 一起列进去的话 SHA256SUMS.txt 会把不相干的旧包也算上
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f) && f.includes(version)).sort();
if (!files.length) {
  console.error('[checksums] ' + dir + ' 里没有 ' + version + ' 的 .exe，先跑 npm run dist');
  process.exit(1);
}

const lines = files.map((f) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  return hash + '  ' + f;
});

const out = path.join(dir, 'SHA256SUMS.txt');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log('[checksums] ' + files.length + ' 个文件 → ' + path.relative(root, out).replace(/\\/g, '/'));
for (const line of lines) console.log('  ' + line);
