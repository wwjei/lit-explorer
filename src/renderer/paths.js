/* 界面层的路径比较与展示
 *
 * 收藏、固定列、导航快照里存的是同一条路径的不同写法：反斜杠 / 斜杠混用、Windows
 * 上大小写不同、末尾多一个分隔符。这里统一成一套判断，别再各写一遍前缀比较。
 *
 * 主进程的 fs-api.js 有另一套路径校验：那边必须在真实路径（realpath）上判断，
 * 用来守工作区边界，和这里不是同一件事，也不要合并。
 *
 * 加载顺序：shared/contracts.js → paths.js → icons.js → highlight.js → markdown.js →
 *           pane.js → preview-body.js → webview.js →
 *           svgedit.js → find.js → projects.js → app.js。
 */
(function () {
  'use strict';

  const WIN = typeof pv !== 'undefined' && pv.platform === 'win32';

  /** 统一分隔符并去掉末尾分隔符（只比较用，不用于展示） */
  function norm(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
  }

  /** 用作 Map / Set 键或去重时的规范化形式 */
  function key(p) {
    const s = norm(p);
    return WIN ? s.toLowerCase() : s;
  }

  function same(a, b) {
    return key(a) === key(b);
  }

  function baseName(p) {
    const s = norm(p);
    return s.split('/').pop() || s;
  }

  function trim(p) {
    return String(p == null ? '' : p).replace(/[\\/]+$/, '');
  }

  /** abs 是否在 root 之内（按路径分段，不用裸前缀比较）；root 自身算在根内 */
  function within(root, abs) {
    // 比较时统一分隔符，展示与截取仍用原字符串
    const r = norm(root);
    if (!r) return false;
    const a = norm(abs);
    const kr = WIN ? r.toLowerCase() : r;
    const ka = WIN ? a.toLowerCase() : a;
    return ka === kr || ka.startsWith(kr + '/');
  }

  /** abs 相对 root 的各段名字；不在 root 内返回 null，root 自身返回空数组 */
  function partsUnder(root, abs) {
    if (!within(root, abs)) return null;
    const r = trim(root);
    const a = trim(abs);
    if (same(a, r)) return [];
    return a.slice(r.length + 1).split(/[\\/]+/).filter(Boolean);
  }

  /** root 下的相对路径（头部副标题用）：保留原分隔符；不在 root 内返回原路径 */
  function relUnder(root, abs) {
    if (!within(root, abs)) return trim(abs);
    const r = trim(root);
    const a = trim(abs);
    // within 成立时两者只可能在大小写上不同，长度一致，可以按长度截取
    return a.slice(r.length).replace(/^[\\/]+/, '');
  }

  /** 目录列表统一排序：目录在前，再按名字（中文 / 数字感知） */
  function compareNodes(a, b) {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true });
  }

  window.PV = window.PV || {};
  window.PV.paths = {
    norm: norm,
    key: key,
    same: same,
    baseName: baseName,
    within: within,
    partsUnder: partsUnder,
    relUnder: relUnder,
    compareNodes: compareNodes
  };
})();
