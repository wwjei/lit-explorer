'use strict';

/**
 * 不需要 Electron 的用例，毫秒级，迭代时优先跑这个。
 *
 *   S2  Markdown 渲染：链接协议白名单、属性转义、普通语法不退化
 *   S3  工作区路径边界：assertAllowed 按真实路径比较
 *   S4  渲染进程不能自行扩大授权根：offerRoot / isOfferedRoot
 *   S5  切换工作区后旧工作区不再可读：resetAllowedRoots
 *   S6  渲染进程提交的设置：字段白名单、窗口几何、项目路径校验
 *   S7  界面层路径比较：分隔符等价、大小写、相对根各段与排序
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
 * 不用把宿主进程的全局变量弄脏。共享契约要按 index.html 的顺序先加载。
 */
function loadRenderer() {
  const sandbox = { pv: { platform: process.platform } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'src/shared/contracts.js'), 'utf8'),
    sandbox, { filename: 'contracts.js' });
  for (const file of ['paths.js', 'highlight.js', 'markdown.js']) {
    const code = fs.readFileSync(path.join(ROOT, 'src/renderer', file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}

(async () => {
  await run('S2', 'Markdown 链接与转义', () => {
    const toHtml = loadRenderer().PV.markdown.toHtml;

    eq('属性转义同时处理单双引号',
      loadRenderer().PV.highlight.escapeAttr('<a b="c" \'d\'>'),
      '&lt;a b=&quot;c&quot; &#39;d&#39;&gt;');

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

    const front = toHtml('---\nname: <script>\nversion: 2.7.5\n---\n# Body');
    ok('front matter 不执行 HTML 并保留正文', front.includes('md-frontmatter') && front.includes('&lt;script&gt;') && front.includes('<h1>Body</h1>'), front);
    ok('没有闭合的分隔线不吞掉正文', toHtml('---\nplain').includes('plain'));
    const paths = loadRenderer().PV.paths;
    eq('相对链接解析父目录与编码空格', paths.resolveLink('/ws/docs/a.md', '../b%20c.md'), '/ws/b c.md');
    eq('无效编码不能生成路径', paths.resolveLink('/ws/a.md', '%zz'), null);

    // 图片：地址由主进程解析成 pv://；没有解析结果就落成占位，渲染器不猜路径
    const md = loadRenderer().PV.markdown;
    const imgMap = new Map([['figures/a b.png', {
      src: 'figures/a b.png', url: 'pv://local/C%3A/p/figures/a%20b.png?v=1-2'
    }]]);
    const img = md.toHtml('![分层 × 出包](<figures/a b.png> "图 <&>")', imgMap);
    ok('图片渲染成 <img>，地址用主进程给的 pv://',
      /<img src="pv:\/\/local\/[^"]+\?v=1-2"/.test(img), img);
    ok('alt 与标题都进了属性并转义',
      img.indexOf('alt="分层 × 出包"') >= 0 && img.indexOf('title="图 &lt;&amp;&gt;"') >= 0, img);
    ok('图片带懒加载', img.indexOf('loading="lazy"') >= 0, img);
    ok('不残留 !', img.indexOf('!') < 0, img);

    const remote = md.toHtml('![x](https://e.example/a.png?x=1&y=2)', imgMap);
    ok('远程图片直接用原地址（& 转义）',
      remote.indexOf('src="https://e.example/a.png?x=1&amp;y=2"') >= 0, remote);

    const protoRel = md.toHtml('![x](//host/x.png)');
    ok('协议相对地址按 https 处理（file:// 宿主里不会变成 file://主机名）',
      protoRel.indexOf('src="https://host/x.png"') >= 0, protoRel);

    for (const bad of ['javascript:1', 'data:image/png;base64,AA', 'file:///etc/passwd', 'vbscript:1']) {
      const html = md.toHtml('![x](' + bad + ')');
      ok('不生成图片：' + bad, html.indexOf('<img') < 0, html);
      ok('也不留下半截链接：' + bad, html.indexOf('<a ') < 0, html);
    }

    const miss = md.toHtml('![缺失](figures/nope.png)');
    ok('没有解析结果时落成占位（不产出 <img>）',
      miss.indexOf('<img') < 0 && miss.indexOf('md-img-missing') >= 0, miss);
    ok('占位里写明原因', miss.indexOf('无法读取') >= 0, miss);
    const gone = md.toHtml('![没了](figures/gone.png)',
      new Map([['figures/gone.png', { src: 'figures/gone.png', error: 'ENOENT' }]]));
    ok('主进程报 ENOENT 时占位写「文件不存在」', gone.indexOf('文件不存在') >= 0, gone);
    const denied = md.toHtml('![越界](../outside/x.png)',
      new Map([['../outside/x.png', { src: '../outside/x.png', error: 'EACCES_ROOT' }]]));
    ok('越界图片的占位写明不在工作区内', denied.indexOf('不在工作区内') >= 0, denied);

    const linkedImg = md.toHtml('[![a](<figures/a b.png>)](https://e.example)', imgMap);
    ok('图片可以嵌在链接文字里',
      /<a href="https:\/\/e\.example"[^>]*><img /.test(linkedImg), linkedImg);
    ok('行内代码里的图片语法不会变成图片',
      md.toHtml('`![a](<figures/a b.png>)`', imgMap).indexOf('<img') < 0);

    eqJson('imageSources 只收本地地址、去重、跳过代码块', md.imageSources([
      '![a](x.png)', '![](https://e.example/y.png)', '',
      '```', '![](skip.png)', '```', '',
      '![a](x.png)', '![b](<my fig.png>)'
    ].join('\n')), ['x.png', 'my fig.png']);

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
    ok('占位符不漏进输出', !/[\u0000\u0001]/.test(rich + injected + img + miss + linkedImg));

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
        { path: 'C:\\ok', icon: { type: 'image', data: 'data:text/html,<script>' } },
        { path: 'C:\\ok', icon: { type: 'text', text: ' 中文A ' } }
      ]
    }, (p) => offered.has(p));

    eq('不接收 window', patch.window, undefined);
    eq('不接收 lastRoot', patch.lastRoot, undefined);
    eq('不接收 recentRoots', patch.recentRoots, undefined);
    eq('普通偏好照常保存', patch.theme, 'dark');
    eq('previewWidth 有上限', patch.previewWidth, 10000);
    eq('leftSplitRatio 有范围', patch.leftSplitRatio, 0.92);
    eq('只保留主进程给过的项目', patch.projects.length, 3);
    eq('未授权的项目路径被丢弃',
      patch.projects.some((p) => p.path === 'C:\\Windows'), false);
    eq('非图片 data URL 的图标被丢弃', patch.projects[1].icon, null);
    eqJson('文字图标去掉空白并只留两个字符', patch.projects[2].icon, { type: 'text', text: '中文' });

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

    // 每个项目记住的固定列布局：结构、数量与数值都要收敛
    const nav = san.sanitizeNav({
      path: ['C:\\ws'],
      sel: 'C:\\ws\\a.md',
      mode: 'source',
      layout: {
        mainFloor: 99999,
        pins: [
          { w: 100, split: 2, panes: [
            { path: 'C:\\ws\\a.md', name: 'a.md', kind: 'md', mode: 'source', zoom: 99, continuous: true },
            { kind: 'web', url: ' HTTP://EXAMPLE.com/doc ', name: '文档' },
            { path: 'C:\\ws\\third.md', kind: 'md' }
          ] },
          { w: 500, split: 0.4, panes: [] },
          { w: 500, split: 0.4, panes: [{ path: 'C:\\ws\\b.md', kind: 'evil' }] },
          { w: 500, split: 0.4, panes: [{ path: 'C:\\ws\\c.md', kind: 'md' }] },
          { w: 500, split: 0.4, panes: [{ path: 'C:\\ws\\d.md', kind: 'md' }] }
        ]
      }
    });
    eq('固定列最多 3 列', nav.layout.pins.length, 3);
    eq('空列被丢掉、每列最多 2 格', nav.layout.pins[0].panes.length, 2);
    eq('宽度 / 分屏比例 / 主栏下限都有界',
      [nav.layout.pins[0].w, nav.layout.pins[0].split, nav.layout.mainFloor].join('|'),
      '240|0.8|10000');
    eq('文件格保留模式、缩放与连续预览',
      [nav.layout.pins[0].panes[0].mode, nav.layout.pins[0].panes[0].zoom,
        nav.layout.pins[0].panes[0].continuous].join('|'),
      'source|8|true');
    eq('网页格只留规范化后的 http(s) 地址',
      [nav.layout.pins[0].panes[1].url, nav.layout.pins[0].panes[1].path,
        nav.layout.pins[0].panes[1].kind].join('|'),
      'http://example.com/doc|http://example.com/doc|web');
    eq('未知文件类型退回 txt', nav.layout.pins[1].panes[0].kind, 'txt');
    eq('只有非法网页的布局整份丢弃',
      san.sanitizeNav({ layout: { pins: [{ panes: [{ kind: 'web', url: 'javascript:alert(1)' }] }] } }).layout,
      undefined);
  });

  await run('S7', '界面层路径比较与排序', () => {
    const p = loadRenderer().PV.paths;

    eq('反斜杠与斜杠等价', p.same('C:\\ws\\a.md', 'C:/ws/a.md'), true);
    eq('Windows 上大小写不敏感、其它平台区分大小写',
      p.same('C:\\WS\\A.MD', 'c:/ws/a.md'), process.platform === 'win32');
    eq('前缀相同的兄弟目录不在根内', p.within('C:\\ws', 'C:\\ws-evil\\x'), false);
    eq('根自身算在根内', p.within('C:\\ws', 'C:/ws'), true);
    eqJson('相对根的各段', p.partsUnder('C:\\ws', 'C:/ws/docs/a.md'), ['docs', 'a.md']);
    eq('根自身没有段', p.partsUnder('C:\\ws', 'C:\\ws\\').length, 0);
    eq('界外返回 null', p.partsUnder('C:\\ws', 'D:\\other\\a.md'), null);
    eq('副标题保留原分隔符', p.relUnder('C:\\ws', 'C:\\ws\\docs\\a.md'), 'docs\\a.md');
    eq('baseName 去掉末尾分隔符', p.baseName('C:\\ws\\a.md\\'), 'a.md');
    eq('目录排在文件前', p.compareNodes({ name: 'z', isDir: true }, { name: 'a', isDir: false }) < 0, true);
    eq('数字按数值排序', p.compareNodes({ name: 'a10', isDir: false }, { name: 'a2', isDir: false }) > 0, true);
  });

  await run('S8', '外部参考目录的授权、撤销与只读边界', async () => {
    const fsApi = require('../src/main/fs-api');
    const { createReferenceDirs } = require('../src/main/reference-dirs');
    const project = freshDir('reference-project');
    const other = freshDir('reference-other');
    const external = freshDir('reference-external');
    const file = path.join(external, 'ref.svg');
    fs.writeFileSync(file, '<svg/>');
    let state = {};
    let pick = async () => external;
    const service = createReferenceDirs({ fsApi,
      store: { load: async () => state, patch: async (p) => { state = { ...state, ...p }; } },
      pick: () => pick()
    });
    fsApi.resetAllowedRoots();
    const root = await fsApi.allowRoot(project);
    service.activate(root, []);
    const added = await service.add();
    eq('选择框添加真实目录', added.dirs.length, 1);
    eq('参考文件可读取', (await fsApi.readFileForPreview(file)).text, '<svg/>');
    let error;
    try { await fsApi.writeSvgFile(file, '<svg/>', {}); } catch (err) { error = err.code; }
    eq('参考目录不可写入 SVG', error, 'EREAD_ONLY');
    await service.add();
    eq('重复目录不重复保存', service.list().length, 1);
    const prepared = await service.prepare(root);
    eq('可从主进程设置恢复目录', prepared.length, 1);
    const link = path.join(external, 'escape');
    if (linkDir(other, link)) {
      error = null;
      try { await fsApi.assertAllowed(path.join(link, 'secret')); } catch (err) { error = err.code; }
      ok('参考目录中的链接不能越界', !!error, error);
    }
    const sanitized = require('../src/main/state-sanitize').sanitizePatch({ referenceDirs: { [root]: [other] } }, () => true);
    eq('页面设置不能伪造参考目录授权', Object.keys(sanitized).length, 0);
    await service.remove(external);
    error = null;
    try { await fsApi.assertAllowed(file); } catch (err) { error = err.code; }
    ok('移除后立即不可读', !!error, error);
    let choose;
    pick = () => new Promise((resolve) => { choose = resolve; });
    const pending = service.add();
    fsApi.resetAllowedRoots();
    const next = await fsApi.allowRoot(other);
    service.activate(next, []);
    choose(external);
    eq('项目切换后丢弃旧选择框结果', (await pending).error, 'SUPERSEDED');
    eq('新项目没有旧项目的参考目录', service.list().length, 0);
    fsApi.resetAllowedRoots();
  });

  await run('S9', '目录插件契约、飞书接口、权限及凭据隔离', async () => {
    const {createDirectoryPlugins, safeDocumentUrl, providers} = require('../src/main/directory-plugins');
    const manifest = require('../src/shared/directory-providers.json');
    const fixture = require('./fixtures/feishu-directory.json');
    let state = {}, requests = [], mode = 'normal';
    const store = {load: async()=>state, patch: async(p)=>{state={...state,...p};}};
    const fetch = async(raw, options)=>{
      const url=new URL(raw); requests.push({url,options});
      if (mode==='auth') return new Response('{}',{status:401});
      if (mode==='huge') return new Response('x'.repeat(2*1024*1024+1));
      let data;
      if (url.pathname.endsWith('batch_query')) data=JSON.parse(JSON.stringify(fixture.details));
      else if (url.searchParams.get('folder_token')==='folderA') data=fixture.nestedPage;
      else data=url.searchParams.get('page_token') ? fixture.lastPage : fixture.firstPage;
      if (mode==='unsafe') data.data.metas[0].url='https://feishu.cn.evil.example/docx/docA';
      return new Response(JSON.stringify(data));
    };
    const api=createDirectoryPlugins({store,fetch});
    api.activate('/project-a');
    const mount=await api.connect({providerId:'feishu-drive',rootId:'root',name:'资料库',token:'fixture-secret'});
    eq('内置飞书插件可发现',api.providers()[0].id,'feishu-drive');
    ok('设置中不包含访问令牌',!JSON.stringify(state).includes('fixture-secret'),state);
    const first=await api.list(mount.id,'root','');
    eq('列表标准化目录节点',first.entries[0].kind,'directory');
    eq('连接首屏命中缓存，不重复请求',requests.length,1);
    eq('分页标记来自官方响应字段',first.nextCursor,'next-page');
    const second=await api.list(mount.id,'root',first.nextCursor);
    eq('第二页正确归一化',second.entries[0].type,'sheet');
    const nested=await api.list(mount.id,'folderA','');
    eq('已发现的子目录可以浏览',nested.entries[0].id,'docB');
    const opened=await api.open(mount.id,'docA');
    eq('打开文档重新获取实际在线链接',opened.url,'https://tenant.feishu.cn/docx/docA');
    eq('打开使用最新标题',opened.name,'设计说明（最新）');
    const request=requests[requests.length-1];
    eq('元数据接口是 POST',request.options.method,'POST');
    eqJson('飞书请求开启 with_url',JSON.parse(request.options.body),{request_docs:[{doc_token:'docA',doc_type:'docx'}],with_url:true});
    ok('认证仅发给固定 API 域名且不跟随重定向',requests.every(r=>r.url.origin==='https://open.feishu.cn'&&r.options.headers.Authorization==='Bearer fixture-secret'&&r.options.redirect==='error'));
    async function rejected(title,fn,expected) { let code;try {await fn();}catch(err){code=err.code;}eq(title,code,expected); }
    await rejected('不能查询未发现节点',()=>api.list(mount.id,'outside',''),'OUTSIDE_MOUNT');
    await rejected('不能伪造其他目录的分页标记',()=>api.list(mount.id,'root','forged'),'OUTSIDE_MOUNT');
    mode='unsafe';await rejected('不能打开伪装的文档域名',()=>api.open(mount.id,'docA'),'UNSAFE_URL');
    mode='huge';await rejected('API 响应体有上限',()=>api.list(mount.id,'root','',true),'RESPONSE_TOO_LARGE');
    mode='auth';await rejected('令牌过期使用稳定错误码',()=>api.list(mount.id,'root','',true),'AUTH_REQUIRED');
    eq('令牌过期后清除连接',(await api.mounts())[0].connected,false);
    mode='normal';await api.connect({id:mount.id,token:'fixture-secret'});
    api.activate('/project-b');
    await rejected('切项目后旧连接不能读取',()=>api.list(mount.id,'root',''),'AUTH_REQUIRED');
    eq('其他项目不显示旧挂载',(await api.mounts()).length,0);
    api.activate('/project-a');
    eq('重开仅恢复配置，不恢复凭据',(await api.mounts())[0].connected,false);
    await api.connect({id:mount.id,token:'fixture-secret'});
    await api.remove(mount.id);
    eq('移除后持久化记录清空',(await api.mounts()).length,0);
    await rejected('移除后不再读取',()=>api.list(mount.id,'root',''),'AUTH_REQUIRED');
    let invalid;try {safeDocumentUrl('file:///etc/passwd',manifest.providers[0]);}catch(err){invalid=err.code;}
    eq('文档打开禁止本机文件协议',invalid,'UNSAFE_URL');
    let bad;try{providers({...manifest,apiVersion:99});}catch(err){bad=err.code;}
    eq('未知插件契约版本拒绝加载',bad,'PLUGIN_VERSION');
    let release;
    const pending=createDirectoryPlugins({store,fetch:(_u,options)=>new Promise((resolve,reject)=>{
      release=()=>resolve(new Response(JSON.stringify(fixture.firstPage)));
      options.signal.addEventListener('abort',()=>reject(new Error('aborted')));
    })});
    pending.activate('/project-a');
    const connect=pending.connect({providerId:'feishu-drive',rootId:'root',name:'等待',token:'fixture-secret'});
    while(!release) await new Promise(resolve=>setImmediate(resolve));
    pending.activate('/project-b');
    await rejected('切换项目会取消连接中的请求',()=>connect,'SUPERSEDED');
    release=null; pending.activate('/project-a');
    const cancelConnect=pending.connect({providerId:'feishu-drive',rootId:'root',name:'取消',token:'fixture-secret',attemptId:'attempt-a'});
    while(!release) await new Promise(resolve=>setImmediate(resolve));
    pending.cancel('attempt-a');
    await rejected('关闭表单会取消验证中的连接',()=>cancelConnect,'SUPERSEDED');

    // 用不同的 origin、路径和 JSON 字段验证宿主没有写死飞书协议。
    const custom=JSON.parse(JSON.stringify(manifest)); const p=custom.providers[0];
    p.id='fixture-provider';p.name='示例插件';p.apiOrigin='https://api.example.com';p.documentHosts=['docs.example.com'];p.success={field:'status',value:'ok'};
    p.list.path='/v1/folders/$nodeId/items';p.list.query={cursor:'$cursor'};p.list.entries='payload.nodes';p.list.cursor='payload.cursor';p.list.hasMore='payload.more';p.list.fields={id:'id',name:'label',type:'kind',url:'link'};
    p.details.path='/v1/metadata';p.details.entries='payload.nodes';p.details.fields=p.list.fields;
    const generic=createDirectoryPlugins({store,manifest:custom,fetch:async(url)=>{
      ok('其他插件可使用自己的 API 路径',url.startsWith('https://api.example.com/v1/folders/root/items'),url);
      return new Response(JSON.stringify({status:'ok',payload:{nodes:[{id:'example',label:'通用节点',kind:'folder'}],more:false}}));
    }});
    generic.activate('/generic');
    const example=await generic.connect({providerId:'fixture-provider',rootId:'root',name:'通用来源',token:'fixture-secret'});
    eq('同一插件宿主可加载不同服务的字段映射',(await generic.list(example.id,'root','')).entries[0].name,'通用节点');
  });

  await run('S10', 'Wiki 目录挂载与移除单文档入口', async () => {
    const {createDirectoryPlugins}=require('../src/main/directory-plugins');
    const fixture=require('./fixtures/feishu-directory.json');
    let state={},calls=[];
    const api=createDirectoryPlugins({store:{load:async()=>state,patch:async(p)=>{state={...state,...p};}},fetch:async(raw,options)=>{
      const url=new URL(raw);calls.push({url,options});let data;
      if(url.pathname.endsWith('get_node')) data=fixture.wikiRoot;
      else if(url.pathname.includes('/wiki/')) data=fixture.wikiPage;
      else {
        const doc=JSON.parse(options.body).request_docs[0];
        data={code:0,data:{metas:[{doc_token:doc.doc_token,doc_type:doc.doc_type,title:'在线文档 '+doc.doc_token,url:'https://tenant.feishu.cn/docx/'+doc.doc_token}]}};
      }
      return new Response(JSON.stringify(data));
    }});
    api.activate('/specific');
    for (const providerId of ['feishu-document','feishu-wiki-document']) {
      let error; try { await api.connect({providerId,rootId:'docA',token:'fixture-secret'}); } catch (err) {error=err.code;}
      eq('已取消单文档入口 '+providerId,error,'BAD_REQUEST');
    }
    const wiki=await api.connect({providerId:'feishu-wiki',rootId:'https://tenant.feishu.cn/wiki/wikiRoot',name:'我的 Wiki 目录',token:'fixture-secret'});
    eq('Wiki 节点作为目录入口',wiki.rootKind,'directory');
    const page=await api.list(wiki.id,'wikiRoot','');
    eq('Wiki 目录返回子节点',page.entries[0].id,'wikiChild');
    eq('Wiki 叶子文档可直接点击打开',page.entries[0].kind,'document');
    eq('Wiki 子节点保留实际文档标识',page.entries[0].documentId,'wikiDocChild');
    ok('Wiki 查询绑定解析得到的知识空间',calls.some(c=>c.url.pathname==='/open-apis/wiki/v2/spaces/space123/nodes'&&c.url.searchParams.get('parent_node_token')==='wikiRoot'));
    eq('Wiki 节点自身也能打开文档',(await api.open(wiki.id,'wikiRoot')).url,'https://tenant.feishu.cn/docx/wikiDocRoot');
    eq('Wiki 子项打开实体文档链接',(await api.open(wiki.id,'wikiChild')).url,'https://tenant.feishu.cn/docx/wikiDocChild');
    eq('Wiki 目录详情来自节点接口',(await api.details(wiki.id,'wikiRoot')).name,'知识库入口');
    ok('文档与目录配置均不包含令牌',!JSON.stringify(state).includes('fixture-secret'));
  });

  await run('S12', '金山文件夹：双字段分页、子目录快捷项与只读分享链接', async () => {
    const {createDirectoryPlugins,invokeDirectoryPlugin}=require('../src/main/directory-plugins');
    const fixture=require('./fixtures/kdocs-directory.json');
    let saved={}, calls=[], mode='normal';
    const api=createDirectoryPlugins({store:{load:async()=>saved,patch:async(p)=>{saved={...saved,...p};}},fetch:async(raw,options)=>{
      const url=new URL(raw);calls.push({url,options});
      let data=fixture[mode];
      if(!data) data=url.pathname.endsWith('/links') ? fixture.link : url.searchParams.get('parent_id') ? fixture.nestedPage : url.searchParams.has('offset') ? fixture.lastPage : fixture.firstPage;
      return new Response(JSON.stringify(data));
    }});
    api.activate('/kdocs');
    const descriptor=api.providers().find(p=>p.id==='kdocs-personal');
    ok('金山提供默认我的文档入口',!!descriptor.defaultRootId);
    eq('金山不复用飞书设备授权',descriptor.browserAuth,false);
    const root=await api.connect({providerId:'kdocs-personal',rootId:'',name:'我的金山文档',token:'fixture-secret'});
    eq('根节点始终为目录',root.rootKind,'directory');
    const first=await api.list(root.id,root.rootId,'');
    eq('文件夹 ID 使用本应用 open_id',first.entries[0].id,'folder_A');
    eq('数值修改时间正确标准化',first.entries[0].modifiedAt,'1700000010');
    eq('首次请求省略 parent_id',calls[0].url.searchParams.has('parent_id'),false);
    ok('令牌按官方要求放查询参数且不放 Bearer',calls.every(c=>c.url.hostname==='developer.kdocs.cn'&&c.url.searchParams.get('access_token')==='fixture-secret'&&!c.options.headers.Authorization&&c.options.redirect==='error'));
    eqJson('零偏移量与 file 过滤器同时保存',JSON.parse(first.nextCursor),{offset:0,filter:'file'});
    const last=await api.list(root.id,root.rootId,first.nextCursor);
    eq('offset=0 不是结束标志',last.entries[0].id,'file_B');
    eq('只以 -1 表示分页结束',last.nextCursor,'');
    eq('第二页完整回传 filter',calls.at(-1).url.searchParams.get('filter'),'file');
    const bad=await invokeDirectoryPlugin(api,'list',{mountId:root.id,nodeId:root.rootId,cursor:'{"offset":900,"filter":"file"}'});
    eq('不接受伪造复合分页',bad.error,'OUTSIDE_MOUNT');
    const nested=await api.list(root.id,'folder_A','');
    eq('子目录文件可被发现',nested.entries[0].id,'file_A');
    eq('详情来自已获取的列表元数据',(await api.details(root.id,'file_A')).name,'接口说明');
    const pinned=await api.pin(root.id,'folder_A');
    eq('将子文件夹独立加入快捷访问',pinned.rootId,'folder_A');
    eq('重复添加复用同一快捷项',(await api.pin(root.id,'folder_A')).id,pinned.id);
    eq('文件不能作为目录快捷项',(await invokeDirectoryPlugin(api,'pin',{mountId:root.id,nodeId:'file_A'})).error,'BAD_REQUEST');
    await api.remove(root.id);
    eq('移除我的文档后独立文件夹仍能打开',(await api.open(pinned.id,'file_A')).url,'https://www.kdocs.cn/l/fixtureDoc');
    ok('仅读接口，不创建或修改分享',calls.every(c=>c.options.method==='GET'));
    ok('设置不保存凭据或接口地址',!/fixture-secret|access_token|developer.kdocs.cn/.test(JSON.stringify(saved)));
    mode='missingLink';
    eq('无分享时给出明确错误',(await invokeDirectoryPlugin(api,'open',{mountId:pinned.id,nodeId:'file_A'})).error,'LINK_UNAVAILABLE');
    mode='limited';
    eq('业务限流码归一化',(await invokeDirectoryPlugin(api,'list',{mountId:pinned.id,nodeId:'folder_A',refresh:true})).error,'RATE_LIMITED');
    mode='forbidden';
    eq('授权范围不匹配归一化为无权限',(await invokeDirectoryPlugin(api,'list',{mountId:pinned.id,nodeId:'folder_A',refresh:true})).error,'FORBIDDEN');
    mode='expired';
    eq('过期令牌要求重新连接',(await invokeDirectoryPlugin(api,'list',{mountId:pinned.id,nodeId:'folder_A',refresh:true})).error,'AUTH_REQUIRED');
    eq('令牌过期后断开快捷项',(await api.mounts())[0].connected,false);
    eq('不猜测普通网页链接中的目录 ID',(await invokeDirectoryPlugin(api,'connect',{providerId:'kdocs-personal',rootId:'https://www.kdocs.cn/mine/123',token:'fixture-secret'})).error,'BAD_REQUEST');
  });

  await run('S11', '飞书设备授权：本机凭据、注册、取消与刷新', async () => {
    const { createFeishuAuth, verificationURL } = require('../src/main/feishu-auth');
    const fixture = require('./fixtures/feishu-auth.json');
    let clock = 100000, queue = [], calls = [];
    const auth = createFeishuAuth({ now: () => clock, fetch: async (raw, options) => {
      calls.push({ url: raw, form: Object.fromEntries(new URLSearchParams(options.body)), headers: options.headers });
      return new Response(JSON.stringify(queue.shift()), { status: 200 });
    } });
    const rejected = async (label, task, code) => {
      let actual; try { await task(); } catch (err) { actual = err.code; } eq(label, actual, code);
    };
    queue = [fixture.registration, fixture.registered, fixture.device, fixture.pending, fixture.slow, fixture.token];
    const started = await auth.start({mode:'personal',attemptId:'attempt'});
    eq('先创建本机个人应用', started.phase, 'registration');
    ok('注册链接只指向飞书官方', started.url.startsWith('https://open.feishu.cn/page/cli?'));
    eq('提前轮询不发送网络请求', (await auth.poll('attempt')).phase, 'registration');
    eq('宿主执行轮询间隔', calls.length, 1);
    clock += 1000;
    eq('创建应用后进入设备授权', (await auth.poll('attempt')).phase, 'authorization');
    eq('只读权限声明一致', calls[2].form.scope, require('../src/shared/feishu-auth.json').scopes);
    ok('应用密钥仅发给认证端点', calls[2].headers.Authorization.startsWith('Basic '));
    clock += 1000; eq('等待确认', (await auth.poll('attempt')).phase, 'authorization');
    clock += 1000; eq('slow_down 增加轮询间隔', (await auth.poll('attempt')).interval, 6);
    clock += 6000;
    const ready = await auth.poll('attempt');
    eq('用户确认后已就绪', ready.phase, 'ready');
    ok('界面响应不含凭据', !/access-fixture|refresh-fixture|local-app-secret|login-device/.test(JSON.stringify(ready)));
    const credential = auth.take('attempt'), controller = new AbortController();
    await rejected('授权结果只能交给一个挂载', () => auth.take('attempt'), 'AUTH_REQUIRED');
    eq('宿主内部领取 Bearer 令牌', await credential.token(controller.signal), 'access-fixture');
    clock += 100000; queue = [fixture.refreshed];
    eqJson('并发读取共享一次刷新', await Promise.all([credential.token(controller.signal), credential.token(controller.signal)]), ['access-refreshed','access-refreshed']);
    eq('刷新使用 refresh_token', calls.at(-1).form.grant_type, 'refresh_token');
    eq('旋转前使用当前刷新令牌', calls.at(-1).form.refresh_token, 'refresh-fixture');
    const before = calls.length;
    await credential.token(controller.signal); eq('有效期内不重复刷新', calls.length, before);
    clock += 7200000; queue = [fixture.denied];
    await rejected('刷新被撤销后要求重新授权', () => credential.token(controller.signal), 'AUTH_REQUIRED');
    const revokedCalls = calls.length;
    await rejected('已失效凭据不反复交换', () => credential.token(controller.signal), 'AUTH_REQUIRED');
    eq('撤销后不再发送刷新请求', calls.length, revokedCalls);
    controller.abort(); await rejected('断开连接后禁止读取凭据', () => credential.token(controller.signal), 'SUPERSEDED');
    queue = [fixture.device, fixture.denied];
    await auth.start({mode:'application',attemptId:'denied',appId:'cli_fixture',appSecret:'own-secret'}); clock += 1000;
    await rejected('拒绝授权只返回稳定错误码', () => auth.poll('denied'), 'AUTH_DENIED');
    queue = [fixture.device];
    await auth.start({mode:'application',attemptId:'expired',appId:'cli_fixture',appSecret:'own-secret'}); clock += 241000;
    await rejected('设备码到期终止', () => auth.poll('expired'), 'AUTH_EXPIRED');
    queue = [fixture.device, {...fixture.token, token_type:'DPoP'}];
    await auth.start({mode:'application',attemptId:'dpop',appId:'cli_fixture',appSecret:'own-secret'}); clock += 1000;
    await rejected('不把 DPoP 当作 Bearer', () => auth.poll('dpop'), 'AUTH_UNSUPPORTED');
    queue = [fixture.device];
    await auth.start({mode:'application',attemptId:'cancel',appId:'cli_fixture',appSecret:'own-secret'}); auth.clear();
    await rejected('切项目清除待授权凭据', () => auth.poll('cancel'), 'AUTH_REQUIRED');
    for (const url of ['https://evil.test/auth','https://accounts.feishu.cn.evil.test','https://x@accounts.feishu.cn','http://accounts.feishu.cn']) {
      await rejected('拒绝不可信授权地址 '+url, () => verificationURL(url), 'UNSAFE_URL');
    }
    let inFlight;
    const blocked = createFeishuAuth({ fetch: (_url, options) => new Promise((_resolve,reject) => {
      inFlight = options.signal; options.signal.addEventListener('abort', () => reject(new Error('abort')));
    }) });
    const job = blocked.start({mode:'personal',attemptId:'blocked'});
    blocked.cancel('blocked');
    await rejected('关闭表单中止 begin 请求', () => job, 'SUPERSEDED');
    ok('底层请求被取消', inFlight.aborted);
  });

  done();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
