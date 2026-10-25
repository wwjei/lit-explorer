'use strict';

/**
 * 需要 Electron 的用例。每段都要付一次 Electron 启动的固定成本，迭代时用 --only
 * 挑相关的那一段跑，别整跑。
 *
 *   proto  pv:// 协议边界（工作区内 200、区外与经链接指向区外 403）
 *   S1     不可信 docx 不执行脚本（altChunk / 超链接）
 *   S4     渲染进程不能自行扩大授权根（workspace:open 只认主进程给过的目录）
 *   C1     加载完成前固定，固定列不能停在加载态
 *   C2     旧文档解析失败不覆盖新文件的预览
 *   C3     高亮 Worker 并发初始化不丢语言
 *   C4     重新读取时晚到的旧响应不能覆盖新内容
 *   F1     预览内查找（命中、切到不支持查找的列时自动关、固定时跟过去）
 *   F2     代码块异步高亮后查找命中不丢
 *   P1     图片列（连续预览列出同目录图片、缩放档位、切到非图片时退出）
 *   P2     晚到的旧图片请求不污染缩放状态
 *   S6     并发切换工作区只留一个授权根
 *
 * 跑法：npm run test:integration                        全跑
 *       npm run test:integration -- --only=C4           只跑一段
 *       npm run test:integration -- --list              列出段落 id
 *
 * 窗口是隐藏的，userData 指向 .tmp/test/user-data，不会碰用户正在用的实例。
 * 复现手法：IPC 用可控的桩替换（延迟、乱序、失败），断言用户最终看到的东西，
 * 而不是内部状态。
 */

const electron = require('electron');
const { app, BrowserWindow, protocol, ipcMain, net, session } = electron;
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('jszip');
const { ROOT, TMP, run, ok, eq, eqJson, done, freshDir, linkDir } = require('./helpers.cjs');

const fsApi = require(path.join(ROOT, 'src/main/fs-api.js'));
const webViews = require(path.join(ROOT, 'src/main/web-views.js'));
app.setPath('userData', path.join(TMP, 'user-data'));

/** 各用例里人为注入的延迟，集中在这里便于调整（也是整个套件耗时的大头） */
const DELAY = { read: 500, parse: 500, fast: 20 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把 main.js 载入沙箱，只为了拿 registerPreviewProtocol / toPreviewUrl。
 * 除 app 之外都用真的 electron 模块：main.js 里多引用一个模块（Menu、shell…）
 * 也不会让这里炸。app 是假的，避免真的开窗、抢单实例锁。
 */
function loadMainModule() {
  const fakeApp = {
    requestSingleInstanceLock: () => false,
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    quit: () => {},
    setPath: () => {},
    getPath: () => TMP,
    getVersion: () => '0.0.0'
  };
  // registerIpc 注册的处理函数收到这里：测试要直接调用真实的那个实现，
  // 而不是在测试里重写一份（那样就测不到接线了）。
  const recorder = { handlers: {}, handle(channel, fn) { this.handlers[channel] = fn; } };
  const ctx = {
    require: (n) => (n === 'electron' ? Object.assign({}, electron, { app: fakeApp, ipcMain: recorder })
      : n === './fs-api' ? fsApi
        : n === './state-sanitize' ? require(path.join(ROOT, 'src/main/state-sanitize.js'))
          : n === './web-url' ? require(path.join(ROOT, 'src/main/web-url.js'))
            : n === './web-views' ? {
              attachWindow: () => {},
              sync: () => {},
              reload: () => false,
              destroyAll: () => {}
            }
              : n === './store' ? { load: async () => ({}), patch: async () => ({}) }
                : require(n)),
    process: process,
    __dirname: path.join(ROOT, 'src/main'),
    URL, Response, console, setTimeout, clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8'), ctx, { filename: 'main.js' });
  ctx.registerIpc();
  ctx.handlers = recorder.handlers;
  /** 测试用假窗口：openWorkspace 会调 setTitle / webContents.send */
  ctx.setWindow = (w) => { ctx.__testWin = w; vm.runInContext('win = __testWin;', ctx); };
  return ctx;
}

// main.js 顶层会调用 protocol.registerSchemesAsPrivileged，必须在 app ready 之前执行
const mainCtx = loadMainModule();

/* ---------------- 按需准备：只跑一段时不为别的段落白付开销 ---------------- */

/** 工作区夹具 + 协议注册，被选中的段落第一次用到时才做 */
let prepPromise = null;
function prepare() {
  if (!prepPromise) {
    prepPromise = (async () => {
      const ws = freshDir('ws');
      const outside = freshDir('outside');
      fs.writeFileSync(path.join(outside, 'marker.txt'), 'OUTSIDE');
      fs.writeFileSync(path.join(ws, 'inside.txt'), 'INSIDE');
      const linked = linkDir(outside, path.join(ws, 'linked'));
      await fsApi.allowRoot(ws);
      mainCtx.registerPreviewProtocol();
      return { ws: ws, outside: outside, linked: linked };
    })();
  }
  return prepPromise;
}

/** 隐藏窗口 + 渲染进程，同样是按需创建 */
let winPromise = null;
let createdWin = null;
function renderer() {
  if (!winPromise) {
    winPromise = (async () => {
      ipcMain.handle('app:get-state', () => ({}));
      ipcMain.handle('app:set-state', () => ({}));
      // 预览变更监测每 5 s 会 stat 一次当前预览；测试里没有真实文件，固定返回同一版本
      ipcMain.handle('fs:stat', () => ({ size: 0, mtime: 0 }));
      ipcMain.handle('window:is-maximized', () => false);
      // 网页视图的接线：渲染进程会同步调用，测试里不真的开子视图
      ipcMain.handle('web:sync', () => ({ ok: true }));
      ipcMain.handle('web:reload', () => ({ ok: true }));
      ipcMain.handle('web:open-external', () => ({ ok: true }));
      createdWin = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(ROOT, 'src/main/preload.js'),
          sandbox: true, contextIsolation: true, nodeIntegration: false
        }
      });
      await createdWin.loadFile(path.join(ROOT, 'src/renderer/index.html'));
      return (js) => createdWin.webContents.executeJavaScript(js);
    })();
  }
  return winPromise;
}

