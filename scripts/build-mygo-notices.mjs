/**
 * 为 MyGo 生成合并的 npm / Go 许可声明，写入 frontend/notices，不影响 Electron。
 * stage-frontend.mjs 先复制 go:embed 输入，再调用本脚本；依赖 Go，但不新增 npm 依赖。
 * Go 模块由 Windows/amd64 主程序的 go list -deps 推导，replace 使用实际源码的身份与许可。
 * 用法：node mygo/stage-frontend.mjs（也可在 stage 后单独运行本脚本刷新声明）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mygoDir = path.join(root, 'mygo');
const outFile = path.join(mygoDir, 'frontend', 'notices', 'THIRD-PARTY-NOTICES.md');
const env = {
  ...process.env, GOOS: 'windows', GOARCH: 'amd64',
  CGO_ENABLED: process.env.CGO_ENABLED || '0',
};
const go = (...args) => execFileSync('go', args, {
  cwd: mygoDir, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
});

// go list 输出连续的顶层 JSON 对象；换行后紧接 { 才是下一条记录。
const tags = (process.env.GOFLAGS || '').split(/\s+/)
  .map((flag) => flag.match(/^-{1,2}tags=(.+)$/)?.[1]).filter(Boolean);
if (process.env.MYGO_INSPECTOR !== '1') tags.push('mygo_noinspector');
const packages = go('list', '-mod=readonly', '-deps', '-json=ImportPath,Dir,Module,Standard',
  ...(tags.length ? ['-tags', tags.join(',')] : []), '.')
  .trim().split(/\r?\n(?=\{)/).map((record) => JSON.parse(record));
const toolchain = JSON.parse(go('env', '-json', 'GOROOT', 'GOVERSION'));

const licenseName = /^(?:licen[cs]e|copying)(?:[._-].*)?$/i;
const noticeName = /^(?:notice|patents)(?:[._-].*)?$/i;

function readLicenses(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && (licenseName.test(entry.name) || noticeName.test(entry.name))) {
      files.push(path.join(dir, entry.name));
    } else if (entry.isDirectory() && /^licen[cs]es$/i.test(entry.name)) {
      const walk = (base) => {
        for (const child of fs.readdirSync(base, { withFileTypes: true })) {
          const file = path.join(base, child.name);
          if (child.isDirectory()) walk(file);
          else if (child.isFile()) files.push(file);
        }
      };
      walk(path.join(dir, entry.name));
    }
  }
  return files;
}

function collectNotices(base, dirs) {
  const files = new Set(readLicenses(base));
  const visited = new Set([base]);
  for (const dir of dirs) {
    // 包目录及其父目录可能另有子组件许可，只收实际链接到的包路径。
    let current = dir;
    while (current !== base) {
      const rel = path.relative(base, current);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        throw new Error('[mygo notices] 包目录不在源码根目录内：' + current);
      }
      if (visited.has(current)) break;
      visited.add(current);
      for (const file of readLicenses(current)) files.add(file);
      current = path.dirname(current);
    }
  }
  const notices = [...files].sort().map((file) => ({
    file: path.relative(base, file).replace(/\\/g, '/'),
    text: fs.readFileSync(file, 'utf8').trimEnd(),
  }));
  if (!notices.some((item) => !item.file.includes('/') && licenseName.test(item.file) && item.text.trim())) {
    throw new Error('[mygo notices] 找不到非空的根目录许可原文：' + base);
  }
  return notices;
}

function licenseType(notices) {
  const text = notices.filter((item) => !item.file.includes('/') && licenseName.test(item.file))
    .map((item) => item.text).join('\n');
  if (/Apache License\s+Version 2\.0/.test(text)) return 'Apache-2.0';
  if (/MIT License|Permission is hereby granted, free of charge/.test(text)) return 'MIT';
  if (/Redistribution and use in source and binary forms/.test(text)
    && /Neither the name/.test(text)) return 'BSD-3-Clause';
  return '见许可原文';
}

const modules = new Map();
for (const pkg of packages) {
  const mod = pkg.Module;
  if (!mod || mod.Main) continue;
  if (!modules.has(mod.Path)) modules.set(mod.Path, { mod, dirs: [] });
  modules.get(mod.Path).dirs.push(pkg.Dir);
}
if (!modules.size) throw new Error('[mygo notices] go list 没有返回任何第三方模块');

const components = [...modules.values()].map(({ mod, dirs }) => {
  const actual = mod.Replace || mod;
  const notices = collectNotices(actual.Dir || mod.Dir, dirs);
  return {
    name: actual.Path, version: actual.Version || '本地替换', license: licenseType(notices),
    replaces: mod.Replace ? `${mod.Path} ${mod.Version || ''}`.trim() : '', notices,
  };
}).sort((a, b) => a.name.localeCompare(b.name, 'en'));
const runtimeNotices = collectNotices(toolchain.GOROOT,
  packages.filter((pkg) => pkg.Standard).map((pkg) => pkg.Dir));
components.push({
  name: 'Go runtime / standard library', version: toolchain.GOVERSION,
  license: licenseType(runtimeNotices), notices: runtimeNotices,
});

const lines = [
  '', '---', '', '# MyGo 链接的 Go 代码', '',
  '以下模块由 Windows/amd64 主程序（不含测试与构建工具）的 `go list -deps` 推导；',
  '模块替换按实际源码列出。另附编入可执行文件的 Go runtime、标准库及其 vendor 许可。', '',
  '| 模块 / 组件 | 版本 | 许可 |', '| --- | --- | --- |',
  ...components.map((item) => `| ${item.name} | ${item.version} | ${item.license} |`), '',
];
for (const item of components) {
  lines.push('---', '', `## ${item.name} ${item.version}（${item.license}）`, '');
  if (item.replaces) lines.push(`替换模块：${item.replaces}`, '');
  for (const notice of item.notices) {
    lines.push('### ' + notice.file, '', '```text', notice.text, '```', '');
  }
}

// 每次从 vendor/meta.json 重新生成 npm 部分，干净 CI 无需预先跑 npm run notices。
// 只在所有 Go 许可检查通过后写产物；stage 失败时负责清除 frontend。
execFileSync(process.execPath, [path.join(root, 'scripts', 'build-notices.mjs'), '--mygo'], {
  cwd: root, stdio: 'inherit',
});
fs.appendFileSync(outFile, lines.join('\n'));
console.log(`[mygo notices] ${modules.size} 个 Go 模块 + ${toolchain.GOVERSION} → frontend/notices/THIRD-PARTY-NOTICES.md`);
