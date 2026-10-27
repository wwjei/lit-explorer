/*
 * MyGo 版的 window.pv：与 src/main/preload.js 暴露的接口同形，
 * 让 src/renderer 下的界面代码原样运行。调用在 window.mygo 注入之后才发生，
 * 所以这里只保存函数，不在加载时解析 window.mygo。
 *
 * 与 Electron 版的差异（能力屏蔽）：
 *   - webPane: false —— 没有 WebContentsView，内嵌网页改为在系统浏览器打开；
 *   - 网页列的 webSync / webReload / onWebState 是空实现。
 */
(function () {
  'use strict';

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return window.mygo.call.apply(null, [method].concat(args));
  }

  function on(name, fn) {
    if (!window.mygo || typeof window.mygo.on !== 'function') return function () {};
    return window.mygo.on(name, fn);
  }

  function base64Bytes(text) {
    var bin = atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  window.pv = {
    platform: 'win32',
    capabilities: { webPane: false },

    /* 工作区 */
    pickFolder: function () { return call('App.PickFolder'); },
    openRoot: function (dir) { return call('App.OpenRoot', dir); },
    getSampleRoot: function () { return call('App.GetSampleRoot'); },

    /* 项目快捷切换 */
    pickProjectIcon: function () { return call('App.PickProjectIcon'); },

    /* 文件系统 */
    list: function (dir) { return call('App.List', dir); },
    read: function (path) { return call('App.Read', path); },
    readBytes: function (path) {
      return call('App.ReadBytes', path).then(function (res) {
        if (res && typeof res.data === 'string' && res.data) {
          try { res.data = base64Bytes(res.data); } catch (err) { res.data = null; }
        }
        return res;
      });
    },
    stat: function (target) { return call('App.Stat', target); },
    previewUrl: function (path) { return call('App.PreviewURL', path); },
    resolveImages: function (mdPath, srcs) { return call('App.ResolveImages', mdPath, srcs); },
    writeSvg: function (path, content, expected) {
      return call('App.WriteSvg', path, content, expected || {});
    },

    /* 系统集成 */
    openPath: function (path) { return call('App.OpenPath', path); },
    reveal: function (path) { return call('App.Reveal', path); },
    copyText: function (text) { return call('App.CopyText', text); },
    openContextMenu: function (payload) { return call('App.OpenContextMenu', payload || {}); },
    openAppMenu: function () { return call('App.OpenAppMenu'); },

    /* 内嵌网页：MyGo 版没有原生视图，保留空实现 */
    webSync: function () { return Promise.resolve({ ok: true }); },
    webReload: function () { return Promise.resolve({ ok: false }); },
    openExternalUrl: function (url) { return call('App.OpenExternalURL', url); },

    /* 窗口控制 */
    minimize: function () { return call('App.Minimize'); },
    toggleMaximize: function () { return call('App.ToggleMaximize'); },
    closeWindow: function () { return call('App.CloseWindow'); },
    isMaximized: function () { return call('App.IsMaximized'); },
    onMaximized: function (cb) { return on('pv:maximized', cb); },

    /* 设置 */
    getState: function () { return call('App.GetState'); },
    setState: function (changes) { return call('App.SetState', changes || {}); },

    /* 主程序事件 */
    onMeta: function (cb) { return on('pv:meta', cb); },
    onOpenRoot: function (cb) { return on('pv:open-root', cb); },
    onNoWorkspace: function (cb) { return on('pv:no-workspace', cb); },
    onTheme: function (cb) { return on('pv:theme', cb); },
    onTogglePreview: function (cb) { return on('pv:toggle-preview', cb); },
    onRescan: function (cb) { return on('pv:rescan', cb); },
    onFocusSearch: function (cb) { return on('pv:focus-search', cb); },
    onToggleFavorite: function (cb) { return on('pv:toggle-favorite', cb); },
    onEditWeb: function (cb) { return on('pv:edit-web', cb); },
    onWebState: function () { return function () {}; },
    onPreviewPrefs: function (cb) { return on('pv:preview-prefs', cb); }
  };
})();
