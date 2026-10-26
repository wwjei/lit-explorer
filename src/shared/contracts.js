'use strict';

/**
 * 主进程与渲染进程必须一致的数量上限与类型白名单。
 *
 * 只收「两边都读、且不一致就会静默降级」的值：数量上限决定界面允许保存什么，
 * 类型名单决定保存下来的固定列还能不能恢复成原来的预览。单侧专用的常量留在
 * 各自模块里，不要往这里堆。
 *
 * 两个进程都能加载：
 *   - 主进程 `require('../shared/contracts')`
 *   - 渲染进程由 index.html 先 `<script src="../shared/contracts.js">` 加载，
 *     挂到 `window.PV.contracts`（它比其它渲染脚本先执行）
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PV = root.PV || {};
    root.PV.contracts = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return Object.freeze({
    /** 最多固定几列预览 */
    MAX_PINS: 3,
    /** 每列最多几个上下分屏的窗格 */
    MAX_PANES_PER_COL: 2,
    /** 项目切换条最多保留几个项目 */
    MAX_PROJECTS: 5,
    /** 每个工作区最多多少条快速访问 */
    MAX_FAV_ITEMS: 500,
    /** 网页地址的最大字符数 */
    MAX_URL_CHARS: 2048,
    /** 一次 Markdown 预览最多向主进程解析多少张本地图片 */
    MAX_MD_IMAGES: 100,
    /** 允许从设置恢复的预览类型；web 按 URL 单独校验 */
    PINNED_KINDS: Object.freeze(['html', 'md', 'docx', 'pptx', 'pdf', 'js', 'json',
      'css', 'svg', 'image', 'txt'])
  });
});
