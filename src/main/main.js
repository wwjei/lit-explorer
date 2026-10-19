'use strict';

// 大目录批量 stat 会密集使用线程池，提前放大以免成为瓶颈
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, protocol } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

const fsApi = require('./fs-api');
const store = require('./store');

const DEV_ROOT = path.join(__dirname, '..', '..');
const DEV = process.argv.includes('--dev');
const SHOT = argValue('--shot=');
const SHOT_JS = argValue('--shot-js=');
const SHOT_DELAY = Number(argValue('--shot-delay=') || 1400);
const OPEN_ARG = argValue('--open=');

/** 打包后这些文件在 resources 下，asar 内的路径 shell.openPath 打不开 */
function assetPath(name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(DEV_ROOT, name);
}

let win = null;

function argValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    'lit explorer',
    '',
    '  --open=<dir>       启动时打开指定工作区',
    '  --dev              启动时打开开发者工具',
    '',
    '截图钩子（调试用：加载完成后截图并退出）',
    '  --shot=<file>      截图写到该文件',
    '  --shot-js=<file>   截图前先执行该 JS 文件，其返回值会打印到 stdout',
    '  --shot-delay=<ms>  截图前等待时长，默认 1400',
    '',
    '例：npm run shot -- --open="./sample-project" --shot=".tmp/shot.png"'
  ].join('\n'));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 预览专用协议：pv://local/<绝对路径>
 * 用自定义协议而不是 file://，这样 HTML 预览里的相对资源（css/js/图片）
 * 能正常解析，同时可以把访问范围限制在工作区内。
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pv',
    // corsEnabled 让预览页里的 ES module / fetch 能请求 pv:// 资源
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

function filePathFromUrl(rawUrl) {
  let p = decodeURIComponent(new URL(rawUrl).pathname);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // Windows 盘符前会多一个斜杠
  return p;
}

function toPreviewUrl(filePath) {
  const abs = path.resolve(filePath);
  const normalized = abs.split(path.sep).join('/');
  const prefix = normalized.startsWith('/') ? '' : '/';
  return 'pv://local' + prefix + normalized.split('/').map(encodeURIComponent).join('/');
}

