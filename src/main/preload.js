'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程只能通过这里暴露的白名单方法访问系统能力。
 * 没有暴露任何写入、删除、执行任意命令的接口。
 */
contextBridge.exposeInMainWorld('pv', {
  platform: process.platform,

  /* 工作区 */
  pickFolder: () => ipcRenderer.invoke('workspace:pick'),
  openRoot: (dir) => ipcRenderer.invoke('workspace:open', dir),
  getSampleRoot: () => ipcRenderer.invoke('workspace:sample'),

  /* 文件系统（只读） */
  list: (dir) => ipcRenderer.invoke('fs:list', dir),
  read: (filePath) => ipcRenderer.invoke('fs:read', filePath),
  stat: (target) => ipcRenderer.invoke('fs:stat', target),
  previewUrl: (filePath) => ipcRenderer.invoke('fs:preview-url', filePath),

  /* 系统集成 */
  openPath: (filePath) => ipcRenderer.invoke('shell:open', filePath),
  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),
  openContextMenu: (payload) => ipcRenderer.invoke('ui:context-menu', payload),
  openAppMenu: () => ipcRenderer.invoke('ui:app-menu'),

  /* 自绘标题栏的窗口控制 */
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, value) => cb(value)),

  /* 设置 */
  getState: () => ipcRenderer.invoke('app:get-state'),
  setState: (changes) => ipcRenderer.invoke('app:set-state', changes),

  /* 主进程事件 */
  onMeta: (cb) => ipcRenderer.on('fs:meta', (_e, payload) => cb(payload)),
  onOpenRoot: (cb) => ipcRenderer.on('workspace:opened', (_e, dir) => cb(dir)),
  onNoWorkspace: (cb) => ipcRenderer.on('app:no-workspace', () => cb()),
  onTheme: (cb) => ipcRenderer.on('app:theme', (_e, theme) => cb(theme)),
  onTogglePreview: (cb) => ipcRenderer.on('app:toggle-preview', () => cb()),
  onRescan: (cb) => ipcRenderer.on('app:rescan', () => cb()),
  onFocusSearch: (cb) => ipcRenderer.on('app:focus-search', () => cb())
});
