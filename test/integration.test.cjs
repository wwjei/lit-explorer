'use strict';

/**
 * 需要 Electron 的用例。窗口只开一次；段内等待一律等界面真的进入预期状态，
 * 不再用固定 sleep 凑时间。迭代时用 --only 挑相关的那一段跑，别整跑。
 *
 *   proto  pv:// 协议边界（工作区内 200、区外与经链接指向区外 403）
 *   U1     预览地址带文件版本（保存后 URL 变化，查询串不影响协议取文件）
 *   S1     不可信 docx 不执行脚本（altChunk / 超链接）
 *   S4     渲染进程不能自行扩大授权根（workspace:open 只认主进程给过的目录）
 *   C1     加载完成前固定，固定列不能停在加载态
 *   C2     旧文档解析失败不覆盖新文件的预览
 *   C3     高亮 Worker 并发初始化不丢语言
 *   C4     重新读取时晚到的旧响应不能覆盖新内容
 *   M1     Markdown 图片：相对地址走 pv://，越界与缺失落成占位
 *   F1     预览内查找（命中、切到不支持查找的列时自动关、固定时跟过去）
 *   F2     代码块异步高亮后查找命中不丢
 *   P1     图片列（连续预览列出同目录图片、缩放档位、切到非图片时退出）
 *   P2     晚到的旧图片请求不污染缩放状态
 *   P3     拖动抓手换位置；临时列拖到右侧自动固定
 *   P4     拖到列的下 1/3 分屏；取消分屏里的一格恢复单格；临时列也能直接分屏
 *   P5     切到别的项目再回来：固定列、列宽、分屏比例与模式都按项目恢复
 *   P6     关掉的临时预览列不会因为切项目被重新打开
 *   E1     SVG 编辑：改字、拖动、矩形缩放、删除（连框内文字）、撤销与自动保存
 *   E2     SVG 保存边界：只写工作区内已存在的 .svg，版本冲突不覆盖
 *   E3     含脚本 / 事件属性 / javascript: 链接的 SVG 只读显示，不执行也不保存
 *   E4     真实鼠标双击文字能打开输入框（指针捕获不能吞掉 dblclick）
 *   W2     网页读剪贴板按站点询问一次，允许后本次运行不再问
 *   W1     网页视图只接受 http(s)，移出同步列表即销毁
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
const { app, BrowserWindow, protocol, ipcMain, net, session, dialog, clipboard } = electron;
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const JSZip = require('jszip');
const { ROOT, TMP, run, ok, eq, eqJson, done, freshDir, linkDir } = require('./helpers.cjs');

const fsApi = require(path.join(ROOT, 'src/main/fs-api.js'));
const webViews = require(path.join(ROOT, 'src/main/web-views.js'));
app.setPath('userData', path.join(TMP, 'user-data'));

/** 各用例里人为注入的延迟，集中在这里便于调整；它们是竞态用例的机制，不要为提速随意缩短 */
const DELAY = { read: 500, parse: 500, fast: 20 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 主进程侧的条件等待：界面到位就返回，超时才失败。替代固定 sleep——
 * 机器慢时自动多等，机器快时立刻继续。
 */
async function waitPage(runPage, expr, timeout) {
  const end = Date.now() + (timeout || 8000);
  for (;;) {
    const value = await runPage(expr);
    if (value) return value;
    if (Date.now() > end) throw new Error('waitPage timeout: ' + expr);
    await sleep(10);
  }
}

/** 等这次 stubList 给的条目真的渲染出来，而不是上一段留下的行 */
async function waitStubbedRows(runPage) {
  const want = JSON.stringify(stubbedEntries.slice().sort());
  await waitPage(runPage, `JSON.stringify([...document.querySelectorAll('.col[data-col="0"] .row .nm')]
    .map(e=>e.textContent.trim()).sort()) === ${JSON.stringify(want)}`);
}

/**
 * 这些段落共用 prepare() 建出来的工作区：固定列会作为项目布局存下来，
 * 下一段重开同一根时会恢复上一段的 pin。段末清掉，避免夹具互相污染。
 */
async function clearPinnedColumns(runPage) {
  await runPage('(()=>{PV.pane.clearPins(); PV.pane.renderPreview(); return true;})()');
}

/** 页内条件等待：所有 executeJavaScript 片段共用这一个全局函数 */
const PAGE_WAIT_FOR = `window.waitFor = async (fn, timeout) => {
  const end = Date.now() + (timeout || 8000);
  for (;;) {
    let value;
    try { value = fn(); } catch (err) { value = null; }
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
void 0;`;

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
          : n === './directory-plugins' ? require(path.join(ROOT, 'src/main/directory-plugins.js'))
          : n === './reference-dirs' ? require(path.join(ROOT, 'src/main/reference-dirs.js'))
          : n === './web-url' ? require(path.join(ROOT, 'src/main/web-url.js'))
            : n === '../shared/contracts' ? require(path.join(ROOT, 'src/shared/contracts.js'))
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
      ipcMain.handle('directories:call', (_e, method) => ({value: method === 'mounts' || method === 'providers' ? [] : true}));
      ipcMain.handle('references:list', () => []);
      ipcMain.handle('fs:stat', () => ({ size: 0, mtime: 0 }));
      ipcMain.handle('window:is-maximized', () => false);
      // SVG 编辑保存默认返回成功；E1 会换成能记录内容的桩
      ipcMain.handle('fs:write-svg', () => ({ ok: true, size: 0, mtime: 0 }));
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
      await createdWin.webContents.executeJavaScript(PAGE_WAIT_FOR);
      return (js) => createdWin.webContents.executeJavaScript(js);
    })();
  }
  return winPromise;
}

