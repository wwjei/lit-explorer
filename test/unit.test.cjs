'use strict';

/**
 * 不需要 Electron 的用例，毫秒级，迭代时优先跑这个。
 *
 *   S2  Markdown 渲染：链接协议白名单、属性转义、普通语法不退化
 *   S3  工作区路径边界：assertAllowed 按真实路径比较
 *   S4  渲染进程不能自行扩大授权根：offerRoot / isOfferedRoot
 *   S5  切换工作区后旧工作区不再可读：resetAllowedRoots
 *   S6  渲染进程提交的设置：字段白名单、窗口几何、项目路径校验
 *
 * 跑法：npm run test:unit                     全跑
 *       npm run test:unit -- --only=S2        只跑一段
 *       npm run test:unit -- --list           列出段落 id
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, run, ok, eq, eqJson, done, freshDir, linkDir } = require('./helpers.cjs');

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

    // 行内代码占位符不能落进 href：否则回填 <code> 时会把代码里的引号带进属性
    const codeInUrl = toHtml('[x](http://a`"onclick="window.__x=1//`)');
    ok('地址里含行内代码时不生成链接', codeInUrl.indexOf('<a ') < 0, codeInUrl);
    ok('代码里的引号被转义成实体', codeInUrl.indexOf('&quot;onclick=') >= 0, codeInUrl);
    ok('协议名里夹控制字符不生成链接',
      toHtml('[x](java\u0001script:1)').indexOf('<a ') < 0);
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

  await run('S4', '渲染进程不能自行扩大授权根', () => {
    const fsApi = require(path.join(ROOT, 'src/main/fs-api.js'));
    const sample = path.join(ROOT, 'sample-project');
    const other = path.join(ROOT, 'docs');

    eq('主进程没给过的目录打不开', fsApi.isOfferedRoot(sample), false);
    fsApi.offerRoot(sample);
    eq('给过之后可以打开', fsApi.isOfferedRoot(sample), true);
    eq('别的目录仍然打不开', fsApi.isOfferedRoot(other), false);
    eq('空值打不开', fsApi.isOfferedRoot(''), false);
    eq('路径写法归一后仍算同一个', fsApi.isOfferedRoot(path.join(sample, 'sub', '..')), true);
    if (process.platform === 'win32') {
      eq('Windows 上大小写不同仍算同一个', fsApi.isOfferedRoot(sample.toUpperCase()), true);
    }
    eq('offerRoot 返回原值（便于链式使用）', fsApi.offerRoot(sample), sample);
  });

  await run('S5', '切换工作区后旧工作区不再可读', async () => {
    const fsApi = require(path.join(ROOT, 'src/main/fs-api.js'));

    const first = freshDir('ws-first');
    const second = freshDir('ws-second');
    fs.writeFileSync(path.join(first, 'a.txt'), 'FIRST');
    fs.writeFileSync(path.join(second, 'b.txt'), 'SECOND');
    const read = (p) => fsApi.readFileForPreview(p).then((r) => r.text || r.error, (e) => e.code);

    fsApi.resetAllowedRoots();
    await fsApi.allowRoot(first);
    eq('第一个工作区可读', await read(path.join(first, 'a.txt')), 'FIRST');
    eq('第二个工作区此时不可读', await read(path.join(second, 'b.txt')), 'EACCES_ROOT');

    // openWorkspace 切换工作区时就是这两步
    fsApi.resetAllowedRoots();
    await fsApi.allowRoot(second);
    eq('切换后新工作区可读', await read(path.join(second, 'b.txt')), 'SECOND');
    eq('切换后旧工作区不再可读', await read(path.join(first, 'a.txt')), 'EACCES_ROOT');
  });

  await run('S6', '渲染进程提交的设置：字段白名单与路径校验', () => {
    const san = require(path.join(ROOT, 'src/main/state-sanitize.js'));

    const bounds = san.windowBounds({
      width: 1200, height: 800, x: 10, y: -20,
      webPreferences: { sandbox: false, nodeIntegration: true }
    });
    eqJson('窗口参数只保留几何字段', bounds, { width: 1200, height: 800, x: 10, y: -20 });
    eq('宽高不可用时返回 null', san.windowBounds({ webPreferences: { sandbox: false } }), null);
    eq('离谱的宽高被拒绝', san.windowBounds({ width: 10, height: 10 }), null);

    const offered = new Set(['C:\\ok']);
    const patch = san.sanitizePatch({
      theme: 'dark',
      previewOpen: false,
      previewWidth: 99999,
      leftSplitRatio: 5,
      window: { width: 1200, height: 800, webPreferences: { sandbox: false } },
      lastRoot: 'C:\\Windows',
      recentRoots: ['C:\\Windows'],
      projects: [
        { path: 'C:\\ok', name: 'ok', icon: { type: 'glyph', id: 'code' } },
        { path: 'C:\\Windows', name: 'bad' },
        { path: 'C:\\ok', icon: { type: 'image', data: 'data:text/html,<script>' } }
      ]
    }, (p) => offered.has(p));

    eq('不接收 window', patch.window, undefined);
    eq('不接收 lastRoot', patch.lastRoot, undefined);
    eq('不接收 recentRoots', patch.recentRoots, undefined);
    eq('普通偏好照常保存', patch.theme, 'dark');
    eq('previewWidth 有上限', patch.previewWidth, 10000);
    eq('leftSplitRatio 有范围', patch.leftSplitRatio, 0.92);
    eq('只保留主进程给过的项目', patch.projects.length, 2);
    eq('未授权的项目路径被丢弃',
      patch.projects.some((p) => p.path === 'C:\\Windows'), false);
    eq('非图片 data URL 的图标被丢弃', patch.projects[1].icon, null);

    // 网页快捷方式：只认 http(s)，且不能借网页条目把 path 写进设置
    const webUrl = require(path.join(ROOT, 'src/main/web-url.js'));
    eq('http(s) 地址规范化', webUrl.normalizeWebUrl(' HTTP://A.EXAMPLE '), 'http://a.example/');
    eq('危险 / 本地 / 带凭据的地址一律拒绝',
      ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,x', 'ms-msdt:/id',
        'https://user:pass@a.example/', 'https://a.example/\tfoo']
        .map(webUrl.normalizeWebUrl).join('|'), '|||||');

    const list = san.sanitizeFavorites({
      'c:\\ws': [
        { path: 'C:\\ws\\a.md', name: 'a', isDir: false, kind: 'md' },
        { kind: 'web', url: 'https://example.com/doc?x=1#h', name: '文档' },
        { kind: 'web', url: 'https://example.com/doc?x=1#h', name: '重复' },
        { kind: 'web', url: 'javascript:alert(1)', name: 'bad' },
        { kind: 'web', url: 'https://example.com/no-name' },
        { kind: 'web', url: 'https://example.com/no-name', path: 'C:\\Windows\\evil' }
      ]
    })['c:\\ws'];
    eq('网页条目只留合法且去重的', list.length, 3);
    eq('网页条目保留地址 / kind / 默认域名',
      [list[1].url, list[1].kind, list[2].name].join('|'),
      'https://example.com/doc?x=1#h|web|example.com');
    eq('网页条目不带 path（不能借它注入路径）',
      list.filter((f) => f.kind === 'web' && Object.prototype.hasOwnProperty.call(f, 'path')).length, 0);
    eq('文件条目照常保留', list[0].path, 'C:\\ws\\a.md');
  });

  done();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
