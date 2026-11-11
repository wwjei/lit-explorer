// Windows 原生探针；独立 profile 和实例锁，不操作用户实例。
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2),probe=argv.find(arg=>!arg.startsWith('--'));
if(!probe || argv.includes('--help')) {
 console.log('npm run probe -- <探针.js> [--open=目录] [--hold=毫秒]；使用 test/probe-harness.js 的 H.*，结果打印到终端。');
 process.exit(probe?0:1);
}
const combined=path.join(root,'.tmp/probe-run.js');mkdirSync(path.dirname(combined),{recursive:true});
writeFileSync(combined,readFileSync(path.join(root,'test/probe-harness.js'),'utf8')+'\n'+readFileSync(path.resolve(root,probe),'utf8'));
execFileSync(process.execPath,[path.join(root,'scripts/build-renderer.mjs')],{cwd:root,stdio:'inherit'});
const rest=argv.filter(arg=>arg!==probe);
if(!rest.some(arg=>arg.startsWith('--user-data-dir='))) rest.push('--user-data-dir='+path.join(root,'.tmp/probe-profile'));
rest.push('--eval='+combined);
const child=spawn(process.execPath,[path.join(root,'scripts/run-native.mjs'),...rest],{cwd:root,stdio:'inherit'});
child.on('exit',code=>process.exit(code||0));
