// 当前用户的 Windows 文件夹菜单，不需要管理员权限。
'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const KEY = 'HKCU\\Software\\Classes\\Directory\\shell\\LitExplorer';
async function configure(enable, executable) {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows');
  if (!enable) {
    try { await run('reg.exe', ['delete', KEY, '/f'], { windowsHide: true }); }
    catch (err) { if (err.code !== 1) throw err; }
    return;
  }
  await run('reg.exe', ['add', KEY, '/ve', '/d', '用 Lit 打开', '/f'], { windowsHide: true });
  await run('reg.exe', ['add', KEY, '/v', 'Icon', '/d', executable, '/f'], { windowsHide: true });
  await run('reg.exe', ['add', KEY + '\\command', '/ve', '/d', '"' + executable + '" "--open=%1"', '/f'], { windowsHide: true });
}
module.exports = { configure };
