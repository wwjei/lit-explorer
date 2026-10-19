'use strict';

/**
 * 不需要 Electron 的用例，毫秒级，迭代时优先跑这个。
 *
 *   S2  Markdown 渲染：链接协议白名单、属性转义、普通语法不退化
 *   S3  工作区路径边界：assertAllowed 按真实路径比较
 *
 * 跑法：npm run test:unit                     全跑
 *       npm run test:unit -- --only=S2        只跑一段
 *       npm run test:unit -- --list           列出段落 id
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, run, ok, eq, done, freshDir, linkDir } = require('./helpers.cjs');

/**
 * 在沙箱里加载渲染进程的 IIFE 模块。
 * 它们只通过 window.PV 互相引用，沙箱里让 window 指向自己即可，
 * 不用把宿主进程的全局变量弄脏。
 */
function loadRenderer() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['highlight.js', 'markdown.js']) {
    const code = fs.readFileSync(path.join(ROOT, 'src/renderer', file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}

(async () => {
  await run('S2', 'Markdown 链接与转义', () => {
    const toHtml = loadRenderer().PV.markdown.toHtml;

    const injected = toHtml('[click](#"onclick="window.__x=1)');
    ok('引号逃不出 href 属性（没有 on* 属性）', !/\son[a-z]+\s*=/i.test(injected), injected);
    ok('payload 被关在 href 值里', injected.indexOf('href="#%22onclick=') >= 0, injected);

    for (const bad of ['javascript:1', 'JaVaScRiPt:1', 'data:text/html,x', 'vbscript:1', 'file:///etc/passwd']) {
      const html = toHtml('[x](' + bad + ')');
      ok('不生成危险协议链接：' + bad, html.indexOf('<a ') < 0, html);
    }

    const good = toHtml('[a](https://e.example/x?y=1&z=2) [b](mailto:x@e.example) [c](./rel.md) [d](#sec)');
    eq('白名单内的链接都保留', (good.match(/<a /g) || []).length, 4);
    ok('查询串里的 & 没有被破坏', good.indexOf('y=1&amp;z=2') >= 0, good);

    ok('原始 HTML 仍被转义', toHtml('<img src=x onerror=1>').indexOf('&lt;img') >= 0);
    eq('渲染器不产出 <img>（图片语法与内嵌 HTML 都不支持）',
      (toHtml('![a](b.png)\n\n<img src="c.png">').match(/<img/g) || []).length, 0);

    const rich = toHtml([
      '# H', '', '**粗** *斜* `码` ~~删~~', '',
      '- a', '- b', '', '> q', '',
      '| a | b |', '| --- | --- |', '| 1 | 2 |', '',
      '```js', 'const x = 1;', '```'
    ].join('\n'));
    ok('标题', rich.indexOf('<h1>') >= 0);
    ok('加粗 / 斜体 / 行内代码 / 删除线',
      /<strong>/.test(rich) && /<em>/.test(rich) && /<code>/.test(rich) && /<del>/.test(rich));
    eq('列表项', (rich.match(/<li>/g) || []).length, 2);
    ok('引用', rich.indexOf('<blockquote>') >= 0);
    eq('表格单元', (rich.match(/<td>/g) || []).length, 2);
    ok('围栏代码块', rich.indexOf('md-code') >= 0);
    ok('链接文字里的行内样式仍然生效',
      toHtml('[**粗** 和 `码`](https://x.example)').indexOf('<code>码</code>') >= 0);
    ok('占位符不漏进输出', !/[\u0000\u0001]/.test(rich + injected));
  });

  await run('S3', '工作区路径边界', async () => {
    const fsApi = require(path.join(ROOT, 'src/main/fs-api.js'));

    const ws = freshDir('ws');
    const outside = freshDir('outside');
    const sibling = freshDir('ws-evil');
    fs.writeFileSync(path.join(outside, 'marker.txt'), 'OUTSIDE');
    fs.writeFileSync(path.join(sibling, 'marker.txt'), 'SIBLING');
    fs.writeFileSync(path.join(ws, 'inside.txt'), 'INSIDE');

    const linked = linkDir(outside, path.join(ws, 'linked'));
    ok('能建出目录链接（junction）', linked);

    await fsApi.allowRoot(ws);
    const read = (p) => fsApi.readFileForPreview(p).then((r) => r.text || r.error, (e) => e.code);

    eq('工作区内的文件可读', await read(path.join(ws, 'inside.txt')), 'INSIDE');
    if (linked) {
      eq('链接指向外部时被拒', await read(path.join(ws, 'linked', 'marker.txt')), 'EACCES_ROOT');
    }
    eq('未授权目录被拒', await read(path.join(outside, 'marker.txt')), 'EACCES_ROOT');
    eq('前缀相同的兄弟目录被拒（不是裸前缀比较）',
      await read(path.join(sibling, 'marker.txt')), 'EACCES_ROOT');
    if (process.platform === 'win32') {
      eq('Windows 上大小写不同的同一路径仍放行',
        await fsApi.assertAllowed(path.join(ws.toUpperCase(), 'inside.txt')).then(() => 'ok', (e) => e.code),
        'ok');
    }

    const entries = (await fsApi.listDir(ws)).entries;
    ok('列表里越界链接标成 blocked',
      !!((entries.find((e) => e.name === 'linked') || {}).blocked));
    ok('普通条目不带 blocked',
      !((entries.find((e) => e.name === 'inside.txt') || {}).blocked));

    eq('assertAllowed 返回真实路径（调用方拿到的就是校验过的那一份）',
      await fsApi.assertAllowed(path.join(ws, 'inside.txt')),
      fs.realpathSync(path.join(ws, 'inside.txt')));
  });

  done();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
