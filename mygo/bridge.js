/*
 * 原生宿主的 window.pv 适配层，实现 src/shared/contracts.js 中的界面契约。
 * 调用在 window.mygo 注入之后才发生；加载时只保存函数，不解析原生桥。
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
    capabilities: { webPane: true },

    /* 工作区 */
    pickFolder: function () { return call('App.PickFolder'); },
    openRoot: function (dir) { return call('App.OpenRoot', dir); },
    getSampleRoot: function () { return call('App.GetSampleRoot'); },

    /* 项目快捷切换 */
    pickProjectIcon: function () { return call('App.PickProjectIcon'); },

    /* 文件系统 */
    list: function (dir, requestId) { return call('App.List', dir, requestId || 0); },
    directoryCall: function (method, args) { return call('App.DirectoryCall', method, args || {}); },
    referenceDirs: function () { return call('App.ReferenceDirs'); },
    addReferenceDir: function () { return call('App.AddReferenceDir'); },
    removeReferenceDir: function (dir) { return call('App.RemoveReferenceDir', dir); },
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

    /* 内嵌网页：fork 出来的子 webview（见 mygo/childwebview.go） */
    webSync: function (list) { return call('App.WebSync', list || []); },
    webReload: function (url) { return call('App.WebReload', url); },
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
    onWebState: function (cb) { return on('pv:web-state', cb); },
    onPreviewPrefs: function (cb) { return on('pv:preview-prefs', cb); }
  };
})();