/** 让文件列表里出现给定条目（渲染进程只认主进程推过来的列表） */
let stubbedEntries = [];
function stubList(ws, entries) {
  stubbedEntries = entries.slice();
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
      await PV.body.loadDocPreview();
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

  await run('U1', '预览地址带文件版本，保存后 URL 会变化', async () => {
    const f = await prepare();
    const file = path.join(f.ws, 'versioned.svg');
    fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const first = await mainCtx.handlers['fs:preview-url'](null, file);
    ok('地址带文件版本', !!(first && first.url) && /[?&]v=\d+-\d+$/.test(first.url), first);
    eq('带版本号的地址仍能读到文件', (await net.fetch(first.url)).status, 200);

    fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>');
    const second = await mainCtx.handlers['fs:preview-url'](null, file);
    ok('文件变化后 URL 也跟着变', second && second.url !== first.url, { first, second });
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
    await waitStubbedRows(runPage);
    const c1 = await runPage(`(async()=>{
      document.querySelector('.row').click();
      await new Promise(r=>setTimeout(r,50));
      document.querySelector('button[data-act="pin"]').click();
      await waitFor(()=>[...document.querySelectorAll('.pane.is-pinned .pv-body')]
        .some(e=>e.textContent.indexOf('LOADED_MARKER')>=0), 5000);
      return [...document.querySelectorAll('.pane.is-pinned .pv-body')].map(e=>e.textContent);
    })()`);
    ok('固定列显示正文而不是「读取中…」',
      c1.length === 1 && c1[0].indexOf('LOADED_MARKER') >= 0, c1);
    await clearPinnedColumns(runPage);
  });

  await run('C2', '旧文档解析失败不覆盖新文件的预览', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['bad.docx', 'good.md']);
    stubRead(() => ({ text: 'NEW_PREVIEW', size: 11 }));
    ipcMain.removeHandler('fs:read-bytes');
    ipcMain.handle('fs:read-bytes', () => ({ data: new Uint8Array([1, 2, 3]) }));
    // docx 解析器现在按需加载；先把它取进来，下面的桩才装在真正的模块上
    await runPage('(async()=>{ await PV.body.loadDocPreview(); })()');
    await runPage(`void(PV.docpreview.renderDocx=async()=>{await new Promise(r=>setTimeout(r,${DELAY.parse}));window.__oldDocFailed=1; throw new Error('OLD_DOC_FAILURE')})`);
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
    const c2 = await runPage(`(async()=>{
      const rows=[...document.querySelectorAll('.row')];
      rows.find(e=>e.textContent.includes('bad.docx')).click();
      await new Promise(r=>setTimeout(r,50));
      rows.find(e=>e.textContent.includes('good.md')).click();
      await new Promise(r=>setTimeout(r,100));
      const before=document.querySelector('.pane:not(.is-pinned) .pv-body').textContent;
      await waitFor(()=>window.__oldDocFailed, 5000);
      await new Promise(r=>setTimeout(r,50));
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
    await waitStubbedRows(runPage);
    const c4 = await runPage(`(async()=>{
      const t0=Date.now();
      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('good.md')).click();
      await new Promise(r=>setTimeout(r,50));
      PV.pane.renderPane(PV.find.targetPane(), true);
      await new Promise(r=>setTimeout(r,100));
      const before=document.querySelector('.pane:not(.is-pinned) .pv-body').textContent;
      // 第一次读取的晚到响应在点击后 DELAY.read 落地；再留 100ms 给 IPC 派发
      await new Promise(r=>setTimeout(r,Math.max(0, ${DELAY.read + 100} - (Date.now() - t0))));
      return {before, after:document.querySelector('.pane:not(.is-pinned) .pv-body').textContent};
    })()`);
    ok('重新读取后显示新内容', c4.before.indexOf('LATEST_CONTENT') >= 0, c4.before);
    ok('旧响应晚到时仍是新内容', c4.after.indexOf('LATEST_CONTENT') >= 0, c4.after);
  });

  await run('M1', 'Markdown 图片：相对地址渲染，越界与缺失落成占位', async () => {
    const f = await prepare();
    // 前面的段可能切过工作区（S4 会打开示例项目），这里把夹具重新登记回来
    await fsApi.allowRoot(f.ws);
    const runPage = await renderer();
    const figures = path.join(f.ws, 'figures');
    fs.mkdirSync(figures, { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    fs.writeFileSync(path.join(figures, 'ok.png'), png);
    fs.writeFileSync(path.join(f.outside, 'secret.png'), png);

    stubList(f.ws, ['doc.md']);
    stubRead(() => ({
      text: [
        '![本地](figures/ok.png)',
        '![越界](../outside/secret.png)',
        '![缺失](figures/nope.png)'
      ].join('\n\n'),
      size: 64
    }));
    // 真实的解析实现，测的是接线（授权判断仍在主进程里）
    ipcMain.removeHandler('fs:resolve-images');
    ipcMain.handle('fs:resolve-images', mainCtx.handlers['fs:resolve-images']);
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);

    const m1 = await runPage(`(async()=>{
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('doc.md')).click();
      await waitFor(()=>pane().querySelector('.prose'));
      await waitFor(()=>{
        const imgs=[...pane().querySelectorAll('.prose img')];
        const missing=pane().querySelectorAll('.md-img-missing').length;
        return (imgs.length && imgs.every(i=>i.complete)) || missing===3;
      });
      const imgs=[...pane().querySelectorAll('.prose img')];
      return {
        imgs: imgs.map(i=>[i.getAttribute('src'), i.naturalWidth]),
        missing: [...pane().querySelectorAll('.md-img-missing')].map(e=>e.textContent)
      };
    })()`);
    eq('三张里只有本地那张生成 <img>', m1.imgs.length, 1);
    ok('本地图片走 pv:// 并真的解码出来',
      /^pv:\/\/local\/.+figures\/ok\.png\?v=\d+-\d+$/.test(m1.imgs[0] ? m1.imgs[0][0] : '')
      && m1.imgs[0][1] > 0, m1.imgs);
    eq('越界与缺失各落成一个占位', m1.missing.length, 2);
    ok('占位写明原因（不在工作区内 / 文件不存在）',
      /不在工作区内/.test(m1.missing.join('|')) && /文件不存在/.test(m1.missing.join('|')),
      m1.missing);
  });

  await run('M2', 'Markdown 元数据与本地链接导航', async () => {
    const f = await prepare();
    const runPage = await renderer();
    createdWin.setContentSize(1280, 900);
    stubList(f.ws, ['link.md', 'target.md']);
    stubRead((_e, p) => ({ text: String(p).endsWith('link.md')
      ? '---\nname: sample\nversion: 2.7.5\n---\n[打开](./target.md)' : '# TARGET_LOCAL', size: 80 }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
    const result = await runPage(`(async()=>{
      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('link.md')).click();
      await waitFor(()=>document.querySelector('.md-frontmatter'));
      const metadata=document.querySelector('.md-frontmatter').textContent;
      document.querySelector('.prose a').click();
      await waitFor(()=>document.querySelector('.prose')?.textContent.includes('TARGET_LOCAL'));
      await new Promise(requestAnimationFrame);
      const head=document.querySelector('.pane:not(.is-pinned) .pv-head');
      const list=document.querySelector('.cols').getBoundingClientRect();
      const col=document.querySelector('.col').getBoundingClientRect();
      return {metadata, height:head.getBoundingClientRect().height, visible:col.right>list.left && col.left<list.right};
    })()`);
    ok('YAML 元数据完整展示', result.metadata.includes('name: sample') && result.metadata.includes('version: 2.7.5'), result);
    ok('列头保持单行高度，来源列表可见', result.height <= 50 && result.visible, result);
    ok('本地相对链接在应用中打开目标预览', true);
  });

  await run('R2', '外部参考目录快捷访问、预览与移除', async () => {
    const f = await prepare();
    const runPage = await renderer();
    const external = freshDir('external-reference');
    fs.mkdirSync(path.join(external, 'docs'));
    fs.writeFileSync(path.join(external, 'docs', 'ref.md'), '# EXTERNAL_REFERENCE\n[Sibling](../target.md)');
    fs.writeFileSync(path.join(external, 'target.md'), '# SIBLING_REFERENCE');
    let saved = {};
    const service = require('../src/main/reference-dirs').createReferenceDirs({ fsApi,
      store: { load: async () => saved, patch: async (p) => { saved = { ...saved, ...p }; } },
      pick: async () => external
    });
    fsApi.resetAllowedRoots();
    await fsApi.allowRoot(f.ws);
    service.activate(f.ws, []);
    for (const [channel, handler] of Object.entries({
      'references:list': () => service.list(),
      'references:add': () => service.add(),
      'references:remove': (_e, p) => service.remove(p),
      'fs:list': (_e, p) => fsApi.listDir(p),
      'fs:read': (_e, p) => fsApi.readFileForPreview(p)
    })) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
    createdWin.webContents.send('workspace:opened', f.ws);
    const result = await runPage(`(async()=>{
      const row=(name)=>[...document.querySelectorAll('.row:not(.fav-row)')].find(e=>e.textContent.includes(name));
      await waitFor(()=>row('inside.txt'));
      document.querySelector('[data-reference-add]').click();
      await waitFor(()=>[...document.querySelectorAll('.fav-row')].some(e=>e.dataset.favKey===${JSON.stringify(external)}));
      [...document.querySelectorAll('.fav-row')].find(e=>e.dataset.favKey===${JSON.stringify(external)}).click();
      await waitFor(()=>row('docs'));
      row('docs').click();
      await waitFor(()=>row('ref.md'));
      row('ref.md').click();
      await waitFor(()=>document.querySelector('.prose')?.textContent.includes('EXTERNAL_REFERENCE'));
      const project=document.querySelector('#root-name').textContent;
      document.querySelector('.prose a').click();
      await waitFor(()=>document.querySelector('.prose')?.textContent.includes('SIBLING_REFERENCE'));
      document.querySelector('[data-project-root]').click();
      await waitFor(()=>row('inside.txt'));
      return {project, returned:!!row('inside.txt')};
    })()`);
    eq('浏览参考目录时保留项目身份', result.project, path.basename(f.ws));
    ok('可返回项目目录继续浏览', result.returned);
    await runPage(`(async()=>{
      [...document.querySelectorAll('.fav-row')].find(e=>e.dataset.favKey===${JSON.stringify(external)}).click();
      await waitFor(()=>[...document.querySelectorAll('.row:not(.fav-row)')].some(e=>e.textContent.includes('target.md')));
      [...document.querySelectorAll('.row:not(.fav-row)')].find(e=>e.textContent.includes('target.md')).click();
      await waitFor(()=>document.querySelector('.prose')?.textContent.includes('SIBLING_REFERENCE'));
    })()`);
    createdWin.webContents.send('workspace:opened', f.ws);
    await runPage(`waitFor(()=>document.querySelector('.prose')?.textContent.includes('SIBLING_REFERENCE') && document.querySelector('[data-project-root]'))`);
    ok('重新打开项目恢复外部目录及选中文件', true);
    createdWin.webContents.send('app:toggle-favorite', {path: external, isDir: true});
    await runPage(`waitFor(()=>![...document.querySelectorAll('.fav-row')].some(e=>e.dataset.favKey===${JSON.stringify(external)}))`);
    eq('移除外部目录后撤销授权', service.list().length, 0);
    ipcMain.removeHandler('references:list'); ipcMain.handle('references:list', () => []);
  });

  await run('D1', '云目录插件：文件夹与 Wiki 快捷项', async () => {
    const f=await prepare(); const runPage=await renderer();
    const {createDirectoryPlugins,invokeDirectoryPlugin}=require('../src/main/directory-plugins');
    const fixture=require('./fixtures/feishu-directory.json');
    let saved={};
    const service=createDirectoryPlugins({store:{load:async()=>saved,patch:async(p)=>{saved={...saved,...p};}},fetch:async(raw,options)=>{
      const url=new URL(raw);let data;
      if(url.pathname.endsWith('get_node')) data=fixture.wikiRoot;
      else if(url.pathname.includes('/wiki/')) data=fixture.wikiPage;
      else if(url.pathname.endsWith('batch_query')) {
        const doc=JSON.parse(options.body).request_docs[0];
        data=doc.doc_token==='docA'?fixture.details:{code:0,data:{metas:[{doc_token:doc.doc_token,doc_type:doc.doc_type,title:'Wiki 实体 '+doc.doc_token,url:'https://tenant.feishu.cn/docx/'+doc.doc_token}]}};
      } else if(url.searchParams.get('folder_token')==='folderA') data=fixture.nestedPage;
      else data=url.searchParams.get('page_token')?fixture.lastPage:fixture.firstPage;
      return new Response(JSON.stringify(data));
    }});
    service.activate(f.ws);
    ipcMain.removeHandler('directories:call');
    ipcMain.handle('directories:call',(_e,method,args)=>invokeDirectoryPlugin(service,method,args));
    stubList(f.ws,['cloud-placeholder.md']);stubRead(()=>({text:'# LOCAL',size:7}));
    createdWin.webContents.send('workspace:opened',f.ws);
    const result=await runPage(`(async()=>{
      const type=(name,value)=>{document.querySelector('.cloud-connect [name="'+name+'"]').value=value;};
      const connect=async(provider,root,name)=>{
        document.querySelector('[data-cloud-add]').click();
        await waitFor(()=>document.querySelector('.cloud-connect'));
        type('providerId',provider);type('rootId',root);type('name',name);type('authMode','token'); document.querySelector('[name=authMode]').dispatchEvent(new Event('change')); type('token','fixture-secret');
        document.querySelector('.cloud-connect').requestSubmit();
        return document.querySelector('.cloud-connect [name=token]')?.value==='';
      };
      await waitFor(()=>document.querySelector('.row:not(.fav-row)')?.textContent.includes('cloud-placeholder.md'));
      [...document.querySelectorAll('.row:not(.fav-row)')].find(e=>e.textContent.includes('cloud-placeholder.md')).click();
      await waitFor(()=>document.querySelector('.prose')?.textContent.includes('LOCAL'));
      PV.pane.pinCurrent();
      const cleared=await connect('feishu-drive','https://tenant.feishu.cn/drive/folder/root','云目录');
      await waitFor(()=>document.querySelectorAll('.cloud-entry').length===2);
      document.querySelector('[data-cloud-entry="0"]').click();
      await waitFor(()=>document.querySelector('.cloud-entries')?.textContent.includes('接口'));
      const nested=true;
      document.querySelector('[data-cloud-up]').click();
      await waitFor(()=>document.querySelectorAll('.cloud-entry').length===2);
      document.querySelector('[data-cloud-next]').click();
      await waitFor(()=>document.querySelectorAll('.cloud-entry').length===3);
      document.querySelector('[data-cloud-detail="1"]').click();
      await waitFor(()=>document.querySelector('.cloud-details')?.textContent.includes('最新'));
      const details=true;
      document.querySelector('[data-cloud-entry="1"]').click();
      await waitFor(()=>!document.querySelector('.cloud-dialog[open]') && document.querySelector('.pv-nm')?.textContent.includes('最新'));
      const preview=true;
      PV.pane.pinCurrent();
      const noSignedUrls=!JSON.stringify(PV.pane.layoutSnapshot()).includes('feishu.cn');
      await connect('feishu-wiki','https://tenant.feishu.cn/wiki/wikiRoot','Wiki目录');
      await waitFor(()=>document.querySelector('.cloud-entry')?.textContent.includes('子文档'));
      const wiki=true;
      const rootOpens=!document.querySelector('[data-cloud-current-document]').hidden;
      document.querySelector('[data-cloud-current-document]').click();
      await waitFor(()=>!document.querySelector('.cloud-dialog[open]') && document.querySelector('.pv-nm')?.textContent.includes('wikiDocRoot'));
      [...document.querySelectorAll('.cloud-fav')].find(e=>e.textContent.includes('Wiki目录')).click();
      await waitFor(()=>document.querySelector('[data-cloud-entry="0"]'));
      document.querySelector('[data-cloud-entry="0"]').click();
      await waitFor(()=>!document.querySelector('.cloud-dialog[open]') && document.querySelector('.pv-nm')?.textContent.includes('wikiDocChild'));
      [...document.querySelectorAll('.cloud-fav')].find(e=>e.textContent.includes('云目录')).querySelector('[data-cloud-remove]').click();
      await waitFor(()=>document.querySelectorAll('.cloud-fav').length===1);
      return {cleared,nested,details,preview,wiki,rootOpens,noSignedUrls,localPinPreserved:PV.pane.allPanes().some(p=>p.pinned&&p.node?.name==='cloud-placeholder.md')};
    })()`);
    ok('提交连接后立即清空页面令牌',result.cleared,result);
    ok('文件夹分页、详情和在线预览可用',result.nested&&result.details&&result.preview,result);
    ok('Wiki 目录可浏览，并可打开节点自身与子文档',result.wiki&&result.rootOpens,result);
    ok('解析出的文档链接不写入布局',result.noSignedUrls,result);
    ok('移除云来源保留其他本地固定预览',result.localPinPreserved,result);
    ok('挂载配置不保存令牌',!JSON.stringify(saved).includes('fixture-secret'));
    eq('移除一个来源保留其他来源',(await service.mounts()).length,1);
    for(const mount of await service.mounts()) await service.remove(mount.id);
    ipcMain.removeHandler('directories:call');ipcMain.handle('directories:call',(_e,method)=>({value:method==='mounts'||method==='providers'?[]:true}));
    await runPage('PV.cloud.setProject('+JSON.stringify(f.ws)+')');
    await clearPinnedColumns(runPage);
  });

  await run('D2', '飞书浏览器授权连接文件夹与关闭取消', async () => {
    const f=await prepare(), runPage=await renderer();
    const {createDirectoryPlugins,invokeDirectoryPlugin}=require('../src/main/directory-plugins');
    const fixture=require('./fixtures/feishu-auth.json'), directory=require('./fixtures/feishu-directory.json');
    let saved={}, clock=100000, opened=[], replies=[], cancelled=false, fast=true;
    const service=createDirectoryPlugins({authNow:()=>clock,store:{load:async()=>saved,patch:async(p)=>{saved={...saved,...p};}},fetch:async(raw,options)=>{
      const url=new URL(raw);
      if(url.host==='accounts.feishu.cn') return new Response(JSON.stringify(replies.shift()));
      eq('目录请求由宿主填入授权令牌',options.headers.Authorization,'Bearer access-fixture');
      return new Response(JSON.stringify(url.pathname.endsWith('batch_query') ? directory.details : directory.firstPage));
    }});
    service.activate(f.ws);
    ipcMain.removeHandler('directories:call');
    ipcMain.handle('directories:call',async(_e,method,args)=>{
      if(method==='authPoll') clock+=1000;
      if(method==='cancel') cancelled=true;
      const result=await invokeDirectoryPlugin(service,method,args);
      if(fast && result.value?.interval) result.value.interval=0.001;
      return result;
    });
    ipcMain.removeHandler('web:open-external');
    ipcMain.handle('web:open-external',(_e,url)=>{opened.push(url);return true;});
    stubList(f.ws,['auth-placeholder.md']);stubRead(()=>({text:'# AUTH',size:6}));
    createdWin.webContents.send('workspace:opened',f.ws);
    replies=[fixture.registration,fixture.registered,fixture.device,fixture.token];
    const result=await runPage(`(async()=>{
      await waitFor(()=>document.querySelector('.row:not(.fav-row)')?.textContent.includes('auth-placeholder.md'));
      document.querySelector('[data-cloud-add]').click();
      const form=document.querySelector('.cloud-connect');
      form.elements.providerId.value='feishu-drive'; form.elements.rootId.value='https://tenant.feishu.cn/drive/folder/root';
      form.elements.name.value='浏览器授权目录'; form.requestSubmit();
      await waitFor(()=>document.querySelectorAll('.cloud-entry').length===2);
      document.querySelector('[data-cloud-entry="1"]').click();
      await waitFor(()=>!document.querySelector('dialog.cloud-dialog').open);
      return {noSecret:!document.body.textContent.includes('access-fixture'), preview:PV.pane.allPanes().some(p=>p.node?.url?.includes('/docx/docA'))};
    })()`);
    eq('注册与授权分别打开官方浏览器页面',opened.length,2);
    ok('两次确认后打开具体文档',result.preview,result);
    ok('访问令牌未进入界面',result.noSecret,result);
    ok('授权凭据不写入设置',!/access-fixture|refresh-fixture|local-app-secret/.test(JSON.stringify(saved)));
    fast=false; replies=[fixture.device];
    await runPage(`(async()=>{
      document.querySelector('[data-cloud-add]').click();const form=document.querySelector('.cloud-connect');
      form.elements.rootId.value='root';form.elements.authMode.value='application';form.elements.authMode.dispatchEvent(new Event('change'));
      form.elements.appId.value='cli_fixture';form.elements.appSecret.value='own-secret';form.requestSubmit();
      await waitFor(()=>document.querySelector('.cloud-message')?.textContent.includes('确认云文档'));
      if(form.elements.appSecret.value!=='') throw Error('secret not cleared');
      document.querySelector('[data-cloud-close]').click();
    })()`);
    await waitPage(runPage,`!document.querySelector('dialog.cloud-dialog').open`);
    await runPage("pv.directoryCall('providers')");
    ok('关闭表单取消待授权流程',cancelled);
    ipcMain.removeHandler('web:open-external');ipcMain.handle('web:open-external',()=>({ok:true}));
    ipcMain.removeHandler('directories:call');ipcMain.handle('directories:call',(_e,method)=>({value:method==='mounts'||method==='providers'?[]:true}));
    await runPage('PV.cloud.setProject('+JSON.stringify(f.ws)+')');await clearPinnedColumns(runPage);
  });

  await run('D3', '金山云目录界面、子目录快捷项与网页预览', async () => {
    const f=await prepare(),runPage=await renderer();
    const {createDirectoryPlugins,invokeDirectoryPlugin}=require('../src/main/directory-plugins');
    const fixture=require('./fixtures/kdocs-directory.json');let saved={};
    const service=createDirectoryPlugins({store:{load:async()=>saved,patch:async(p)=>{saved={...saved,...p};}},fetch:async(raw)=>{
      const url=new URL(raw);
      const data=url.pathname.endsWith('/links')?fixture.link:url.searchParams.get('parent_id')?fixture.nestedPage:url.searchParams.has('offset')?fixture.lastPage:fixture.firstPage;
      return new Response(JSON.stringify(data));
    }});
    service.activate(f.ws);ipcMain.removeHandler('directories:call');
    ipcMain.handle('directories:call',(_e,method,args)=>invokeDirectoryPlugin(service,method,args));
    stubList(f.ws,['kdocs-placeholder.md']);stubRead(()=>({text:'# Kdocs',size:7}));
    createdWin.webContents.send('workspace:opened',f.ws);
    const result=await runPage(`(async()=>{
      await waitFor(()=>document.querySelector('.row:not(.fav-row)')?.textContent.includes('kdocs-placeholder.md'));
      document.querySelector('[data-cloud-add]').click();const form=document.querySelector('.cloud-connect');
      const options=[...form.elements.providerId.options].map(o=>o.value);
      form.elements.providerId.value='kdocs-personal';form.elements.providerId.dispatchEvent(new Event('change'));
      const authIsToken=form.elements.authMode.value==='token'&&[...form.elements.authMode.options].filter(o=>o.value!=='token').every(o=>o.disabled);
      form.elements.rootId.value='';form.elements.name.value='我的金山文档';form.elements.token.value='fixture-secret';form.requestSubmit();
      await waitFor(()=>document.querySelector('.cloud-entry')?.textContent.includes('参考资料'));
      document.querySelector('[data-cloud-next]').click();await waitFor(()=>document.querySelectorAll('.cloud-entry').length===2);
      document.querySelector('[data-cloud-entry="0"]').click();await waitFor(()=>document.querySelector('.cloud-entry')?.textContent.includes('接口说明'));
      document.querySelector('[data-cloud-detail="0"]').click();await waitFor(()=>document.querySelector('.cloud-details')?.textContent.includes('1700000030'));
      document.querySelector('[data-cloud-pin]').click();await waitFor(()=>document.querySelectorAll('.cloud-fav').length===2);
      document.querySelector('[data-cloud-close]').click();
      [...document.querySelectorAll('.cloud-fav')].find(e=>e.textContent.includes('我的金山文档')).querySelector('[data-cloud-remove]').click();
      await waitFor(()=>document.querySelectorAll('.cloud-fav').length===1);
      document.querySelector('.cloud-fav').click();await waitFor(()=>document.querySelector('.cloud-entry')?.textContent.includes('接口说明'));
      document.querySelector('[data-cloud-entry="0"]').click();await waitFor(()=>!document.querySelector('dialog.cloud-dialog').open);
      return {authIsToken,onlyFolders:!options.includes('feishu-document')&&!options.includes('feishu-wiki-document'),preview:PV.pane.allPanes().some(p=>p.node?.url==='https://www.kdocs.cn/l/fixtureDoc'),noSignedUrls:!JSON.stringify(PV.pane.layoutSnapshot()).includes('kdocs.cn')};
    })()`);
    ok('金山只展示适用的访问令牌鉴权',result.authIsToken,result);
    ok('来源选择不含单文档插件',result.onlyFolders,result);
    ok('子目录快捷项可独立浏览并打开文档',result.preview,result);
    ok('金山在线链接不进入持久化布局',result.noSignedUrls,result);
    ok('金山令牌不保存到设置',!JSON.stringify(saved).includes('fixture-secret'));
    for(const mount of await service.mounts()) await service.remove(mount.id);
    ipcMain.removeHandler('directories:call');ipcMain.handle('directories:call',(_e,method)=>({value:method==='mounts'||method==='providers'?[]:true}));
    await runPage('PV.cloud.setProject('+JSON.stringify(f.ws)+')');await clearPinnedColumns(runPage);
  });

  await run('R1', '全局刷新只重读变化的预览', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['refresh.md']);
    let version = 1;
    let reads = 0;
    stubRead(() => { reads++; return { text: '# VERSION_' + version, size: version, mtime: version }; });
    ipcMain.removeHandler('fs:stat');
    ipcMain.handle('fs:stat', () => ({ size: version, mtime: version }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
    await runPage(`(async()=>{
      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('refresh.md')).click();
      await waitFor(()=>document.querySelector('.prose')?.textContent.includes('VERSION_1'));
      document.querySelector('#btn-refresh').click();
      await waitFor(()=>!document.querySelector('#btn-refresh').disabled);
    })()`);
    eq('无变化时不重新读取正文', reads, 1);
    version = 2;
    await runPage(`(async()=>{
      document.querySelector('#btn-refresh').click();
      await waitFor(()=>document.querySelector('.prose')?.textContent.includes('VERSION_2'));
      await waitFor(()=>!document.querySelector('#btn-refresh').disabled);
    })()`);
    eq('变化后重新读取一次', reads, 2);
    ipcMain.removeHandler('fs:stat');
    ipcMain.handle('fs:stat', () => ({ size: 0, mtime: 0 }));
  });

  await run('F1', '预览内查找：命中、切走自动关、固定时跟过去', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['doc.md', 'code.js']);
    // ipcMain.handle 的监听器第一个参数是 event，路径在第二个
    stubRead((_e, p) => ({
      text: /\.md$/.test(String(p)) ? 'ZEBRA one\n\nZEBRA two\n' : 'const a = 1;\n'.repeat(3000) + 'const ZEBRA = 1;\n',
      size: 24
    }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
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
      await waitFor(()=>pane().querySelector('.prose') && /ZEBRA/.test(pane().textContent));
      ctrlF();
      await waitFor(()=>openFindBar());
      const opened=!!openFindBar();
      search('ZEBRA');
      await waitFor(()=>pane().querySelectorAll('mark.find-hit').length===2);
      const hits=pane().querySelectorAll('mark.find-hit').length;
      const count=openFindBar().querySelector('.find-count').textContent;
      openFindBar().querySelector('[data-find="next"]').click();
      await waitFor(()=>openFindBar().querySelector('.find-count').textContent==='2/2');
      const afterNext=openFindBar().querySelector('.find-count').textContent;

      // 查找覆盖虚拟滚动之外的源码行，并保留当前查询词。
      clickRow('code.js');
      await waitFor(()=>pane().querySelector('.codeview mark.is-current'));
      const closedOnCode=!!openFindBar() && openFindBar().querySelector('.find-count').textContent==='1/1';
      const codeView=!!pane().querySelector('.codeview');

      // 回到 Markdown 再查一次，这次固定住：正文与查找条一起搬到新列
      clickRow('doc.md');
      await waitFor(()=>pane().querySelector('.prose') && /ZEBRA/.test(pane().textContent));
      ctrlF();
      await waitFor(()=>openFindBar());
      search('ZEBRA');
      await waitFor(()=>pane().querySelectorAll('mark.find-hit').length===2);
      pane().querySelector('button[data-act="pin"]').click();
      await waitFor(()=>{const p=document.querySelector('.pane.is-pinned');
        return p && p.querySelectorAll('mark.find-hit').length===2;});
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
    ok('源码查找定位到第 3001 行的匹配', f1.closedOnCode && f1.codeView, f1);
    ok('固定时查询词跟到新列', f1.carried, f1);
    eq('固定列里的命中重新落上', f1.pinHits, 2);
    await clearPinnedColumns(runPage);
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
    await waitStubbedRows(runPage);
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
      await waitFor(()=>pane().querySelector('.md-code span')
        && pane().querySelectorAll('.md-code mark.find-hit').length>=1, 10000);
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
    await waitStubbedRows(runPage);
    const p1 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      const clickRow=(n)=>[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(n)).click();

      clickRow('a.svg');
      await waitFor(()=>pane().querySelector('.img-wrap'));
      const single=!!pane().querySelector('.img-wrap');

      pane().querySelector('button[data-act="seq"]').click();
      await waitFor(()=>pane().querySelectorAll('.imgseq-item').length===3);
      const items=pane().querySelectorAll('.imgseq-item').length;
      const current=pane().querySelectorAll('.imgseq-item.is-current').length;

      pane().querySelector('button[data-act="zoom-in"]').click();
      await waitFor(()=>pane().querySelector('[data-act="zoom-reset"]').textContent==='100%');
      const zoom=pane().querySelector('[data-act="zoom-reset"]').textContent;

      // 切到非图片：连续预览自动退出
      clickRow('note.md');
      await waitFor(()=>pane().querySelector('.prose') && !pane().querySelector('.imgseq'));
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
    await waitStubbedRows(runPage);
    const p2 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      const clickRow=(n)=>[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(n)).click();
      const t0=Date.now();
      clickRow('x.svg');
      await wait(50);
      clickRow('y.svg');
      await waitFor(()=>pane().querySelector('.img-wrap img'));
      const left=650-(Date.now()-t0);
      if(left>0) await wait(left);
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

  await run('E1', 'SVG 编辑：改字、拖动、缩放、删除与撤销都写回', async () => {
    const f = await prepare();
    const runPage = await renderer();
    const svgPath = path.join(f.ws, 'fig.svg');
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">'
      + '<rect id="bg" width="400" height="200" fill="#fff"/>'
      + '<rect id="box" x="40" y="40" width="120" height="60" fill="#eef"/>'
      + '<text x="100" y="70" text-anchor="middle" font-size="16" fill="#111">Alpha</text>'
      + '<rect id="gone" x="240" y="40" width="80" height="60" fill="#fee"/>'
      + '<text x="280" y="70" text-anchor="middle" font-size="16" fill="#111">Beta</text>'
      + '</svg>';
    stubList(f.ws, ['fig.svg']);
    stubRead(() => ({ text: source, size: source.length, mtime: 1 }));
    ipcMain.removeHandler('fs:preview-url');
    ipcMain.handle('fs:preview-url', () => ({ url: 'data:image/svg+xml,%3Csvg%2F%3E' }));
    const writes = [];
    ipcMain.removeHandler('fs:write-svg');
    ipcMain.handle('fs:write-svg', (_e, p, content, expected) => {
      writes.push({ path: p, content: content, expected: expected });
      return { ok: true, size: content.length, mtime: 1000 + writes.length };
    });
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
    const e1 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const pe=(type,el,x,y)=>el.dispatchEvent(new PointerEvent(type,{
        bubbles:true,cancelable:true,pointerId:9,button:0,
        buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));
      const click=async(el)=>{const r=el.getBoundingClientRect();
        const x=r.left+r.width/2,y=r.top+r.height/2;
        pe('pointerdown',el,x,y); pe('pointerup',window,x,y); await wait(60);};
      const key=async(el,k,extra)=>{el.dispatchEvent(new KeyboardEvent('keydown',
        Object.assign({key:k,bubbles:true,cancelable:true},extra||{}))); await wait(60);};
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      const root=()=>pane().querySelector('.svg-stage svg');

      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('fig.svg')).click();
      await waitFor(()=>pane().querySelector('[data-act="svg-edit"]'));
      pane().querySelector('[data-act="svg-edit"]').click();
      await waitFor(()=>root());
      const mounted=!!root();

      // 双击改字
      const alpha=[...root().querySelectorAll('text')].find(t=>t.textContent==='Alpha');
      alpha.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
      await waitFor(()=>pane().querySelector('.svg-textinput'));
      const input=pane().querySelector('.svg-textinput');
      const inputShown=!!input;
      if(input){ input.value='Alpha2';
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); }
      await waitFor(()=>[...root().querySelectorAll('text')].some(t=>t.textContent==='Alpha2')
        && pane().querySelector('.svg-status').textContent==='已保存');

      // 拖动矩形：框里的文字跟着走
      let box=root().querySelector('#box');
      await click(box);
      let br=box.getBoundingClientRect();
      pe('pointerdown',box,br.left+br.width/2,br.top+br.height/2);
      pe('pointermove',window,br.left+br.width/2+30,br.top+br.height/2+20);
      pe('pointerup',window,br.left+br.width/2+30,br.top+br.height/2+20);
      await waitFor(()=>{const b=root().querySelector('#box');
        const t=[...root().querySelectorAll('text')].find(t=>t.textContent==='Alpha2');
        return (b.getAttribute('transform')||'').indexOf('translate')>=0
          && (t.getAttribute('transform')||'').indexOf('translate')>=0;});
      const movedBox=(box.getAttribute('transform')||'').indexOf('translate')>=0;
      const movedText=([...root().querySelectorAll('text')]
        .find(t=>t.textContent==='Alpha2').getAttribute('transform')||'').indexOf('translate')>=0;

      // 缩放矩形：拖右下角
      box=root().querySelector('#box');
      await click(box);
      const w0=Number(box.getAttribute('width'));
      const grip=pane().querySelector('.svg-grip[data-h="se"]');
      const g=grip.getBoundingClientRect();
      pe('pointerdown',grip,g.left+g.width/2,g.top+g.height/2);
      pe('pointermove',window,g.left+g.width/2+50,g.top+g.height/2+30);
      pe('pointerup',window,g.left+g.width/2+50,g.top+g.height/2+30);
      await waitFor(()=>Number(root().querySelector('#box').getAttribute('width'))>w0);
      const w1=Number(root().querySelector('#box').getAttribute('width'));

      // 删除矩形：框里的文字一起删；Ctrl+Z 一起回来
      await click(root().querySelector('#gone'));
      await key(pane().querySelector('.svg-edit'),'Delete');
      await waitFor(()=>!root().querySelector('#gone')
        && ![...root().querySelectorAll('text')].some(t=>t.textContent==='Beta'));
      const afterDelete={
        rect:!!root().querySelector('#gone'),
        beta:!![...root().querySelectorAll('text')].find(t=>t.textContent==='Beta')
      };
      await key(pane().querySelector('.svg-edit'),'z',{ctrlKey:true});
      await waitFor(()=>root().querySelector('#gone')
        && [...root().querySelectorAll('text')].some(t=>t.textContent==='Beta'));
      const afterUndo={
        rect:!!root().querySelector('#gone'),
        beta:!![...root().querySelectorAll('text')].find(t=>t.textContent==='Beta')
      };

      return {mounted,inputShown,labels:[...root().querySelectorAll('text')].map(t=>t.textContent),
        movedBox,movedText,w0,w1,afterDelete,afterUndo,
        status:pane().querySelector('.svg-status').textContent};
    })()`);
    ok('SVG 以可编辑 DOM 挂载', e1.mounted, e1);
    ok('双击文字出现输入框', e1.inputShown, e1);
    ok('文字改完落在 DOM 里', e1.labels.indexOf('Alpha2') >= 0, e1.labels);
    ok('拖矩形时框里的文字一起移动', e1.movedBox && e1.movedText, e1);
    ok('拖右下角能放大矩形', e1.w1 > e1.w0, { w0: e1.w0, w1: e1.w1 });
    ok('删除矩形时框里的文字一起删掉',
      !e1.afterDelete.rect && !e1.afterDelete.beta, e1.afterDelete);
    ok('撤销后矩形与文字一起回来',
      e1.afterUndo.rect && e1.afterUndo.beta, e1.afterUndo);
    eq('最后一次保存成功', e1.status, '已保存');
    ok('改动确实走了保存通道', writes.length >= 4, writes.length);
    ok('只写当前这个 SVG', writes.every((w) => w.path === svgPath), writes.map((w) => w.path));
    ok('第一次保存带上读取时的版本',
      writes[0] && writes[0].expected && writes[0].expected.mtime === 1,
      writes[0] && writes[0].expected);
    const last = writes[writes.length - 1] || { content: '' };
    ok('写回的内容包含改后的文字', last.content.indexOf('Alpha2') >= 0, last.content.slice(0, 120));
    ok('撤销后的内容包含被恢复的矩形与文字',
      last.content.indexOf('id="gone"') >= 0 && last.content.indexOf('Beta') >= 0,
      last.content.slice(0, 160));
  });

  await run('E2', 'SVG 保存边界：只写工作区内已存在的 .svg', async () => {
    const f = await prepare();
    // 前面的用例可能切换过工作区、清掉过授权根；这里直接测写入口，先显式恢复
    await fsApi.allowRoot(f.ws);
    const svgPath = path.join(f.ws, 'edit.svg');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const before = fs.statSync(svgPath);
    const saved = await fsApi.writeSvgFile(svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      { size: before.size, mtime: before.mtimeMs });
    ok('工作区内的 SVG 可以保存', saved && saved.ok, saved);
    ok('内容已落盘', fs.readFileSync(svgPath, 'utf8').indexOf('<rect') >= 0);

    const txt = path.join(f.ws, 'note.txt');
    fs.writeFileSync(txt, 'x');
    let code = null;
    try { await fsApi.writeSvgFile(txt, 'x', null); } catch (err) { code = err.code; }
    eq('非 .svg 被拒绝', code, 'ENOT_SVG');

    const outside = path.join(f.outside, 'outside.svg');
    fs.writeFileSync(outside, '<svg/>');
    code = null;
    try { await fsApi.writeSvgFile(outside, 'x', null); } catch (err) { code = err.code; }
    eq('工作区外的文件被拒绝', code, 'EACCES_ROOT');

    const conflict = await fsApi.writeSvgFile(svgPath, '<svg/>', { size: 1, mtime: 1 });
    eq('磁盘版本不一致时返回 CONFLICT', conflict && conflict.error, 'CONFLICT');
    ok('冲突时不改文件', fs.readFileSync(svgPath, 'utf8').indexOf('<rect') >= 0);

    const st = fs.statSync(svgPath);
    const again = await fsApi.writeSvgFile(svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>',
      { size: st.size, mtime: st.mtimeMs });
    ok('用保存后的新版本可以继续保存', again && again.ok, again);

    // GBK 编码的文件读出来时要带上编码标记，编辑器据此拒绝保存（否则会写成 UTF-8）
    const gbkPath = path.join(f.ws, 'gbk.svg');
    fs.writeFileSync(gbkPath, Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]));
    const gbk = await fsApi.readFileForPreview(gbkPath);
    eq('GBK 文件会带出编码信息', gbk.encoding, 'gbk');
    eq('GBK 文本按中文解码', gbk.text, '中文');
  });

  await run('E3', '含脚本的 SVG 只读显示，不执行也不保存', async () => {
    const f = await prepare();
    const runPage = await renderer();
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"'
      + ' onload="window.__svgEditPwned=1">'
      + '<script>window.__svgEditPwned=2</script>'
      + '<style>@import url(file:///C:/secret.css);</style>'
      + '<a href="javascript:window.__svgEditPwned=3">'
      + '<rect id="r" x="10" y="10" width="40" height="30" fill="url(file:///C:/secret.svg#p)"/></a>'
      + '<image href="relative.png" width="5" height="5"/>'
      + '</svg>';
    stubList(f.ws, ['risky.svg']);
    stubRead(() => ({ text: source, size: source.length, mtime: 1 }));
    ipcMain.removeHandler('fs:preview-url');
    ipcMain.handle('fs:preview-url', () => ({ url: 'data:image/svg+xml,%3Csvg%2F%3E' }));
    const writes = [];
    ipcMain.removeHandler('fs:write-svg');
    ipcMain.handle('fs:write-svg', (_e, p, content) => {
      writes.push({ path: p, content: content });
      return { ok: true, size: content.length, mtime: 2 };
    });
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
    const e3 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const pane=()=>document.querySelector('.pane:not(.is-pinned)');
      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('risky.svg')).click();
      await waitFor(()=>pane().querySelector('[data-act="svg-edit"]'));
      pane().querySelector('[data-act="svg-edit"]').click();
      await waitFor(()=>pane().querySelector('.svg-stage svg'));
      const root=pane().querySelector('.svg-stage svg');
      const rect=root && root.querySelector('#r');
      const r=rect && rect.getBoundingClientRect();
      if (rect) {
        rect.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,
          pointerId:3,button:0,buttons:1,clientX:r.left+5,clientY:r.top+5}));
        rect.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,
          pointerId:3,button:0,buttons:0,clientX:r.left+5,clientY:r.top+5}));
      }
      pane().querySelector('.svg-edit').dispatchEvent(new KeyboardEvent('keydown',
        {key:'Delete',bubbles:true,cancelable:true}));
      await wait(50);
      return {
        mounted: !!root,
        risky: !!pane().querySelector('.svg-edit.is-risky'),
        status: pane().querySelector('.svg-status').textContent,
        script: !!(root && root.querySelector('script')),
        onload: root ? root.getAttribute('onload') : 'NO_ROOT',
        href: root && root.querySelector('a') ? root.querySelector('a').getAttribute('href') : null,
        fill: root && root.querySelector('#r') ? root.querySelector('#r').getAttribute('fill') : 'NO_RECT',
        imgHref: root && root.querySelector('image') ? root.querySelector('image').getAttribute('href') : 'NO_IMAGE',
        style: !!(root && root.querySelector('style')),
        rectStill: !!(root && root.querySelector('#r')),
        pwned: window.__svgEditPwned
      };
    })()`);
    ok('编辑器仍然挂载（只读显示）', e3.mounted, e3);
    ok('标成只读模式', e3.risky && e3.status === '只读', e3);
    ok('脚本元素已被摘掉', !e3.script, e3);
    eq('事件属性已被摘掉', e3.onload, null);
    eq('javascript: 链接已被摘掉', e3.href, null);
    eq('表现属性里的外部 url() 被摘掉', e3.fill, null);
    eq('相对资源引用被摘掉', e3.imgHref, null);
    ok('@import 的 <style> 整块被摘掉', !e3.style, e3);
    ok('只读模式下 Delete 不删形状', e3.rectStill, e3);
    ok('脚本没有执行', e3.pwned === undefined || e3.pwned === null, e3.pwned);
    eq('只读模式不会写文件', writes.length, 0);
  });

  await run('E4', '真实鼠标双击文字能打开输入框', async () => {
    const f = await prepare();
    const runPage = await renderer();
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">'
      + '<rect width="400" height="200" fill="#fff"/>'
      + '<text x="200" y="100" text-anchor="middle" font-size="20" fill="#111">Alpha</text>'
      + '</svg>';
    stubList(f.ws, ['dbl.svg']);
    stubRead(() => ({ text: source, size: source.length, mtime: 1 }));
    ipcMain.removeHandler('fs:preview-url');
    ipcMain.handle('fs:preview-url', () => ({ url: 'data:image/svg+xml,%3Csvg%2F%3E' }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
    const pt = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      [...document.querySelectorAll('.row')].find(e=>e.textContent.includes('dbl.svg')).click();
      await waitFor(()=>document.querySelector('.pane:not(.is-pinned) [data-act="svg-edit"]'));
      document.querySelector('.pane:not(.is-pinned) [data-act="svg-edit"]').click();
      await waitFor(()=>document.querySelectorAll('.svg-stage svg text').length>0);
      const text=[...document.querySelectorAll('.svg-stage svg text')].find(t=>t.textContent==='Alpha');
      if (!text) return { error: 'NO_TEXT' };
      const r=text.getBoundingClientRect();
      return { x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height };
    })()`);
    ok('找到可双击的文字', pt && !pt.error && pt.w > 0 && pt.h > 0, pt);
    const x = Math.round(pt.x);
    const y = Math.round(pt.y);
    const ev = (type, clickCount) => createdWin.webContents.sendInputEvent({
      type: type, x: x, y: y, button: 'left', clickCount: clickCount
    });
    ev('mouseDown', 1); ev('mouseUp', 1);
    await sleep(50);
    ev('mouseDown', 2); ev('mouseUp', 2);
    await waitPage(runPage, "!!document.querySelector('.svg-textinput')");
    const dbl = await runPage(`(() => {
      const i=document.querySelector('.svg-textinput');
      return { input:!!i, value:i?i.value:null,
        active:document.activeElement?document.activeElement.className:null };
    })()`);
    ok('真实双击打开输入框', dbl.input, dbl);
    eq('输入框带着原文', dbl.value, 'Alpha');
    eq('焦点在输入框上', dbl.active, 'svg-textinput');
  });

  await run('P3', '拖动抓手换位置；临时列拖到右侧自动固定', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['alpha.md', 'beta.md', 'gamma.md']);
    stubRead((_e, p) => ({ text: path.basename(String(p)).toUpperCase(), size: 10 }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
    const p3 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const clickRow=(n)=>[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(n)).click();
      const pin=()=>document.querySelector('.pane:not(.is-pinned) button[data-act="pin"]').click();
      // DOM 顺序是创建顺序，视觉顺序看 flex 排出来的 left
      const pinnedNames=()=>[...document.querySelectorAll('.pane.is-pinned')]
        .sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)
        .map(e=>e.querySelector('.pv-nm').textContent.trim());
      const headOf=(name)=>[...document.querySelectorAll('.pane.is-pinned .pv-head')]
        .find(h=>h.querySelector('.pv-nm').textContent.trim()===name);
      const gripOf=(name)=>headOf(name).querySelector('.pv-grip');
      const ev=(type,el,x,y)=>el.dispatchEvent(new PointerEvent(type,{
        bubbles:true,cancelable:true,pointerId:7,button:0,
        buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));
      const drag=(from,to,fx)=>{
        const g=gripOf(from).getBoundingClientRect(), b=headOf(to).getBoundingClientRect();
        const sy=g.top+g.height/2, ty=b.top+8, x2=b.left+b.width*fx;
        const panes=document.querySelector('#panes');
        ev('pointerdown',gripOf(from),g.left+g.width/2,sy);
        ev('pointermove',panes,g.left+g.width/2+10,sy);   // 越过 4px 阈值，进入拖动
        ev('pointermove',panes,x2,ty);                    // 移过目标列的中点
        ev('pointerup',panes,x2,ty);
        return wait(150);
      };

      clickRow('alpha.md');
      await waitFor(()=>{const n=document.querySelector('.pane:not(.is-pinned) .pv-nm');
        return n && n.textContent.trim()==='alpha.md';});
      pin();
      await waitFor(()=>document.querySelectorAll('.pane.is-pinned').length>=1);
      clickRow('beta.md');
      await waitFor(()=>{const n=document.querySelector('.pane:not(.is-pinned) .pv-nm');
        return n && n.textContent.trim()==='beta.md';});
      pin();
      await waitFor(()=>document.querySelectorAll('.pane.is-pinned').length>=2);
      const before=pinnedNames();                         // 新固定的在左边
      await drag('beta.md','alpha.md',0.9);
      const after=pinnedNames();

      // 临时列的抓手拖到右侧：这一次落点会把它固定成最后一列
      clickRow('gamma.md');
      await waitFor(()=>{const n=document.querySelector('.pane:not(.is-pinned) .pv-nm');
        return n && n.textContent.trim()==='gamma.md';});
      const tg=document.querySelector('.pane:not(.is-pinned) .pv-grip');
      const tr=tg.getBoundingClientRect();
      const bh=headOf('beta.md').getBoundingClientRect();
      const panes=document.querySelector('#panes');
      ev('pointerdown',tg,tr.left+tr.width/2,tr.top+tr.height/2);
      ev('pointermove',panes,tr.left+tr.width/2+10,tr.top+tr.height/2);
      ev('pointermove',panes,bh.left+bh.width*0.9,bh.top+8);
      ev('pointerup',panes,bh.left+bh.width*0.9,bh.top+8);
      await waitFor(()=>document.querySelectorAll('.pane.is-pinned').length>=3
        && !!document.querySelector('.pane:not(.is-pinned)')
        && document.querySelector('.pane:not(.is-pinned)').hidden);
      const temp=document.querySelector('.pane:not(.is-pinned)');
      return {before, after, final:pinnedNames(), tempHidden:!!temp && temp.hidden,
        toastText:document.querySelector('#toast').textContent};
    })()`);
    eqJson('新固定的列排在左边', p3.before, ['beta.md', 'alpha.md']);
    eqJson('把左列拖到右列之后，顺序互换', p3.after, ['alpha.md', 'beta.md']);
    eqJson('临时列拖到右侧后固定成最后一列', p3.final, ['alpha.md', 'beta.md', 'gamma.md']);
    ok('自动固定后临时列收起', p3.tempHidden, p3);
    ok('提示已固定临时列', p3.toastText.indexOf('已固定：gamma.md') >= 0, p3.toastText);
    await clearPinnedColumns(runPage);
  });

  await run('P4', '拖到列的下 1/3 分屏；取消一格后恢复单格；临时列也能分屏', async () => {
    const f = await prepare();
    const runPage = await renderer();
    stubList(f.ws, ['alpha.md', 'beta.md', 'gamma.md']);
    stubRead((_e, p) => ({ text: path.basename(String(p)).toUpperCase(), size: 10 }));
    createdWin.webContents.send('workspace:opened', f.ws);
    await waitStubbedRows(runPage);
    const p4 = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const clickRow=(n)=>[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(n)).click();
      const pin=()=>document.querySelector('.pane:not(.is-pinned) button[data-act="pin"]').click();
      const paneOf=(name)=>[...document.querySelectorAll('.pane.is-pinned')]
        .find(p=>p.querySelector('.pv-nm').textContent.trim()===name);
      const ev=(type,el,x,y)=>el.dispatchEvent(new PointerEvent(type,{
        bubbles:true,cancelable:true,pointerId:9,button:0,
        buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));
      const dragGripTo=(grip,x,y)=>{
        const r=grip.getBoundingClientRect(), panes=document.querySelector('#panes');
        ev('pointerdown',grip,r.left+r.width/2,r.top+r.height/2);
        ev('pointermove',panes,r.left+r.width/2+8,r.top+r.height/2);
        ev('pointermove',panes,x,y);
        ev('pointerup',panes,x,y);
      };
      const splitPanes=()=>{
        const col=document.querySelector('.pane-col.is-split');
        if(!col) return [];
        return [...col.querySelectorAll('.pane')].map(p=>({
          name:p.querySelector('.pv-nm').textContent.trim(),
          top:p.getBoundingClientRect().top,
          w:p.getBoundingClientRect().width
        })).sort((a,b)=>a.top-b.top);
      };

      clickRow('alpha.md');
      await waitFor(()=>{const n=document.querySelector('.pane:not(.is-pinned) .pv-nm');
        return n && n.textContent.trim()==='alpha.md';});
      pin();
      await waitFor(()=>document.querySelectorAll('.pane.is-pinned').length>=1);
      clickRow('beta.md');
      await waitFor(()=>{const n=document.querySelector('.pane:not(.is-pinned) .pv-nm');
        return n && n.textContent.trim()==='beta.md';});
      pin();
      await waitFor(()=>document.querySelectorAll('.pane.is-pinned').length>=2);
      const ar=paneOf('alpha.md').getBoundingClientRect();
      dragGripTo(paneOf('beta.md').querySelector('.pv-grip'),
        ar.left+ar.width/2, ar.top+ar.height*0.85);
      await waitFor(()=>document.querySelector('.pane-col.is-split'));
      const split=!!document.querySelector('.pane-col.is-split');
      const panes=splitPanes();
      const visibleCols=[...document.querySelectorAll('.pane-col')].filter(c=>!c.hidden).length;

      // 分屏里取消下面那一格：列还在，恢复成一格
      paneOf('beta.md').querySelector('button[data-act="pin"]').click();
      await waitFor(()=>!document.querySelector('.pane-col.is-split'));
      const afterUnpin={
        split:document.querySelectorAll('.pane-col.is-split').length,
        pinned:[...document.querySelectorAll('.pane.is-pinned')]
          .map(p=>p.querySelector('.pv-nm').textContent.trim())
      };

      // 临时列：拖到 alpha 那一列的下 1/3，直接固定并分屏
      clickRow('gamma.md');
      await waitFor(()=>{const n=document.querySelector('.pane:not(.is-pinned) .pv-nm');
        return n && n.textContent.trim()==='gamma.md';});
      const tempGrip=document.querySelector('.pane:not(.is-pinned) .pv-grip');
      const ar2=paneOf('alpha.md').getBoundingClientRect();
      dragGripTo(tempGrip, ar2.left+ar2.width/2, ar2.top+ar2.height*0.85);
      await waitFor(()=>!!document.querySelector('.pane-col.is-split')
        && !!document.querySelector('.pane:not(.is-pinned)')
        && document.querySelector('.pane:not(.is-pinned)').hidden);
      const tempSplit=splitPanes();
      const temp=document.querySelector('.pane:not(.is-pinned)');
      return {
        split:split, panes:panes, visibleCols:visibleCols,
        afterUnpin:afterUnpin,
        tempSplit:tempSplit, tempHidden:!!temp && temp.hidden,
        toastText:document.querySelector('#toast').textContent
      };
    })()`);
    ok('下 1/3 落点形成分屏', p4.split, p4);
    eqJson('一列里上 alpha 下 beta', p4.panes.map((p) => p.name), ['alpha.md', 'beta.md']);
    ok('分屏两格同宽', p4.panes.length === 2 && Math.abs(p4.panes[0].w - p4.panes[1].w) < 2, p4.panes);
    eq('分屏不增加列数', p4.visibleCols, 1);
    eq('取消分屏里的一格后列还在', p4.afterUnpin.split, 0);
    eqJson('只留下 alpha', p4.afterUnpin.pinned, ['alpha.md']);
    eqJson('临时列拖到 alpha 下 1/3 后上下分屏', p4.tempSplit.map((p) => p.name), ['alpha.md', 'gamma.md']);
    ok('临时列分屏后收起', p4.tempHidden, p4);
    ok('提示已分屏', p4.toastText.indexOf('已分屏：gamma.md') >= 0, p4.toastText);
    await clearPinnedColumns(runPage);
  });

  await run('P5', '切项目再回来：固定列、宽度、分屏比例与模式都恢复', async () => {
    const a = freshDir('layout-a');
    const b = freshDir('layout-b');
    const runPage = await renderer();
    // 同一个窗口里切换两个工作区；列表按目录返回不同文件，读内容用桩
    ipcMain.removeHandler('fs:list');
    ipcMain.handle('fs:list', (_e, dir) => {
      const isA = path.basename(String(dir)).toLowerCase() === 'layout-a';
      const files = isA ? ['alpha.md', 'beta.md'] : ['other.md'];
      return { entries: files.map((name) => ({
        name: name, path: path.join(dir, name), isDir: false, kind: 'md'
      })) };
    });
    stubRead((_e, p) => ({ text: path.basename(String(p)).toUpperCase(), size: 10 }));
    createdWin.setSize(1200, 820);
    await sleep(80);

    const openRoot = async (dir, row) => {
      createdWin.webContents.send('workspace:opened', dir);
      await waitPage(runPage, `[...document.querySelectorAll('.col[data-col="0"] .row .nm')]
        .some(e=>e.textContent===${JSON.stringify(row)})`);
    };

    await openRoot(a, 'alpha.md');
    const savedA = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const row=(n)=>[...document.querySelectorAll('.col[data-col="0"] .row')]
        .find(e=>e.querySelector('.nm').textContent===n);
      const temp=()=>document.querySelector('.pane:not(.is-pinned)');
      const paneOf=(n)=>[...document.querySelectorAll('.pane.is-pinned')]
        .find(p=>p.querySelector('.pv-nm').textContent.trim()===n);
      const pin=()=>temp().querySelector('[data-act="pin"]').click();
      const waitTemp=(n)=>waitFor(()=>{const el=temp() && temp().querySelector('.pv-nm');
        return el && el.textContent.trim()===n;});
      const waitPins=(n)=>waitFor(()=>document.querySelectorAll('.pane.is-pinned').length===n);
      const ev=(type,el,x,y)=>el.dispatchEvent(new PointerEvent(type,{
        bubbles:true,cancelable:true,pointerId:21,button:0,
        buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));
      const columns=()=>[...document.querySelectorAll('.pane-col')].filter(c=>!c.hidden)
        .sort((x,y)=>x.getBoundingClientRect().left-y.getBoundingClientRect().left)
        .map(c=>{
          const ps=[...c.querySelectorAll('.pane')]
            .sort((x,y)=>x.getBoundingClientRect().top-y.getBoundingClientRect().top);
          const stack=c.querySelector('.pane-stack').getBoundingClientRect();
          return {
            names:ps.map(p=>p.querySelector('.pv-nm').textContent.trim()),
            w:Math.round(c.getBoundingClientRect().width),
            split:c.classList.contains('is-split'),
            mode:ps[0].querySelector('.codeview')?'source':'preview',
            ratio:c.classList.contains('is-split')
              ? Math.round(ps[0].getBoundingClientRect().height/stack.height*100)/100 : null
          };
        });

      row('alpha.md').click(); await waitTemp('alpha.md'); pin(); await waitPins(1);
      row('beta.md').click(); await waitTemp('beta.md'); pin(); await waitPins(2);
      paneOf('beta.md').querySelector('[data-mode="source"]').click();
      await waitFor(()=>paneOf('beta.md').querySelector('.codeview'));
      // 最左列往左拖：把 beta 这一列加宽
      const col=paneOf('beta.md').closest('.pane-col');
      const grip=col.querySelector('.pane-resize');
      const gr=grip.getBoundingClientRect();
      const panes=document.querySelector('#panes');
      const x=Math.round(gr.left+2), y=Math.round(gr.top+gr.height/2);
      ev('pointerdown',grip,x,y);
      ev('pointermove',panes,x-40,y);
      ev('pointerup',panes,x-40,y);
      await wait(80);
      return columns();
    })()`);
    eqJson('A 项目两列顺序为新固定在前', savedA.map((c) => c.names[0]), ['beta.md', 'alpha.md']);
    eq('A 项目 beta 是源码模式', savedA[0].mode, 'source');

    await openRoot(b, 'other.md');
    const firstB = await runPage(`(async()=>{
      const waitForPins=(n)=>waitFor(()=>document.querySelectorAll('.pane.is-pinned').length===n);
      const pinned=()=>[...document.querySelectorAll('.pane.is-pinned')]
        .map(p=>p.querySelector('.pv-nm').textContent.trim());
      const before=pinned();
      const row=[...document.querySelectorAll('.col[data-col="0"] .row')]
        .find(e=>e.querySelector('.nm').textContent==='other.md');
      row.click();
      await waitFor(()=>{const n=document.querySelector('.pane:not(.is-pinned) .pv-nm');
        return n && n.textContent.trim()==='other.md';});
      document.querySelector('.pane:not(.is-pinned) [data-act="pin"]').click();
      await waitForPins(1);
      return { before: before, after: pinned() };
    })()`);
    eqJson('切到 B 时 A 的固定列先清掉', firstB.before, []);
    eqJson('B 项目自己的固定列', firstB.after, ['other.md']);

    await openRoot(a, 'alpha.md');
    const backA = await runPage(`(async()=>{
      const waitPins=(n)=>waitFor(()=>document.querySelectorAll('.pane.is-pinned').length===n);
      const paneOf=(n)=>[...document.querySelectorAll('.pane.is-pinned')]
        .find(p=>p.querySelector('.pv-nm').textContent.trim()===n);
      const columns=()=>[...document.querySelectorAll('.pane-col')].filter(c=>!c.hidden)
        .sort((x,y)=>x.getBoundingClientRect().left-y.getBoundingClientRect().left)
        .map(c=>{
          const ps=[...c.querySelectorAll('.pane')]
            .sort((x,y)=>x.getBoundingClientRect().top-y.getBoundingClientRect().top);
          return {
            names:ps.map(p=>p.querySelector('.pv-nm').textContent.trim()),
            w:Math.round(c.getBoundingClientRect().width),
            split:c.classList.contains('is-split'),
            mode:ps[0].querySelector('.codeview')?'source':'preview'
          };
        });
      await waitPins(2);
      await waitFor(()=>paneOf('beta.md').querySelector('.codeview'));
      return columns();
    })()`);
    eqJson('切回 A 后固定列顺序恢复', backA.map((c) => c.names[0]), ['beta.md', 'alpha.md']);
    ok('切回 A 后列宽恢复',
      backA.length === savedA.length
        && savedA.every((c, i) => Math.abs(c.w - backA[i].w) <= 1),
      { saved: savedA.map((c) => c.w), restored: backA.map((c) => c.w) });
    eq('切回 A 后 beta 仍是源码模式', backA[0].mode, 'source');

    const splitA = await runPage(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const paneOf=(n)=>[...document.querySelectorAll('.pane.is-pinned')]
        .find(p=>p.querySelector('.pv-nm').textContent.trim()===n);
      const ev=(type,el,x,y)=>el.dispatchEvent(new PointerEvent(type,{
        bubbles:true,cancelable:true,pointerId:23,button:0,
        buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));
      const columns=()=>[...document.querySelectorAll('.pane-col')].filter(c=>!c.hidden)
        .map(c=>{
          const ps=[...c.querySelectorAll('.pane')]
            .sort((x,y)=>x.getBoundingClientRect().top-y.getBoundingClientRect().top);
          const stack=c.querySelector('.pane-stack').getBoundingClientRect();
          return {
            names:ps.map(p=>p.querySelector('.pv-nm').textContent.trim()),
            w:Math.round(c.getBoundingClientRect().width),
            split:c.classList.contains('is-split'),
            mode:ps[0].querySelector('.codeview')?'source':'preview',
            ratio:c.classList.contains('is-split')
              ? Math.round(ps[0].getBoundingClientRect().height/stack.height*100)/100 : null
          };
        });
      const panes=document.querySelector('#panes');
      const br=paneOf('beta.md').getBoundingClientRect();
      const grip=paneOf('alpha.md').querySelector('.pv-grip');
      const gr=grip.getBoundingClientRect();
      ev('pointerdown',grip,gr.left+gr.width/2,gr.top+gr.height/2);
      ev('pointermove',panes,gr.left+gr.width/2+8,gr.top+gr.height/2);
      ev('pointermove',panes,br.left+br.width/2,br.top+br.height*0.85);
      ev('pointerup',panes,br.left+br.width/2,br.top+br.height*0.85);
      await waitFor(()=>document.querySelector('.pane-col.is-split'));
      const splitEl=document.querySelector('.pane-col.is-split .pane-split');
      const sr=splitEl.getBoundingClientRect();
      const sx=Math.round(sr.left+sr.width/2), sy=Math.round(sr.top+sr.height/2);
      ev('pointerdown',splitEl,sx,sy);
      ev('pointermove',panes,sx,sy+50);
      ev('pointerup',panes,sx,sy+50);
      await wait(80);
      return columns();
    })()`);
    eq('A 项目分屏后只留一列', splitA.length, 1);
    eqJson('分屏上下顺序 beta / alpha', splitA[0].names, ['beta.md', 'alpha.md']);
    ok('分屏比例已调整', splitA[0].ratio > 0.55, splitA[0]);

    await openRoot(b, 'other.md');
    const secondB = await runPage(`(async()=>{
      await waitFor(()=>document.querySelectorAll('.pane.is-pinned').length===1);
      return {
        names:[...document.querySelectorAll('.pane.is-pinned')]
          .map(p=>p.querySelector('.pv-nm').textContent.trim()),
        split:!!document.querySelector('.pane-col.is-split')
      };
    })()`);
    eqJson('B 项目没有被 A 的分屏影响', secondB.names, ['other.md']);
    eq('B 项目仍是单列', secondB.split, false);

    await openRoot(a, 'alpha.md');
    const finalA = await runPage(`(async()=>{
      const waitForPins=(n)=>waitFor(()=>document.querySelectorAll('.pane.is-pinned').length===n);
      const paneOf=(n)=>[...document.querySelectorAll('.pane.is-pinned')]
        .find(p=>p.querySelector('.pv-nm').textContent.trim()===n);
      await waitForPins(2);
      await waitFor(()=>document.querySelector('.pane-col.is-split'));
      await waitFor(()=>paneOf('beta.md').querySelector('.codeview'));
      const c=document.querySelector('.pane-col.is-split');
      const ps=[...c.querySelectorAll('.pane')]
        .sort((x,y)=>x.getBoundingClientRect().top-y.getBoundingClientRect().top);
      const stack=c.querySelector('.pane-stack').getBoundingClientRect();
      return {
        names:ps.map(p=>p.querySelector('.pv-nm').textContent.trim()),
        w:Math.round(c.getBoundingClientRect().width),
        mode:ps[0].querySelector('.codeview')?'source':'preview',
        ratio:Math.round(ps[0].getBoundingClientRect().height/stack.height*100)/100
      };
    })()`);
    eqJson('切回 A 后分屏上下顺序恢复', finalA.names, ['beta.md', 'alpha.md']);
    eq('切回 A 后 beta 仍是源码模式', finalA.mode, 'source');
    eq('切回 A 后分屏列宽恢复', finalA.w, splitA[0].w);
    ok('切回 A 后分屏比例恢复',
      Math.abs(finalA.ratio - splitA[0].ratio) <= 0.02,
      { saved: splitA[0].ratio, restored: finalA.ratio });
  });

  await run('P6', '关掉的临时预览列切项目回来仍保持关闭', async () => {
    const a = freshDir('closed-a');
    const b = freshDir('closed-b');
    const runPage = await renderer();
    ipcMain.removeHandler('fs:list');
    ipcMain.handle('fs:list', (_e, dir) => {
      const isA = path.basename(String(dir)).toLowerCase() === 'closed-a';
      return { entries: (isA ? ['one.md'] : ['two.md']).map((name) => ({
        name: name, path: path.join(dir, name), isDir: false, kind: 'md'
      })) };
    });
    stubRead(() => ({ text: 'BODY', size: 4 }));

    const openRoot = async (dir, row) => {
      createdWin.webContents.send('workspace:opened', dir);
      await waitPage(runPage, `[...document.querySelectorAll('.col[data-col="0"] .row .nm')]
        .some(e=>e.textContent===${JSON.stringify(row)})`);
    };

    await openRoot(a, 'one.md');
    const closed = await runPage(`(async()=>{
      [...document.querySelectorAll('.col[data-col="0"] .row')]
        .find(e=>e.querySelector('.nm').textContent==='one.md').click();
      await waitFor(()=>{const n=document.querySelector('.pane:not(.is-pinned) .pv-nm');
        return n && n.textContent.trim()==='one.md';});
      document.querySelector('.pane:not(.is-pinned) [data-act="close"]').click();
      await waitFor(()=>PV.pane.previewOpen()===false);
      return { open: PV.pane.previewOpen(), hidden: !!document.querySelector('#preview').hidden };
    })()`);
    eq('关掉临时预览后状态是收起', closed.open, false);
    ok('关掉后预览区隐藏', closed.hidden, closed);

    await openRoot(b, 'two.md');
    await openRoot(a, 'one.md');
    const back = await runPage(`(async()=>{
      await waitFor(()=>{const r=document.querySelector('.row.is-sel .nm');
        return r && r.textContent==='one.md';});
      return {
        open: PV.pane.previewOpen(),
        hidden: !!document.querySelector('#preview').hidden,
        tempHidden: !!document.querySelector('.pane:not(.is-pinned)').hidden
      };
    })()`);
    eq('切回 A 后仍是收起状态', back.open, false);
    ok('切回 A 后预览区没有自己展开', back.hidden && back.tempHidden, back);

    const reopened = await runPage(`(async()=>{
      [...document.querySelectorAll('.col[data-col="0"] .row')]
        .find(e=>e.querySelector('.nm').textContent==='one.md').click();
      await waitFor(()=>PV.pane.previewOpen()
        && !document.querySelector('#preview').hidden
        && !document.querySelector('.pane:not(.is-pinned)').hidden);
      return {
        open: PV.pane.previewOpen(),
        name: document.querySelector('.pane:not(.is-pinned) .pv-nm').textContent.trim()
      };
    })()`);
    eq('用户主动点文件仍会打开临时预览', reopened.open, true);
    eq('打开的还是选中的文件', reopened.name, 'one.md');
  });

  await run('W2', '网页读剪贴板按站点询问一次，允许后本次运行不再问', async () => {
    // 必须排在 W1 前面：W1 会销毁同一分区的窗口，紧接着再开窗加载会 ERR_FAILED
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><button id="paste">paste</button>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;

    const w = new BrowserWindow({
      show: false,
      width: 480,
      height: 360,
      webPreferences: {
        partition: webViews.PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false
      }
    });
    webViews.attachWindow(w);

    const prompts = [];
    const realBox = dialog.showMessageBox;
    dialog.showMessageBox = async (_win, opts) => { prompts.push(opts); return { response: 0 }; };
    const previous = await clipboard.readText();
    await clipboard.writeText('CLIP_TOKEN');
    const read = (gesture) => w.webContents.executeJavaScript(
      `navigator.clipboard.readText().then(t=>'ok:'+t).catch(e=>'err:'+e.name)`, gesture);

    try {
      await w.loadURL(origin + '/');
      w.webContents.focus();

      // 页面用 permissions.query 判断要不要显示粘贴入口；这里报 granted，
      // 但真正的读取仍会走 request handler 询问。
      eq('网页看到的剪贴板权限是 granted',
        await w.webContents.executeJavaScript(
          `navigator.permissions.query({name:'clipboard-read'}).then(p=>p.state)`), 'granted');
      eq('允许后能读到剪贴板', await read(true), 'ok:CLIP_TOKEN');
      eq('首次读取只弹一次窗', prompts.length, 1);
      ok('弹窗写明请求的站点',
        !!(prompts[0] && String(prompts[0].detail).indexOf(origin) >= 0),
        prompts[0] && prompts[0].detail);
      eq('同一站点再次读取不再询问', await read(true), 'ok:CLIP_TOKEN');
      eq('仍然只弹过一次', prompts.length, 1);
    } finally {
      dialog.showMessageBox = realBox;
      await clipboard.writeText(previous);
      w.destroy();
      server.close();
    }
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