function registerPreviewProtocol() {
  protocol.handle('pv', async (request) => {
    let abs;
    try {
      abs = await fsApi.assertAllowed(filePathFromUrl(request.url));
    } catch {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await fsp.readFile(abs);
      return new Response(data, {
        headers: {
          'content-type': fsApi.mimeFor(abs),
          'cache-control': 'no-store',
          // 预览 iframe 是不透明源（sandbox 无 allow-same-origin），
          // ES module / fetch 会走 CORS，必须允许跨源读取
          'access-control-allow-origin': '*'
        }
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */
async function createWindow() {
  const state = await store.load();
  const bounds = state.window && state.window.width ? state.window : null;

  // 主进程给过渲染进程的目录：命令行指定、上次的、最近打开过的。
  // 渲染进程只能从这些里挑着打开（见 workspace:open 的处理）。
  fsApi.offerRoot(OPEN_ARG);
  fsApi.offerRoot(state.lastRoot);
  for (const recent of state.recentRoots || []) fsApi.offerRoot(recent);

  win = new BrowserWindow(Object.assign(
    {
      width: 1440,
      height: 900,
      minWidth: 900,
      minHeight: 560,
      show: false,
      // 无边框：不要 Windows 原生标题栏与菜单栏，标题栏由界面自绘
      frame: false,
      backgroundColor: state.theme === 'dark' ? '#0f1115' : '#f5f6f8',
      title: 'lit explorer',
      // 打包后窗口/任务栏图标来自 exe 自身，开发时才需要显式指定
      icon: app.isPackaged ? undefined : path.join(DEV_ROOT, 'build', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // PDF 预览用 Chromium 内置阅读器（<iframe> 加载 application/pdf）
        plugins: true,
        spellcheck: false
      }
    },
    bounds || {}
  ));

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 最大化状态要回传给界面，用于切换按钮图标与去掉窗口描边
  const sendMaximized = () => {
    if (win && !win.isDestroyed()) win.webContents.send('window:maximized', win.isMaximized());
  };
  win.on('maximize', sendMaximized);
  win.on('unmaximize', sendMaximized);

  // 菜单栏已移除，开发者工具保留 F12 入口
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 外链一律交给系统浏览器，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    store.patch({ window: win.getNormalBounds() });
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  if (DEV) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.once('did-finish-load', async () => {
    const root = OPEN_ARG || state.lastRoot;
    if (root) {
      const res = await openWorkspace(root, { silent: true });
      // 上次的工作区可能已被删除，这时要让界面回到欢迎页而不是留一片空白
      if (!res || res.error) win.webContents.send('app:no-workspace');
    }
    if (SHOT) await captureAndQuit();
  });
}

async function captureAndQuit() {
  try {
    await new Promise((r) => setTimeout(r, SHOT_DELAY));
    if (SHOT_JS) {
      const code = await fsp.readFile(path.resolve(SHOT_JS), 'utf8');
      const result = await win.webContents.executeJavaScript(code, true);
      if (result !== undefined) console.log('[shot-js]', JSON.stringify(result));
      await new Promise((r) => setTimeout(r, 1400));
    }
    const image = await win.webContents.capturePage();
    const out = path.resolve(SHOT);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, image.toPNG());
    console.log('[shot] ' + out);
  } catch (err) {
    console.error('[shot] failed: ' + err.message);
  }
  app.exit(0);
}

/* ------------------------------------------------------------------ *
 * 工作区
 * ------------------------------------------------------------------ */
async function openWorkspace(dir, options = {}) {
  const abs = path.resolve(dir);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) {
    if (!options.silent) {
      dialog.showMessageBox(win, {
        type: 'warning',
        message: '无法打开该目录',
        detail: abs + '\n\n目录不存在或不可访问。'
      });
    }
    return { error: 'NOT_A_DIRECTORY' };
  }

  // 登记并统一使用真实路径：用户可能挑了一个符号链接 / junction，
  // 后续所有路径校验都在真实路径上做，界面里也用同一份地址。
  // 先清掉上一个工作区的授权根——读权限只跟当前打开的这个工作区走，
  // 否则在 A 里读过的目录，切到 B 之后仍然可读。
  fsApi.resetAllowedRoots();
  const root = (await fsApi.allowRoot(abs)) || abs;
  // 打开过的目录也算「给过渲染进程」：它之后可以再打开一次
  fsApi.offerRoot(root);
  const state = await store.load();
  const recent = [root, ...(state.recentRoots || []).filter((p) => p !== root)].slice(0, 8);
  await store.patch({ lastRoot: root, recentRoots: recent });
  win.setTitle(path.basename(root) + ' · lit explorer');
  win.webContents.send('workspace:opened', root);
  return { root: root };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('workspace:sample', () => fsApi.offerRoot(assetPath('sample-project')));

  ipcMain.handle('workspace:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择项目目录',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    return openWorkspace(res.filePaths[0]);
  });

  // 只接受主进程给过的目录（示例项目、最近打开、上次的工作区、已打开过的）。
  // 渲染进程不能凭自己拼的路径把任意现存目录登记成新的授权根——授权决策留在主进程。
  ipcMain.handle('workspace:open', async (_e, dir) => {
    if (!fsApi.isOfferedRoot(dir)) return { error: 'NOT_OFFERED' };
    return openWorkspace(dir);
  });

  ipcMain.handle('fs:list', async (_e, dir) => {
    try {
      const { dir: abs, entries } = await fsApi.listDir(dir);
      // 元信息（大小/修改时间）异步补发，不阻塞首屏
      fsApi.statEntries(abs, entries)
        .then((metas) => {
          if (win && !win.isDestroyed()) win.webContents.send('fs:meta', { dir: abs, metas });
        })
        .catch(() => {});
      return { dir: abs, entries };
    } catch (err) {
      return { error: err.code || 'ELIST', message: err.message };
    }
  });

  ipcMain.handle('fs:read', async (_e, filePath) => {
    try {
      return await fsApi.readFileForPreview(filePath);
    } catch (err) {
      return { error: err.code || 'EREAD', message: err.message };
    }
  });

  ipcMain.handle('fs:read-bytes', async (_e, filePath) => {
    try {
      return await fsApi.readFileBytes(filePath);
    } catch (err) {
      return { error: err.code || 'EREAD', message: err.message };
    }
  });

  ipcMain.handle('fs:stat', async (_e, target) => {
    try {
      return await fsApi.statPath(target);
    } catch (err) {
      return { error: err.code || 'ESTAT', message: err.message };
    }
  });

  ipcMain.handle('fs:preview-url', async (_e, filePath) => {
    try {
      return { url: toPreviewUrl(await fsApi.assertAllowed(filePath)) };
    } catch (err) {
      return { error: err.code || 'EURL' };
    }
  });

  ipcMain.handle('shell:open', async (_e, filePath) => {
    try {
      const abs = await fsApi.assertAllowed(filePath);
      // openPath 就是资源管理器双击的行为：交给系统文件关联
      const message = await shell.openPath(abs);
      return message ? { error: 'OPEN_FAILED', message } : { ok: true };
    } catch (err) {
      return { error: err.code || 'EOPEN', message: err.message };
    }
  });

  ipcMain.handle('shell:reveal', async (_e, filePath) => {
    try {
      shell.showItemInFolder(await fsApi.assertAllowed(filePath));
      return { ok: true };
    } catch (err) {
      return { error: err.code || 'EREVEAL', message: err.message };
    }
  });

  ipcMain.handle('clipboard:copy', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  ipcMain.handle('app:get-state', () => store.load());
  ipcMain.handle('app:set-state', (_e, changes) => store.patch(changes || {}));

  ipcMain.handle('ui:context-menu', (_e, payload) => showContextMenu(payload));
  ipcMain.handle('ui:app-menu', () => showAppMenu());

  /* 自绘标题栏的窗口控制 */
  ipcMain.handle('window:minimize', () => {
    win.minimize();
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    win.close();
  });
  ipcMain.handle('window:is-maximized', () => win.isMaximized());
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */
function showContextMenu(payload) {
  const target = payload && payload.path ? payload.path : null;
  const kind = payload ? payload.kind : 'empty';
  const items = [];

  if (target && kind === 'file') {
    items.push({ label: '用默认程序打开', click: () => shell.openPath(target) });
    items.push({ type: 'separator' });
  } else if (target && kind === 'folder') {
    items.push({ label: '在资源管理器中打开', click: () => shell.openPath(target) });
    items.push({ type: 'separator' });
  }

  if (target) {
    items.push({
      label: payload && payload.favorited ? '从快速访问中移除' : '添加到快速访问',
      click: () => win.webContents.send('app:toggle-favorite', {
        path: target,
        name: path.basename(target),
        isDir: kind === 'folder'
      })
    });
    items.push({ type: 'separator' });
    items.push({ label: '复制路径', click: () => clipboard.writeText(target) });
    items.push({ label: '复制名称', click: () => clipboard.writeText(path.basename(target)) });
    items.push({ label: '在资源管理器中显示', click: () => shell.showItemInFolder(target) });
    items.push({ type: 'separator' });
  }

  items.push({
    label: '重新扫描目录',
    accelerator: 'F5',
    click: () => win.webContents.send('app:rescan')
  });

  Menu.buildFromTemplate(items).popup({ window: win });
}

/* ------------------------------------------------------------------ *
 * 应用菜单
 *
 * 不用原生菜单栏（Windows 上那一行「文件 编辑 视图 帮助」太占地方也不好看），
 * 入口收敛到标题栏的 ⋯ 按钮、右键菜单和快捷键里。
 * ------------------------------------------------------------------ */
async function pickAndOpen() {
  const res = await dialog.showOpenDialog(win, {
    title: '选择项目目录',
    properties: ['openDirectory']
  });
  if (!res.canceled && res.filePaths.length) await openWorkspace(res.filePaths[0]);
}

async function toggleThemeFromMain() {
  const state = await store.load();
  const theme = state.theme === 'dark' ? 'light' : 'dark';
  await store.patch({ theme });
  win.webContents.send('app:theme', theme);
}

/** 切换某个预览开关，并把最新设置推回界面（正在预览的文件会立即重新渲染） */
async function togglePreviewPref(key) {
  const state = await store.load();
  const saved = await store.patch({ [key]: !(state[key] !== false) });
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:preview-prefs', {
      previewDocx: saved.previewDocx !== false,
      previewPptx: saved.previewPptx !== false
    });
  }
}

async function showAppMenu() {
  const state = await store.load();
  const items = [
    { label: '打开文件夹…', accelerator: 'Ctrl+O', click: pickAndOpen },
    { label: '打开示例项目', click: () => openWorkspace(assetPath('sample-project')) },
    { type: 'separator' },
    { label: '重新扫描目录', accelerator: 'F5', click: () => win.webContents.send('app:rescan') },
    { label: '聚焦搜索框', accelerator: 'Ctrl+F', click: () => win.webContents.send('app:focus-search') },
    { type: 'separator' },
    { label: '显示 / 隐藏预览面板', accelerator: 'Ctrl+B', click: () => win.webContents.send('app:toggle-preview') },
    { label: '切换明暗主题', accelerator: 'Ctrl+Shift+L', click: toggleThemeFromMain },
    { type: 'separator' },
    {
      label: '启用 Word (.docx) 内嵌预览',
      type: 'checkbox',
      checked: state.previewDocx !== false,
      click: () => togglePreviewPref('previewDocx')
    },
    {
      label: '启用 PPT (.pptx) 内嵌预览',
      type: 'checkbox',
      checked: state.previewPptx !== false,
      click: () => togglePreviewPref('previewPptx')
    },
    { type: 'separator' },
    { label: '开发者工具', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
    { label: '实际大小', accelerator: 'Ctrl+0', click: () => win.webContents.setZoomLevel(0) },
    { type: 'separator' },
    { label: '功能特性说明', click: () => shell.openPath(assetPath('FEATURES.md')) },
    { label: '代码高亮方案', click: () => shell.openPath(assetPath(path.join('docs', 'highlighting.md'))) },
    { label: '示例项目目录', click: () => shell.openPath(assetPath('sample-project')) }
  ];
  Menu.buildFromTemplate(items).popup({ window: win });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerPreviewProtocol();
    registerIpc();
    // 不要原生菜单栏
    Menu.setApplicationMenu(null);
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
