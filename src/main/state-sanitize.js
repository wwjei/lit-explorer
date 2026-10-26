'use strict';

/**
 * 渲染进程提交的设置：只接受已知字段，并逐项收敛。
 *
 * 页面里的脚本一旦拿到 pv 桥接权限，就能调 app:set-state。这里不能直接把
 * changes 丢给 store.patch：
 *   - store 里混着主进程自己的字段（window / lastRoot / recentRoots），
 *     其中 window 会在下次启动时当 BrowserWindow 参数用，能改掉 sandbox /
 *     contextIsolation / nodeIntegration；
 *   - projects[].path 会在下次启动时被 offerRoot，等于凭空扩大可打开目录。
 * 所以窗口参数只收几何字段、项目路径必须是主进程给过的目录，其余字段逐个校验。
 */

const webUrl = require('./web-url');

const MAX_PROJECTS = 5;
const MAX_ICON_CHARS = 512 * 1024;
const MAX_NAV_LEVELS = 16;
const MAX_PATH_CHARS = 4096;
const MAX_FAV_KEYS = 200;
const MAX_FAV_ITEMS = 500;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function shortText(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 主进程调 createWindow 时只取这四个字段，绝不把整份 state.window 摊进去 */
function windowBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const width = isFiniteNumber(value.width) ? Math.round(value.width) : 0;
  const height = isFiniteNumber(value.height) ? Math.round(value.height) : 0;
  if (width < 200 || height < 200) return null;
  const out = {
    width: Math.min(width, 10000),
    height: Math.min(height, 10000)
  };
  // 多显示器下 x / y 可以是负数
  if (isFiniteNumber(value.x)) out.x = Math.min(100000, Math.max(-100000, Math.round(value.x)));
  if (isFiniteNumber(value.y)) out.y = Math.min(100000, Math.max(-100000, Math.round(value.y)));
  return out;
}

/** 图标只认内置 glyph id、1–2 个字符的文字，或主进程生成过的图片 data URL */
function sanitizeIcon(icon) {
  if (!icon || typeof icon !== 'object') return null;
  if (icon.type === 'glyph') {
    const id = shortText(icon.id, 40);
    return /^[a-z0-9-]+$/i.test(id) ? { type: 'glyph', id: id } : null;
  }
  if (icon.type === 'image') {
    const data = typeof icon.data === 'string' ? icon.data : '';
    if (data.length > MAX_ICON_CHARS) return null;
    return /^data:image\/(?:png|jpeg|webp|gif|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/.test(data)
      ? { type: 'image', data: data }
      : null;
  }
  if (icon.type === 'text') {
    const raw = shortText(icon.text, 32).replace(/[\r\n\t]/g, ' ').trim();
    const text = Array.from(raw).slice(0, 2).join('').trim();
    return text ? { type: 'text', text: text } : null;
  }
  return null;
}

/** 项目上次的浏览位置：只用于重开时导航，越权路径由 fs-api 再挡一次 */
function sanitizeNav(nav) {
  if (!nav || typeof nav !== 'object') return null;
  const dirs = Array.isArray(nav.path)
    ? nav.path.filter((p) => typeof p === 'string' && p.length <= MAX_PATH_CHARS)
      .slice(0, MAX_NAV_LEVELS)
    : [];
  const sel = typeof nav.sel === 'string' && nav.sel.length <= MAX_PATH_CHARS ? nav.sel : null;
  return { path: dirs, sel: sel, mode: nav.mode === 'source' ? 'source' : 'preview' };
}

function sanitizeProjects(value, isOfferedRoot) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (out.length >= MAX_PROJECTS) break;
    if (!raw || typeof raw !== 'object') continue;
    const p = typeof raw.path === 'string' ? raw.path : '';
    // 关键限制：只有主进程给过渲染进程的目录，才允许留在项目快捷栏里。
    // 否则注入一段脚本就能把 C:\ 之类的路径写进设置，下次启动被 offerRoot。
    if (!p || p.length > MAX_PATH_CHARS || !isOfferedRoot(p)) continue;
    const name = shortText(raw.name, 120) || p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
    out.push({ path: p, name: name, icon: sanitizeIcon(raw.icon), nav: sanitizeNav(raw.nav) });
  }
  return out;
}

/** 快速访问：结构固定、长度有上限；路径不是授权依据（打开时仍按当前工作区校验） */
function sanitizeFavorites(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  const keys = Object.keys(value).slice(0, MAX_FAV_KEYS);
  for (const key of keys) {
    const list = value[key];
    if (typeof key !== 'string' || key.length > MAX_PATH_CHARS || !Array.isArray(list)) continue;
    const seenWeb = new Set();
    out[key] = list.slice(0, MAX_FAV_ITEMS).map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const kind = shortText(raw.kind, 24) || 'txt';
      if (kind === 'web') {
        // 网页条目只认 http(s)，且不写 path：任何按路径分派的代码都不会误用它
        const url = webUrl.normalizeWebUrl(raw.url);
        if (!url || seenWeb.has(url)) return null;
        seenWeb.add(url);
        return {
          url: url,
          name: shortText(raw.name, 120) || webUrl.webHost(url) || url,
          isDir: false,
          kind: 'web'
        };
      }
      const p = typeof raw.path === 'string' ? raw.path.slice(0, MAX_PATH_CHARS) : '';
      if (!p) return null;
      return {
        path: p,
        name: shortText(raw.name, 255) || p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p,
        isDir: !!raw.isDir,
        kind: kind
      };
    }).filter(Boolean);
  }
  return out;
}

/**
 * 把渲染进程提交的补丁收敛成可写入 store 的字段。
 * 刻意不支持 window / lastRoot / recentRoots：这三项只由主进程维护。
 */
function sanitizePatch(changes, isOfferedRoot) {
  const out = {};
  if (!changes || typeof changes !== 'object') return out;

  if (changes.theme === 'light' || changes.theme === 'dark') out.theme = changes.theme;
  for (const key of ['previewOpen', 'hideDot', 'favTop', 'previewDocx', 'previewPptx']) {
    if (typeof changes[key] === 'boolean') out[key] = changes[key];
  }
  if (isFiniteNumber(changes.previewWidth)) {
    out.previewWidth = Math.min(10000, Math.max(0, Math.round(changes.previewWidth)));
  }
  if (isFiniteNumber(changes.leftSplitRatio)) {
    out.leftSplitRatio = Math.min(0.92, Math.max(0.08, changes.leftSplitRatio));
  }
  if (Array.isArray(changes.projects)) {
    out.projects = sanitizeProjects(changes.projects, isOfferedRoot);
  }
  if (changes.favorites && typeof changes.favorites === 'object') {
    out.favorites = sanitizeFavorites(changes.favorites);
  }
  return out;
}

module.exports = {
  windowBounds,
  sanitizePatch,
  sanitizeProjects,
  sanitizeIcon,
  sanitizeFavorites,
  sanitizeNav,
  MAX_PROJECTS
};
