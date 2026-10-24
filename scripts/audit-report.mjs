/**
 * 把 `npm audit` 的结果按「会不会进安装包」分成两堆。
 *
 * 为什么需要分开看：这个项目所有依赖都在 devDependencies，但其中一部分会被 esbuild
 * 打进 `src/renderer/vendor/`（shiki、docx-preview、pptx-preview 及其依赖树），
 * 跟着安装包一起分发；另一部分（electron-builder、esbuild）只在构建机上跑。
 * Electron 比较特殊：它的 JS 包不经过 esbuild，但运行时代码与二进制由 electron-builder
 * 原样随安装包分发，所以也必须算进「会进安装包」这一堆。
 *
 * 判断依据是 `npm run build` 留下的 `src/renderer/vendor/meta.json`——「这次真正打进了
 * 哪些文件」的清单，所以它反映的是实际产物，不是 package.json 里的声明。
 *
 * 退出码只由「会进安装包」且严重度为 high / critical 的项决定。moderate 与「仅构建期」
 * 一律只报告：它们常常没有可用的修复（上游把依赖范围钉死了，比如 pptx-preview 钉的
 * echarts ^5.5.1），卡住所有构建没有意义。
 *
 * 注意：这个脚本只回答「这个包进不进产物」，不回答「这段有问题的代码在我们这里跑不跑得到」。
 * 后者要人看——比如 echarts 那条 XSS 需要 Lines 系列，而 pptx-preview 只产出
 * pie / line / bar，所以够不着。
 *
 * 用法：npm run build && npm run audit
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metaPath = path.join(root, 'src/renderer/vendor/meta.json');

let meta;
try {
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
} catch {
  console.error('[audit] 找不到 ' + path.relative(root, metaPath).replace(/\\/g, '/') + '，先跑 npm run build');
  process.exit(1);
}

/** 被 esbuild 打进产物的包 */
const bundled = new Set();
for (const input of meta.inputs) {
  const m = input.replace(/\\/g, '/').match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (m) bundled.add(m[1]);
}
// Electron 不经过 esbuild，但它是随安装包分发的运行时本体（electron-builder 打包）
bundled.add('electron');

let report;
const injected = process.env.AUDIT_JSON;
if (injected) {
  // 测试 / 复现用：跳过 npm audit，直接读一份结果
  report = JSON.parse(fs.readFileSync(path.resolve(injected), 'utf8'));
} else {
  try {
    // npm audit 有漏洞时退出码非零，输出仍然有效。
    // 整条命令当一个字符串交给 shell：传参数数组 + shell:true 会触发 DEP0190。
    const out = execFileSync('npm audit --json', {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: true
    });
    report = JSON.parse(out);
  } catch (err) {
    const text = err.stdout || '';
    try {
      report = JSON.parse(text);
    } catch {
      console.warn('[audit] 拿不到结果（多半是连不上 registry），本次跳过：' + String(err.message).split('\n')[0]);
      process.exit(0);
    }
  }
}

const rows = Object.entries(report.vulnerabilities || {}).map(([name, v]) => ({
  name,
  severity: v.severity,
  range: v.range,
  bundled: bundled.has(name),
  titles: (v.via || []).filter((x) => typeof x === 'object').map((x) => x.title)
}));

const ships = rows.filter((r) => r.bundled).sort((a, b) => a.name.localeCompare(b.name));
const buildOnly = rows.filter((r) => !r.bundled).sort((a, b) => a.name.localeCompare(b.name));

function dump(title, list) {
  console.log('\n' + title + '（' + list.length + '）');
  if (!list.length) {
    console.log('  （无）');
    return;
  }
  for (const r of list) {
    console.log('  ' + r.severity.padEnd(9) + r.name + ' ' + r.range);
    for (const t of r.titles) console.log('            ' + t);
  }
}

console.log('[audit] 产物里的第三方包共 ' + bundled.size + ' 个（来自 vendor/meta.json）');
dump('会进安装包 —— 需要判断代码是否真的可达', ships);
dump('仅构建期 —— 不随程序分发', buildOnly);

const counts = (report.metadata || {}).vulnerabilities || {};
console.log('\n汇总：' + Object.entries(counts).filter(([k]) => k !== 'total').map(([k, v]) => k + ' ' + v).join('，'));

const blocking = ships.filter((r) => r.severity === 'high' || r.severity === 'critical');
if (blocking.length) {
  console.error('\n[audit] 会进安装包的依赖里有 high / critical：' + blocking.map((r) => r.name).join('、'));
  process.exit(1);
}
console.log('\n[audit] 没有「会进安装包且 high / critical」的项。');
