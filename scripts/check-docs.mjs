/**
 * 检查文档索引有没有断掉。
 *
 * 两件事，都是「下一个会话靠不靠得住」的问题：
 *   1. `docs/` 下每个文档都能被 AGENTS.md 或 CODEMAP.md 找到——索引里没有的东西
 *      等于不存在（AGENTS.md 红线 5）。
 *   2. 所有相对链接都指向真实存在的文件——改文件名 / 挪目录后没人回来改链接，
 *      交给 CI 发现比等下次照着死链找文件便宜。
 *
 * 只检查 `.md`，不做锚点校验（界面里的 Markdown 渲染器不生成标题 id，锚点本来就不生效）。
 *
 * 为什么 `docs/design/` 与 `docs/audits/` 例外：AGENTS.md 对这两个目录是按目录整体
 * 索引的（「下按主题分的文档」「下按日期归档的记录」），里面的文件按主题 / 日期增长，
 * 逐个登记只会变成第二份目录。
 *
 * 用法：npm run check:docs（CI 在开 PR 时跑）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 进门的两份索引：新文档至少要出现在其中一份里 */
const INDEXES = ['AGENTS.md', 'CODEMAP.md'];
/** 按目录整体索引、不逐个登记的文档目录 */
const DIR_INDEXED = ['docs/design', 'docs/audits'];

/** 相对仓库根的 posix 路径（文档里的链接就是这么写的） */
function rel(abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function walkMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(abs));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs);
  }
  return out;
}

const errors = [];

/* ---- 1. 孤儿文档 ---- */
const indexesText = INDEXES
  .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
  .join('\n');

for (const abs of walkMd(path.join(root, 'docs'))) {
  const name = rel(abs);
  if (DIR_INDEXED.some((dir) => name.startsWith(dir + '/'))) continue;
  if (!indexesText.includes(name)) {
    errors.push(name + '：没有出现在 ' + INDEXES.join(' 或 ') + ' 里');
  }
}

/* ---- 2. 死链 ---- */
const scan = [
  ...INDEXES.map((name) => path.join(root, name)),
  ...['PENDING.md', 'further_notes.md', 'FEATURES.md', 'README.md', 'README.en.md',
    'CONTRIBUTING.md', 'SECURITY.md'].map((name) => path.join(root, name)),
  ...walkMd(path.join(root, 'docs'))
];

const LINK_RE = /\]\(\s*(<[^>\n]*>|[^)\s]+)/g;

/** 代码块与行内代码里的 `](...)` 是语法示例，不是链接 */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

for (const abs of scan) {
  const from = rel(abs);
  const text = stripCode(fs.readFileSync(abs, 'utf8'));
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(text))) {
    let target = m[1].replace(/^</, '').replace(/>$/, '');
    // 外链、锚点、空链接都不管
    if (!target || target.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    // 目录链接（docs/design/）以分隔符结尾，去掉后按目录判断
    const dest = path.resolve(path.dirname(abs), target);
    if (!fs.existsSync(dest)) {
      errors.push(from + '：链接指向不存在的 ' + target);
    }
  }
}

if (errors.length) {
  console.error('[docs] 发现 ' + errors.length + ' 处问题：');
  for (const one of errors) console.error('  - ' + one);
  process.exit(1);
}

console.log('[docs] 索引与链接都完整（' + walkMd(path.join(root, 'docs')).length + ' 篇 docs，' +
  scan.length + ' 个文件已扫描）');
