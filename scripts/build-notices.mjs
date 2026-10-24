/**
 * 生成第三方许可声明（build/notices/THIRD-PARTY-NOTICES.md），随安装包一起分发。
 *
 * 为什么需要：产物里的 shiki / docx-preview / pptx-preview / jszip 是打包并压缩过的，
 * 压缩之后连版权头都留不下来，而它们分别是 MIT / Apache-2.0 / ISC / MIT 或 GPL-3.0，
 * 都要求分发二进制时保留许可与版权声明。Apache-2.0 还要求附上许可原文。
 *
 * 包名单不写死：读 build-renderer.mjs 留下的 src/renderer/vendor/meta.json，
 * 从「这次真正打进去的文件」反查所属的 npm 包。换依赖、换打包入口都不用改这里。
 *
 * 用法：npm run build && node scripts/build-notices.mjs
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metaPath = path.join(root, 'src/renderer/vendor/meta.json');
const outFile = path.join(root, 'build/notices/THIRD-PARTY-NOTICES.md');

/** 依次尝试这些文件名找许可原文 */
const LICENSE_FILES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.markdown',
  'LICENCE', 'COPYING', 'COPYING.md', 'license'
];

/** 许可正文之外还要一并分发的声明：Apache-2.0 的 NOTICE、以及 licenses/ 下的子组件许可 */
const NOTICE_FILES = ['NOTICE', 'NOTICE.md', 'NOTICE.txt', 'NOTICE.markdown'];

/**
 * 有些包把第三方代码的许可放在 licenses/ 下（如 ECharts 的 licenses/LICENSE-d3），
 * 根目录的 LICENSE 只是一份索引，漏掉这些等于漏发实际使用的代码的许可。
 */
async function collectExtras(dir) {
  const extras = [];
  for (const file of NOTICE_FILES) {
    const text = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
    if (text) extras.push({ file: file, text: text });
  }
  const licDir = path.join(dir, 'licenses');
  const entries = await fs.readdir(licDir, { recursive: true }).catch(() => []);
  for (const rel of entries.sort()) {
    const abs = path.join(licDir, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isFile()) continue;
    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text) extras.push({ file: 'licenses/' + String(rel).replace(/\\/g, '/'), text: text });
  }
  return extras;
}

const meta = await fs.readFile(metaPath, 'utf8').catch(() => null);
if (!meta) {
  console.error('[notices] 找不到 ' + path.relative(root, metaPath) + '，先跑 npm run build');
  process.exit(1);
}

// node_modules/<包名>/… 或 node_modules/@scope/<包名>/…
const names = new Set();
for (const input of JSON.parse(meta).inputs) {
  const m = input.replace(/\\/g, '/').match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (m) names.add(m[1]);
}

const pkgs = [];
for (const name of [...names].sort()) {
  const dir = path.join(root, 'node_modules', name);
  const info = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  const license = typeof info.license === 'string' ? info.license : null;
  if (!license) {
    console.error('[notices] ' + name + ' 的 package.json 没有 license 字段，无法生成声明');
    process.exit(1);
  }

  let text = null;
  for (const file of LICENSE_FILES) {
    text = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
    if (text) break;
  }
  // Apache-2.0 明文要求随分发附上许可副本，找不到原文就不能装作合规
  if (!text && /Apache-2\.0/i.test(license)) {
    console.error('[notices] ' + name + ' 是 Apache-2.0 但包内没有许可原文，需要手工补进声明');
    process.exit(1);
  }

  pkgs.push({
    name,
    version: info.version,
    license,
    homepage: (info.repository && info.repository.url) || info.homepage || '',
    text,
    extras: await collectExtras(dir)
  });
}

const lines = [
  '# 第三方许可声明',
  '',
  'lit explorer 自身以 [MIT 许可](../LICENSE)发布。',
  '',
  '安装包里的 `resources/app.asar` 内含打包并压缩过的下列第三方代码，压缩后其版权头',
  '不再可读，故在此一并列出。它们的许可条款如下，分发本程序时请一并保留。',
  '',
  '| 包 | 版本 | 许可 |',
  '| --- | --- | --- |',
  ...pkgs.map((p) => '| ' + [p.name, p.version, p.license].join(' | ') + ' |'),
  '',
  '此外，安装目录下的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html` 是 Electron 与',
  'Chromium 的许可声明，由 electron-builder 自动附带，不在本文件范围内。',
  ''
];

for (const p of pkgs) {
  lines.push('---', '', '## ' + p.name + ' ' + p.version + '（' + p.license + '）', '');
  if (p.homepage) lines.push('来源：' + p.homepage, '');
  if (p.text) {
    lines.push('```text', p.text.trimEnd(), '```', '');
  } else {
    lines.push('> 该包没有随包提供许可原文，以上许可类型取自其 package.json。', '');
  }
  for (const extra of p.extras || []) {
    lines.push('### ' + extra.file, '', '```text', extra.text.trimEnd(), '```', '');
  }
}

await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, lines.join('\n'));
console.log('[notices] ' + pkgs.length + ' 个包 → ' + path.relative(root, outFile).replace(/\\/g, '/'));
for (const p of pkgs) {
  const extras = (p.extras || []).map((e) => e.file).join(', ');
  console.log('  ' + p.name + '@' + p.version + '  ' + p.license
    + (p.text ? '' : '  （无原文）') + (extras ? '  另附 ' + extras : ''));
}
