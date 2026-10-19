/**
 * 跑一个界面探针。
 *
 * 把 test/probe-harness.js（选择器与等待的骨架，挂在 window.H 上）与探针文件
 * 拼成一个脚本，交给截图钩子的 --shot-js 执行；走的是 npm run shot，
 * 所以会先 build，不会拿到过期的产物。
 *
 * 用法：
 *   npm run probe -- <探针文件> [截图钩子的其他参数]
 *   npm run probe -- .tmp/my-probe.js --open=.tmp/panews --shot=.tmp/p.png
 *
 * 默认带独立的 --user-data-dir，不会碰你正在用的实例。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const probe = argv.find((a) => !a.startsWith('--'));

if (!probe || argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '跑一个界面探针（骨架 + 探针文件拼起来交给截图钩子）',
    '',
    '  npm run probe -- <探针文件> [截图钩子的参数]',
    '',
    '  探针文件用 H.* 写（见 test/probe-harness.js 顶部的选择器约定），',
    '  返回值会以 [shot-js] {...} 打到 stdout。',
    '',
    '例：',
    '  npm run probe -- .tmp/my-probe.js --open=.tmp/panews --shot=.tmp/p.png',
    '',
    '截图钩子的参数见 npm run shot -- --help。'
  ].join('\n'));
  process.exit(probe ? 0 : 1);
}

const probePath = path.resolve(root, probe);
const combined = path.join(root, '.tmp', 'probe-run.js');
mkdirSync(path.dirname(combined), { recursive: true });
writeFileSync(
  combined,
  readFileSync(path.join(root, 'test/probe-harness.js'), 'utf8') + '\n' + readFileSync(probePath, 'utf8')
);

const rest = argv.filter((a) => a !== probe);
const has = (name) => rest.some((a) => a.indexOf(name) === 0);
if (!has('--open=')) console.log('[probe] 没给 --open，会停在欢迎页；探针一般都要指定一个工作区');
const args = ['.'].concat(rest);
if (!has('--shot=')) args.push('--shot=.tmp/probe.png');
if (!has('--shot-delay=')) args.push('--shot-delay=2000');
if (!has('--user-data-dir')) args.push('--user-data-dir=.tmp/probe-profile');
args.push('--shot-js=' + path.relative(root, combined).split(path.sep).join('/'));

// shell 模式下参数是自己拼的，带空格的路径要加引号
const quote = (s) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);
const line = ['npm', 'run', 'shot', '--'].concat(args.map(quote)).join(' ');

console.log('[probe] ' + path.relative(root, probePath) + ' → ' + path.relative(root, combined));
const child = spawn(line, { cwd: root, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code || 0));
