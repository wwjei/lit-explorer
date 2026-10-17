'use strict';

/**
 * 轻量设置持久化：写入 userData/state.json，无需额外依赖。
 * 只保存界面偏好（主题、面板宽度、窗口位置、上次工作区）。
 */

const { app } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = {
  theme: 'light',
  previewOpen: true,
  previewWidth: 0,
  lastRoot: '',
  window: null,
  recentRoots: []
};

let cache = null;
let writeTimer = null;

function file() {
  return path.join(app.getPath('userData'), 'state.json');
}

async function load() {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(file(), 'utf8');
    cache = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch {
    cache = Object.assign({}, DEFAULTS);
  }
  return cache;
}

function flush() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(path.dirname(file()), { recursive: true });
      await fsp.writeFile(file(), JSON.stringify(cache, null, 2), 'utf8');
    } catch {
      /* 设置写入失败不影响使用 */
    }
  }, 250);
}

async function patch(changes) {
  const state = await load();
  Object.assign(state, changes);
  flush();
  return state;
}

module.exports = { load, patch, DEFAULTS };
