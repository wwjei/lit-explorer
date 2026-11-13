/**
 * 构建 Lit Explorer Windows 安装包 / 便携包或 macOS 通用 DMG。
 *
 * mygo/stage-frontend.mjs 把渲染层拷进
 * mygo/frontend/，再由 `mygo build` 嵌进 Go 二进制。产物统一放进 dist/，
 * 文件名带版本号，scripts/build-checksums.mjs 与 Release 上传都能直接收进去。
 *
 * 依赖：Go（见 mygo/go.mod）与 MyGo CLI。CLI 通过 `go run` 固定到上游 v0.7.1；
 * 本地想用自己编译的 CLI 时设 MYGO_CLI=<可执行文件路径>。
 * NSIS 缺失时 mygo build 会自己下载（GitHub Releases）。
 *
 * 用法：npm run dist（先构建渲染层，再编译、收集许可与构建产品安装器）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mygoDir = path.join(root, 'mygo');
const distDir = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const product = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/product.json'), 'utf8'));
const mac = process.platform === 'darwin';
const target = mac ? 'darwin/universal' : 'windows/amd64';
process.env.LIT_GOOS = mac ? 'darwin' : 'windows';
process.env.LIT_GOARCH = 'amd64';
const cli = process.env.MYGO_CLI || 'github.com/egoist/mygo/cmd/mygo@v0.7.1';

/* mygo.json 由这里生成：版本号只有一个来源（package.json），避免两处漂移 */
const config = {
  name: product.name,
  slug: product.slug,
  identifier: product.identifier, // 保留技术标识以兼容已有单实例和卸载登记。
  version: pkg.version,
  copyright: '© 2026 wwjei',
  buildCommand: 'node stage-frontend.mjs',
  frontendDist: 'frontend',
  out: 'dist',
  icon: '../assets/icon-source.png',
  macos: { minimumSystemVersion: '12.0' },
};
fs.writeFileSync(path.join(mygoDir, 'mygo.json'), JSON.stringify(config, null, 2) + '\n');

if (!fs.existsSync(path.join(root, 'src', 'renderer', 'vendor', 'meta.json'))) {
  console.error('[mygo] src/renderer/vendor 不存在：先跑 npm run build');
  process.exit(1);
}

// CLI v0.7.1 的 writeClient 会先 go build，再执行 buildCommand。
// fresh checkout 必须在进入 CLI 前准备好 go:embed 的 frontend（含许可声明）。
execFileSync(process.execPath, [path.join(mygoDir, 'stage-frontend.mjs')], {
  cwd: root, stdio: 'inherit',
});

fs.rmSync(path.join(mygoDir, 'dist'), { recursive: true, force: true });

const args = ['build', '-platform', target];
if (process.env.MYGO_CLI) {
  execFileSync(process.env.MYGO_CLI, args, { cwd: mygoDir, stdio: 'inherit' });
} else {
    execFileSync('go', ['run', cli, ...args], { cwd: mygoDir, stdio: 'inherit' });
  }

  if (mac) {
    const outDir = path.join(mygoDir, 'dist', 'darwin-universal');
    const dmg = fs.readdirSync(outDir).find((name) => name.endsWith('.dmg'));
    if (!dmg) throw new Error('macOS 构建未生成 DMG');
    fs.mkdirSync(distDir, { recursive: true });
    fs.copyFileSync(path.join(outDir, dmg), path.join(distDir, `Lit-Explorer-${pkg.version}-macOS-universal.dmg`));
    console.log('[build] macOS 通用 DMG 已生成（Apple Silicon + Intel）');
  } else {
  const outDir = path.join(mygoDir, 'dist', 'windows-amd64');
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const setup = files.find((f) => /setup-.*\.exe$/i.test(f));
  const appExe = files.find((f) => /\.exe$/i.test(f) && !/setup-/i.test(f));
  if (!setup || !appExe) {
    console.error('[mygo] 构建产物不完整：' + outDir + ' 里没有 setup / app exe');
    console.error(files.join('\n'));
    process.exit(1);
  }

  fs.mkdirSync(distDir, { recursive: true });
  // 产品安装策略由本仓库管理：统一名称、旧版本卸载、快捷方式及文件夹菜单。
  const compiler = process.env.MAKENSIS || 'makensis';
  execFileSync(compiler, [
    ...(process.platform === 'win32' ? ['/V2'] : ['-V2']),
    ...[
      ['APP_EXE',path.join(outDir,appExe)],
      ['OUTPUT',path.join(distDir,`Lit-Explorer-Setup-${pkg.version}.exe`)],
      ['VERSION',pkg.version], ['ICON',path.join(root,'build/icon.ico')],
      ['CLOSE_SCRIPT',path.join(root,'build/close-app.ps1')]
    ].map(([key,value]) => `${process.platform === 'win32' ? '/' : '-'}D${key}=${value}`),
    path.join(root,'build/installer.nsi')
  ],{cwd:root,stdio:'inherit'});
  const targets = [
    [path.join(outDir, appExe), path.join(distDir, `Lit-Explorer-${pkg.version}-portable.exe`)],
  ];
  for (const [from, to] of targets) {
    fs.copyFileSync(from, to);
    const mb = (fs.statSync(to).size / 1048576).toFixed(1);
    console.log(`[mygo] ${mb} MB → ${path.relative(root, to).replace(/\\/g, '/')}`);
  }

}
