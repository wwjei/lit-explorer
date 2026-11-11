/**
 * 打包前清空 dist/。
 *
 * 仅保留本轮产品产物，避免上传旧版本或已经移除的备用包。
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
