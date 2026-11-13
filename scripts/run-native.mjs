// 开发启动入口；产品运行当前平台的原生宿主。
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!['win32','darwin'].includes(process.platform)) {console.error('Lit Explorer 支持 Windows 和 macOS；跨平台界面验证请运行 npm test。');process.exit(1);}
execFileSync(process.execPath,[path.join(root,'mygo/stage-frontend.mjs')],{cwd:root,stdio:'inherit'});
const child=spawn('go',['run','.',...process.argv.slice(2)],{cwd:path.join(root,'mygo'),stdio:'inherit'});
child.on('exit',code=>process.exit(code||0));child.on('error',err=>{console.error(err.message);process.exit(1);});
