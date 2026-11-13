// 在一次性 macOS CI 账户验证真实 DMG、签名、双架构以及 WKWebView 文件预览。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

if (process.platform !== 'darwin') throw new Error('此验证需要 macOS');
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const dmg = path.resolve(`dist/Lit-Explorer-${version}-macOS-universal.dmg`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-macos-'));
const mount = path.join(temp, 'volume');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
let mounted = false;
try {
  run('hdiutil', ['verify', dmg]);
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
  mounted = true;
  assert.equal(fs.readlinkSync(path.join(mount, 'Applications')), '/Applications');
  const app = path.join(temp, 'Lit Explorer.app');
  run('ditto', [path.join(mount, 'Lit Explorer.app'), app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const plist = path.join(app, 'Contents/Info.plist');
  const field = (key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).trim();
  assert.equal(field('CFBundleDisplayName'), 'Lit Explorer');
  assert.equal(field('CFBundleShortVersionString'), version);
  const binary = path.join(app, 'Contents/MacOS', field('CFBundleExecutable'));
  run('lipo', [binary, '-verify_arch', 'arm64', 'x86_64']);

  const workspace = path.join(temp, '示例 Project');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'readme.md'), '# MACOS_PREVIEW\n\n[本地链接](./next.md)');
  fs.writeFileSync(path.join(workspace, 'next.md'), '# MACOS_LOCAL_LINK');
  const outside = path.join(temp, 'private.txt');
  fs.writeFileSync(outside, 'outside workspace');
  const probe = path.join(temp, 'probe.js');
  fs.writeFileSync(probe, `(async () => {
    const wait = async (fn) => { const until=Date.now()+15000; while(!fn()) { if(Date.now()>until) throw Error('DOM timeout'); await new Promise(r=>setTimeout(r,40)); } };
    if (pv.platform !== 'darwin') throw Error('Wrong platform bridge');
    await wait(()=>[...document.querySelectorAll('.row')].some(e=>e.textContent.includes('readme.md')));
    [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('readme.md')).click();
    await wait(()=>document.querySelector('.prose')?.textContent.includes('MACOS_PREVIEW'));
    document.querySelector('.prose a').click();
    await wait(()=>document.querySelector('.prose')?.textContent.includes('MACOS_LOCAL_LINK'));
    const denied=await pv.read(${JSON.stringify(outside)});
    if (!denied.error) throw Error('Workspace boundary bypass');
    document.querySelector('[data-network-add]').click();
    await wait(()=>document.querySelector('.network-add-menu'));
    document.querySelector('.network-add-menu [data-web-add]').click();
    if(!document.querySelector('.web-url')) throw Error('Link form missing');
    document.querySelector('[data-web-cancel]').click();
    if(getComputedStyle(document.querySelector('.winctl')).display!=='none') throw Error('Windows controls visible');
    return {ok:true,platform:pv.platform,preview:true,localLink:true,boundary:true,networkMenu:true};
  })()`);
  const args = [`--open=${workspace}`, `--user-data-dir=${path.join(temp, 'profile')}`, `--eval=${probe}`, '--delay=1500'];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Native smoke test timed out\n'+text)); }, 45000);
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error(`Native exit ${code}\n${text}`)); });
  });
  console.log(output);
  const line = output.split('\n').find((line) => line.startsWith('[eval] {'));
  assert.ok(line, 'No native probe result');
  assert.equal(JSON.parse(line.slice(7)).ok, true);
  console.log('[macOS] DMG、签名、双架构、原生预览、本地链接及网络入口验证通过');
} finally {
  if (mounted) run('hdiutil', ['detach', mount]);
  fs.rmSync(temp, { recursive: true, force: true });
}