/** 让文件列表里出现给定条目（渲染进程只认主进程推过来的列表） */
function stubList(ws, entries) {
  ipcMain.removeHandler('fs:list');
  ipcMain.handle('fs:list', () => ({ entries: entries.map((e) => ({
    name: e, path: path.join(ws, e), isDir: false, kind: e.slice(e.lastIndexOf('.') + 1)
  })) }));
}

function stubRead(fn) {
  ipcMain.removeHandler('fs:read');
  ipcMain.handle('fs:read', fn);
}

/** 一份带 HTML altChunk、javascript: 与「java<TAB>script:」超链接的 docx */
async function maliciousDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="html" ContentType="text/html"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>BODY_TEXT</w:t></w:r></w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>LINK</w:t></w:r></w:hyperlink><w:hyperlink r:id="rIdLinkTab"><w:r><w:t>TABLINK</w:t></w:r></w:hyperlink><w:altChunk r:id="rIdChunk"/><w:sectPr/></w:body></w:document>');
  // &#9; 是 XML 字符引用：解析后属性值里是真正的制表符，浏览器会忽略它再识别协议
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:window.__auditHref=1" TargetMode="External"/><Relationship Id="rIdLinkTab" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="java&#9;script:window.__auditTab=1" TargetMode="External"/></Relationships>');
  zip.file('word/chunk.html', '<script>parent.__auditDocx=typeof(parent.pv.openRoot)</script>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  await run('proto', 'pv:// 协议 · 工作区边界', async () => {
    const f = await prepare();
    const status = (p) => net.fetch(mainCtx.toPreviewUrl(p)).then((r) => r.status);
    eq('工作区内的文件 200', await status(path.join(f.ws, 'inside.txt')), 200);
    eq('工作区外的文件 403', await status(path.join(f.outside, 'marker.txt')), 403);
    if (f.linked) eq('经链接指向工作区外的文件 403', await status(path.join(f.ws, 'linked', 'marker.txt')), 403);
  });

  await run('S1', '不可信 docx 不执行脚本', async () => {
    await prepare();
    const runPage = await renderer();
    const bytes = await maliciousDocx();
    const s1 = await runPage(`(async()=>{
      const host=document.createElement('div'); document.body.append(host);
      let err=null;
      try { await PV.docpreview.renderDocx(new Uint8Array(${JSON.stringify([...bytes])}), host); }
      catch(e){ err=String(e&&e.message||e); }
      await new Promise(r=>setTimeout(r,${DELAY.parse}));
      const links=[...host.querySelectorAll('a')];
      const link=links[0]||null;
      const tab=links.find(a=>/TABLINK/.test(a.textContent))||null;
      if(link) link.click();
      if(tab) tab.click();
      return {
        err: err,
        executed: typeof window.__auditDocx,
        hrefExecuted: typeof window.__auditHref,
        tabExecuted: typeof window.__auditTab,
        iframes: host.querySelectorAll('iframe').length,
        srcdoc: host.querySelector('iframe') ? host.querySelector('iframe').getAttribute('srcdoc') : null,
        bodyText: /BODY_TEXT/.test(host.textContent),
        linkHref: link ? String(link.getAttribute('href') || '') : '',
        tabHref: tab ? String(tab.getAttribute('href') || '') : null
      };
    })()`);
    eq('渲染不报错', s1.err, null);
    eq('altChunk 的脚本没有执行', s1.executed, 'undefined');
    eq('页面里没有 iframe', s1.iframes, 0);
    eq('没有 srcdoc 承载的文档', s1.srcdoc, null);
    ok('正常正文照常渲染', s1.bodyText);
    ok('超链接没有危险协议', !/^javascript:/i.test(s1.linkHref), s1.linkHref);
    eq('超链接的脚本没有执行', s1.hrefExecuted, 'undefined');
    ok('制表符混淆的协议同样被清掉',
      !s1.tabHref || !/^java\tscript:/i.test(s1.tabHref), s1.tabHref);
    eq('制表符混淆的脚本没有执行', s1.tabExecuted, 'undefined');
  });

  await run('S4', '渲染进程不能自行扩大授权根', async () => {
    await prepare();
    const runPage = await renderer();
    // 把真实的 workspace:open 接到测试进程的 ipcMain 上，让渲染进程真调一次，
    // 这样测的是接线而不是测试里另写的一份实现
    ipcMain.handle('workspace:open', mainCtx.handlers['workspace:open']);

    const denied = await runPage(`pv.openRoot(${JSON.stringify(path.join(ROOT, 'docs'))})
      .then((r) => r, (e) => ({ threw: String((e && e.message) || e) }))`);
    eq('渲染进程打不开主进程没给过的目录', denied && denied.error, 'NOT_OFFERED');

    // 主进程给过的目录要能过这道检查（后面报错是因为测试里没有窗口对象，与检查无关）
    const sample = mainCtx.handlers['workspace:sample']();
    let allowed;
    try {
      allowed = await mainCtx.handlers['workspace:open'](null, sample);
    } catch (err) {
      allowed = { threw: String((err && err.message) || err) };
    }
    ok('主进程给过的目录不会被这道检查挡住',
      !allowed || allowed.error !== 'NOT_OFFERED', allowed);
  });

  await run('C1', '加载完成前固定，固定列不能停在加载态', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['slow.md']);
    stubRead(async () => { await sleep(DELAY.read); return { text: 'LOADED_MARKER', size: 13 }; });
    createdWin.webContents.send('workspace:opened', f.ws);
    await sleep(200);
    const c1 = await runPage(`(async()=>{
      document.querySelector('.row').click();
      await new Promise(r=>setTimeout(r,50));
      document.querySelector('button[data-act="pin"]').click();
      await new Promise(r=>setTimeout(r,${DELAY.read * 2 + 400}));
      return [...document.querySelectorAll('.pane.is-pinned .pv-body')].map(e=>e.textContent);
    })()`);
    ok('固定列显示正文而不是「读取中…」',
      c1.length === 1 && c1[0].indexOf('LOADED_MARKER') >= 0, c1);
  });

  await run('C2', '旧文档解析失败不覆盖新文件的预览', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['bad.docx', 'good.md']);
    stubRead(() => ({ text: 'NEW_PREVIEW', size: 11 }));
    ipcMain.removeHandler('fs:read-bytes');
    ipcMain.handle('fs:read-bytes', () => ({ data: new Uint8Array([1, 2, 3]) }));
    await runPage(`void(PV.docpreview.renderDocx=async()=>{await new Promise(r=>setTimeout(r,${DELAY.parse}));throw new Error('OLD_DOC_FAILURE')})`);
    createdWin.webContents.send('workspace:opened', f.ws);
    await sleep(200);
    const c2 = await runPage(`(async()=>{
      const rows=[...document.querySelectorAll('.row')];
      rows.find(e=>e.textContent.includes('bad.docx')).click();
      await new Promise(r=>setTimeout(r,50));
      rows.find(e=>e.textContent.includes('good.md')).click();
      await new Promise(r=>setTimeout(r,100));
      const before=document.querySelector('.pane:not(.is-pinned) .pv-body').textContent;
      await new Promise(r=>setTimeout(r,${DELAY.parse + 300}));
      return {before, after:document.querySelector('.pane:not(.is-pinned) .pv-body').textContent};
    })()`);
    ok('切换后显示新文件内容', c2.before.indexOf('NEW_PREVIEW') >= 0, c2.before);
    ok('旧文档失败后仍是新文件内容', c2.after.indexOf('NEW_PREVIEW') >= 0, c2.after);
    ok('旧文档的失败卡片没有出现', c2.after.indexOf('OLD_DOC_FAILURE') < 0, c2.after);
  });

  await run('C3', '高亮 Worker 并发初始化不丢语言', async () => {
    const runPage = await renderer();
    const c3 = await runPage(`(async()=>{
      const w=new Worker('vendor/highlight-worker.js',{type:'module'});
      const jobs=new Map();
      w.onmessage=e=>{const f=jobs.get(e.data.jobId); if(f){f(e.data); jobs.delete(e.data.jobId);}};
      let n=0;
      const send=lang=>new Promise(resolve=>{const jobId=++n; jobs.set(jobId,resolve); w.postMessage({jobId,lang,code:'x = 1'})});
      const first=await Promise.all([send('css'),send('python')]);
      const again=await Promise.all([send('css'),send('python')]);
      const more=await Promise.all([send('go'),send('rust'),send('go')]);
      w.terminate();
      const brief=a=>a.map(({ok,error})=>ok?'ok':String(error||'fail'));
      return {first:brief(first), again:brief(again), more:brief(more)};
    })()`);
    eqJson('首次并发请求都成功', c3.first, ['ok', 'ok']);
    eqJson('再次请求同一批语言都成功（曾经第二次 python 会报 not found）', c3.again, ['ok', 'ok']);
    eqJson('继续并发请求其他语言也成功', c3.more, ['ok', 'ok', 'ok']);
  });

  await run('C4', '重新读取时晚到的旧响应不能覆盖新内容', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['good.md']);
    let readNo = 0;
    stubRead(async () => {
      const mine = ++readNo;
      await sleep(mine === 1 ? DELAY.read : DELAY.fast);
      return { text: mine === 1 ? 'OLD_CONTENT' : 'LATEST_CONTENT', size: 13 };
    });
    createdWin.webContents.send('workspace:opened', f.ws);
    await sleep(200);
    const c4 = await runPage(`(async()=>{
      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('good.md')).click();
      await new Promise(r=>setTimeout(r,50));
      document.querySelector('.pane:not(.is-pinned) button[data-act="reload"]').click();
      await new Promise(r=>setTimeout(r,100));
      const before=document.querySelector('.pane:not(.is-pinned) .pv-body').textContent;
      await new Promise(r=>setTimeout(r,${DELAY.read + 300}));
      return {before, after:document.querySelector('.pane:not(.is-pinned) .pv-body').textContent};
    })()`);
    ok('重新读取后显示新内容', c4.before.indexOf('LATEST_CONTENT') >= 0, c4.before);
    ok('旧响应晚到时仍是新内容', c4.after.indexOf('LATEST_CONTENT') >= 0, c4.after);
  });

  await run('F1', '预览内查找：命中、切走自动关、固定时跟过去', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['doc.md', 'code.js']);
    // ipcMain.handle 的监听器第一个参数是 event，路径在第二个
    stubRead((_e, p) => ({
      text: /\.md$/.test(String(p)) ? 'ZEBRA one\n\nZEBRA two\n' : 'const a = 1;\n',
      size: 24
    }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await sleep(200);
    const f1 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      const openFindBar=()=>document.querySelector('.find-bar:not([hidden])');
      const clickRow=(n)=>[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(n)).click();
      const ctrlF=()=>document.dispatchEvent(new KeyboardEvent('keydown',
        {key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
      const search=(q)=>{const i=openFindBar().querySelector('.find-input');
        i.value=q; i.dispatchEvent(new Event('input',{bubbles:true}));};

      clickRow('doc.md');
      await wait(400);
      ctrlF();
      await wait(80);
      const opened=!!openFindBar();
      search('ZEBRA');
      await wait(120);
      const hits=pane().querySelectorAll('mark.find-hit').length;
      const count=openFindBar().querySelector('.find-count').textContent;
      openFindBar().querySelector('[data-find="next"]').click();
      await wait(60);
      const afterNext=openFindBar().querySelector('.find-count').textContent;

      // 切到不支持查找的代码视图：查找条应当自己关掉
      clickRow('code.js');
      await wait(500);
      const closedOnCode=!openFindBar();
      const codeView=!!pane().querySelector('.codeview');

      // 回到 Markdown 再查一次，这次固定住：正文与查找条一起搬到新列
      clickRow('doc.md');
      await wait(400);
      ctrlF();
      await wait(80);
      search('ZEBRA');
      await wait(120);
      pane().querySelector('button[data-act="pin"]').click();
      await wait(400);
      const pin=document.querySelector('.pane.is-pinned');
      const pbar=pin.querySelector('.find-bar');
      const carried=!!pbar && !pbar.hidden && pbar.querySelector('.find-input').value==='ZEBRA';
      const pinHits=pin.querySelectorAll('mark.find-hit').length;
      return {opened, hits, count, afterNext, closedOnCode, codeView, carried, pinHits};
    })()`);
    ok('Ctrl+F 打开查找条', f1.opened, f1);
    eq('命中数正确', f1.hits, 2);
    eq('计数显示 1/2', f1.count, '1/2');
    eq('下一个匹配后计数变 2/2', f1.afterNext, '2/2');
    ok('切到代码视图后查找条自动关闭', f1.closedOnCode && f1.codeView, f1);
    ok('固定时查询词跟到新列', f1.carried, f1);
    eq('固定列里的命中重新落上', f1.pinHits, 2);
  });

  await run('F2', '代码块异步高亮不吞掉查找命中', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['fence.md']);
    // 用一个本套件还没加载过的语言 + 较长的代码块，让分词晚于查找落点
    const filler = Array.from({ length: 5000 }, (_, i) => 'local v' + i + ' = f(' + i + ') + ' + i).join('\n');
    const doc = 'ZEBRA outside\n\n```lua\n-- ZEBRA inside\n' + filler + '\n```\n';
    stubRead(() => ({ text: doc, size: doc.length }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await sleep(200);
    const f2 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      const bar=()=>document.querySelector('.find-bar:not([hidden])');
      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('fence.md')).click();
      await wait(50);
      document.dispatchEvent(new KeyboardEvent('keydown',
        {key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
      await wait(40);
      const input=bar().querySelector('.find-input');
      input.value='ZEBRA'; input.dispatchEvent(new Event('input',{bubbles:true}));
      await wait(40);
      const before=pane().querySelectorAll('mark.find-hit').length;
      const fenceSpansBefore=!!pane().querySelector('.md-code span');
      await wait(1800);
      return {
        before: before,
        fenceSpansBefore: fenceSpansBefore,
        after: pane().querySelectorAll('mark.find-hit').length,
        inFence: pane().querySelectorAll('.md-code mark.find-hit').length,
        count: bar().querySelector('.find-count').textContent,
        highlighted: !!pane().querySelector('.md-code span')
      };
    })()`);
    ok('查找先于高亮落点', f2.before >= 1 && !f2.fenceSpansBefore, f2);
    ok('代码块最终被高亮', f2.highlighted, f2);
    eq('高亮替换后命中没有丢', f2.after, f2.before);
    ok('代码块里的命中还在', f2.inFence >= 1, f2);
    eq('计数与命中一致', f2.count, '1/' + f2.after);
  });

  await run('P1', '图片列：连续预览、缩放、切走自动退出', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['a.svg', 'b.svg', 'c.svg', 'note.md']);
    stubRead(() => ({ text: 'NOTE_BODY\n', size: 10 }));
    const svg = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#369"/></svg>');
    ipcMain.removeHandler('fs:preview-url');
    ipcMain.handle('fs:preview-url', () => ({ url: svg }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await sleep(200);
    const p1 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      const clickRow=(n)=>[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(n)).click();

      clickRow('a.svg');
      await wait(400);
      const single=!!pane().querySelector('.img-wrap');

      pane().querySelector('button[data-act="seq"]').click();
      await wait(700);
      const items=pane().querySelectorAll('.imgseq-item').length;
      const current=pane().querySelectorAll('.imgseq-item.is-current').length;

      pane().querySelector('button[data-act="zoom-in"]').click();
      await wait(150);
      const zoom=pane().querySelector('[data-act="zoom-reset"]').textContent;

      // 切到非图片：连续预览自动退出
      clickRow('note.md');
      await wait(400);
      return {
        single, items, current, zoom,
        seqExited: pane().querySelector('.imgseq') === null,
        switchedToText: !!pane().querySelector('.prose')
      };
    })()`);
    ok('单张图片渲染成 .img-wrap', p1.single, p1);
    eq('连续预览列出同目录三张图', p1.items, 3);
    eq('连续预览只标出当前那一张', p1.current, 1);
    eq('放大一档显示 100%', p1.zoom, '100%');
    ok('切到非图片时退出连续预览', p1.seqExited && p1.switchedToText, p1);
  });

  await run('P2', '晚到的旧图片请求不污染缩放状态', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['x.svg', 'y.svg']);
    const svg = (w, h, fill) => 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">'
      + '<rect width="' + w + '" height="' + h + '" fill="' + fill + '"/></svg>');
    const urlX = svg(40, 30, '#369');
    const urlY = svg(80, 60, '#c33');
    ipcMain.removeHandler('fs:preview-url');
    ipcMain.handle('fs:preview-url', async (_e, p) => {
      const name = path.basename(String(p));
      if (name === 'x.svg') await sleep(600);
      return { url: name === 'x.svg' ? urlX : urlY };
    });
    createdWin.webContents.send('workspace:opened', f.ws);
    await sleep(200);
    const p2 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      const clickRow=(n)=>[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(n)).click();
      clickRow('x.svg');
      await wait(50);
      clickRow('y.svg');
      await wait(1200);
      pane().querySelector('[data-act="zoom-reset"]').click();
      await wait(80);
      pane().querySelector('button[data-act="zoom-in"]').click();
      await wait(200);
      const img=pane().querySelector('.img-wrap img');
      return {
        alt: img ? img.alt : null,
        width: img ? img.style.width : null,
        imgs: pane().querySelectorAll('.img-wrap img').length
      };
    })()`);
    eq('正文显示的是后选中的图片', p2.alt, 'y.svg');
    eq('只保留一张图片元素', p2.imgs, 1);
    eq('缩放作用在可见图片上（80px 宽）', p2.width, '80px');
  });

  await run('W1', '网页视图只接受 http(s)，移出同步列表即销毁', async () => {
    const w = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    webViews.attachWindow(w);
    const rect = { x: 0, y: 0, width: 400, height: 300 };

    eq('网页会话没有宿主 pv:// 处理器',
      session.fromPartition(webViews.PARTITION).protocol.isProtocolHandled('pv'), false);

    webViews.sync([{ url: 'http://127.0.0.1:9/doc', visible: true, rect: rect }]);
    eq('http 地址会创建视图', webViews.count(), 1);

    webViews.sync([{ url: 'http://127.0.0.1:9/two', visible: false, rect: null }]);
    eq('不可见的条目保留视图（预览收起不重载）', webViews.count(), 1);
    webViews.sync([{ url: 'http://127.0.0.1:9/two', visible: true, rect: { x: 0, y: 0, width: 0, height: 0 } }]);
    eq('可见但矩形无效时保留视图（只是不显示）', webViews.count(), 1);

    const bad = ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,x',
      'https://user:pass@a.example/', 'ms-msdt:/id'];
    webViews.sync(bad.map((url) => ({ url: url, visible: true, rect: rect })));
    eq('非法地址不会留下视图', webViews.count(), 0);

    webViews.sync([{ url: 'http://127.0.0.1:9/two', visible: true, rect: rect }]);
    eq('重新出现会重建视图', webViews.count(), 1);
    webViews.sync([]);
    eq('移出同步列表后销毁', webViews.count(), 0);

    w.destroy();
  });

  await run('S6', '并发切换工作区只留一个授权根', async () => {
    await prepare();
    const a = freshDir('switch-a');
    const b = freshDir('switch-b');
    fsApi.offerRoot(a);
    fsApi.offerRoot(b);
    mainCtx.setWindow({ setTitle() {}, webContents: { send() {} } });
    const open = mainCtx.handlers['workspace:open'];
    const [ra, rb] = await Promise.all([open(null, a), open(null, b)]);
    const roots = fsApi.allowedRootList();
    eq('只保留一个授权根', roots.length, 1);
    eq('先发起的那次被后一次取代', ra && ra.error, 'SUPERSEDED');
    ok('留下的是后发起的目录',
      roots.length === 1 && roots[0].toLowerCase() === path.resolve(b).toLowerCase(),
      { roots: roots, rb: rb });
  });

  if (createdWin) createdWin.destroy();
  done();
}

app.whenReady()
  .then(main)
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .then(() => app.exit(process.exitCode || 0));
