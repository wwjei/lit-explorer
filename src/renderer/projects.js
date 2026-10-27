/* 项目快捷切换：左栏底部的切换条 + 图标选择
 *
 * 一个项目 = { path, name, icon, nav }，最多 MAX 个，按添加顺序固定排列
 * （切换时不重排，图标不会在鼠标底下乱跳）。当前工作区由 app.js 通过
 * setActive() 告知；没打开的项目整组去色，只有当前项目保留图标颜色。
 *
 * 图标三种形态：
 *   - null：默认首字（英文首字母 / 中文第一个字 / 数字取前两位），颜色由名称哈希固定
 *   - { type:'glyph', id }：目录里的线条图标（颜色跟着图标走）
 *   - { type:'image', data }：用户选的图片，主进程已缩到 64px 的 data URL
 *
 * 持久化直接走 pv.setState({ projects })，写入由主进程防抖。
 *
 * 加载顺序：shared/contracts.js → paths.js → icons.js → highlight.js → markdown.js →
 *           pane.js → preview-body.js → webview.js → svgedit.js →
 *           find.js → projects.js → app.js
 */
(function () {
  'use strict';

  const MAX = PV.contracts.MAX_PROJECTS;

  /* ------------------------------------------------------------------ *
   * 图标目录：只表达项目类型，不放 pin / 文件夹 / 收藏 / 分支这类操作型图标。
   * 前 QUICK_COUNT 个进右键菜单的四排（8 × 4），其余进「更多」。
   * ------------------------------------------------------------------ */
  const CATALOG = [
    // 第一排：工程
    { id: 'code', label: '代码', color: '#7f91a8', path: '<path d="M9.5 8.5 5.5 12l4 3.5"/><path d="M14.5 8.5 18.5 12l-4 3.5"/>' },
    { id: 'browser', label: '页面', color: '#8a97b0', path: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17"/><path d="M6.6 6.8h.01"/>' },
    { id: 'server', label: '服务', color: '#8f8a9e', path: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>' },
    { id: 'database', label: '数据库', color: '#7f9a94', path: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>' },
    { id: 'cpu', label: '芯片', color: '#8ba59f', path: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3"/>' },
    { id: 'box', label: '包 / 库', color: '#bf9a6e', path: '<path d="M12 3.4 20 8v8l-8 4.6L4 16V8z"/><path d="M4 8l8 4.6L20 8"/><path d="M12 12.6V20.6"/>' },
    { id: 'flow', label: '流程', color: '#93a0b8', path: '<rect x="3.5" y="4" width="6" height="5" rx="1.5"/><rect x="14.5" y="15" width="6" height="5" rx="1.5"/><path d="M9.5 6.5h3a2 2 0 0 1 2 2v7a2 2 0 0 0 2 2"/>' },
    { id: 'route', label: '路由', color: '#8ba596', path: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h5a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h7"/>' },
    // 第二排：工程 + 文档
    { id: 'network', label: '节点 / 网络', color: '#8b9cb5', path: '<circle cx="12" cy="5" r="2.2"/><circle cx="5.5" cy="18" r="2.2"/><circle cx="18.5" cy="18" r="2.2"/><path d="M12 7.2v3.1M10.4 11.5 7 15.9M13.6 11.5 17 15.9"/>' },
    { id: 'blocks', label: '组件 / 积木', color: '#a48a6f', path: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="8.75" y="13.5" width="6.5" height="6.5" rx="1.5"/>' },
    { id: 'plug', label: '插件', color: '#96809a', path: '<path d="M9 3.5v5M15 3.5v5"/><path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v3.5"/>' },
    { id: 'container', label: '容器', color: '#8fa3a8', path: '<rect x="3.5" y="6.5" width="17" height="11" rx="1.5"/><path d="M8 6.5v11M12 6.5v11M16 6.5v11"/>' },
    { id: 'book', label: '文档', color: '#a48a6f', path: '<path d="M4.5 5.5A2 2 0 0 1 6.5 3.5H19v15H6.5a2 2 0 0 0-2 2z"/><path d="M4.5 5.5v15"/><path d="M8 7.5h7"/>' },
    { id: 'file', label: '文件', color: '#b09a86', path: '<path d="M13.5 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8.5z"/><path d="M13.5 3v5.5H19"/><path d="M8.5 12.5h7M8.5 16h4.5"/>' },
    { id: 'image', label: '图片', color: '#96809a', path: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5 9 13l3.5 3.5L16 14l4 4"/>' },
    { id: 'video', label: '视频', color: '#8f8a9e', path: '<rect x="3.5" y="6" width="12.5" height="12" rx="2.5"/><path d="m16 10.5 4.5-2.5v8L16 13.5z"/>' },
    // 第三排：设计 + 产品
    { id: 'palette', label: '调色板', color: '#96809a', path: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.6 0 2-1 1.4-2-.6-1.1.2-2.3 1.5-2.3H17a3.5 3.5 0 0 0 3.5-3.5c0-4.8-3.8-9.2-8.5-9.2z"/><circle cx="8" cy="10" r="1"/><circle cx="11" cy="7" r="1"/><circle cx="15" cy="8.5" r="1"/>' },
    { id: 'sparkles', label: '创意', color: '#bf9a6e', path: '<path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6z"/><path d="M18 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>' },
    { id: 'layout', label: '布局', color: '#7f91a8', path: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M9.5 4v16M3.5 10h17"/>' },
    { id: 'bulb', label: '原型 / 想法', color: '#c9a45c', path: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M8.2 14.5A6 6 0 1 1 15.8 14.5c-.8.7-1.3 1.6-1.3 2.5h-5c0-.9-.5-1.8-1.3-2.5z"/>' },
    { id: 'target', label: '目标', color: '#a8898a', path: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>' },
    { id: 'chart', label: '柱状图', color: '#7f9a94', path: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5" rx=".8"/><rect x="12" y="8" width="3" height="9" rx=".8"/><rect x="17" y="10" width="3" height="7" rx=".8"/>' },
    { id: 'pie', label: '饼图', color: '#8a97b0', path: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V12h8.5"/>' },
    { id: 'activity', label: '监控', color: '#8ba596', path: '<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>' },
    // 第四排：产品 + 场景
    { id: 'flask', label: '实验', color: '#8fa8a2', path: '<path d="M9 3.5h6"/><path d="M10 3.5v5L5.5 17a2.4 2.4 0 0 0 2.1 3.5h8.8a2.4 2.4 0 0 0 2.1-3.5L14 8.5v-5"/><path d="M7.5 14h9"/>' },
    { id: 'bot', label: '机器人', color: '#8f8a9e', path: '<rect x="5" y="8" width="14" height="10" rx="3"/><circle cx="9.5" cy="13" r="1"/><circle cx="14.5" cy="13" r="1"/><path d="M12 8V5.5"/><circle cx="12" cy="4.3" r="1.2"/><path d="M8 18v2M16 18v2"/>' },
    { id: 'cart', label: '购物', color: '#a48a6f', path: '<path d="M3 5h2.2l2 10.5h10.3L20 8H6.2"/><circle cx="9" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/>' },
    { id: 'map', label: '地图', color: '#7f9a8b', path: '<path d="M9 4.5 3.5 6v14L9 18.5l6-3 5.5 1.5V3L15 4.5z"/><path d="M9 4.5v14M15 4.5v14"/>' },
    { id: 'gamepad', label: '游戏', color: '#8f8a9e', path: '<path d="M7.5 8.5h9a4 4 0 0 1 3.9 4.9l-.7 3.3a2.7 2.7 0 0 1-4.6 1.3l-1.3-1.4h-5.6l-1.3 1.4a2.7 2.7 0 0 1-4.6-1.3l-.7-3.3a4 4 0 0 1 3.9-4.9z"/><path d="M8.5 11v3M7 12.5h3"/><circle cx="16" cy="11.5" r=".7"/><circle cx="17.5" cy="13.5" r=".7"/>' },
    { id: 'medal', label: '竞赛', color: '#c0a273', path: '<circle cx="12" cy="15" r="4.5"/><path d="M4 3.5h5l3 6M20 3.5h-5l-3 6"/><path d="m12 12.8.8 1.7 1.9.3-1.4 1.3.3 1.9-1.6-.9-1.6.9.3-1.9-1.4-1.3 1.9-.3z"/>' },
    { id: 'telescope', label: '探索', color: '#8a9bb0', path: '<path d="M4 10.5 17 4l2.5 5.5L6.5 16z"/><path d="m9 13.5-2 5"/><path d="M7 18.5h5"/>' },
    { id: 'shield', label: '安全', color: '#8b9cb5', path: '<path d="M12 3.5 19 6v6c0 4-3 7-7 8.5C8 19 5 16 5 12V6z"/>' },
    // 更多（这些只出现在「更多」里，不占外面四排）
    { id: 'notebook', label: '文档创作', color: '#b09a86', path: '<path d="M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-11"/><path d="M6.5 3.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5"/><path d="M5 7h3M5 11h3M5 15h3"/><path d="M10.5 8h5M10.5 12h5M10.5 16h3"/>' },
    { id: 'presentation', label: 'PPT 创作', color: '#8f8a9e', path: '<rect x="3.5" y="4.5" width="17" height="11" rx="2"/><path d="M12 15.5V20"/><path d="M8.5 20h7"/><path d="M7.5 12V9.5M10.5 12V7.5M13.5 12V10M16.5 12V8.5"/>' },
    { id: 'ebook', label: '电子书', color: '#7f91a8', path: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 3.5v17"/><path d="M12 8h4M12 11.5h4M12 15h2.5"/>' },
    { id: 'newspaper', label: '资讯 / 周刊', color: '#a8928a', path: '<path d="M4 5.5h13v13H5.5A1.5 1.5 0 0 1 4 17z"/><path d="M17 8h3v9a2 2 0 0 1-2 2h-1"/><path d="M7 8.5h7M7 11.5h7M7 14.5h4"/>' },
    { id: 'library', label: '文库 / 资料', color: '#a48a6f', path: '<path d="M4 4.5h4v15H4zM9.5 4.5h4v15h-4z"/><path d="m15.5 5 3.5-1 3.5 14.5-3.5 1z"/>' },
    { id: 'whiteboard', label: '白板 / 头脑风暴', color: '#8fa3a8', path: '<rect x="3.5" y="4.5" width="17" height="11" rx="1.5"/><path d="M12 15.5V20M8 20h8"/><path d="M7 12 9 8l3 3 2-2 2 3"/>' },
    { id: 'survey', label: '调研 / 问卷', color: '#8ba596', path: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 3.5h6v3H9z"/><path d="m8.5 11 1.2 1.2 2-2M8.5 16l1.2 1.2 2-2"/><path d="M14 11.5h3M14 16.5h3"/>' },
    { id: 'education', label: '教学 / 课程', color: '#bf9a6e', path: '<path d="M12 4 21 8l-9 4-9-4z"/><path d="M6 10v4.5c0 1.7 2.7 3 6 3s6-1.3 6-3V10"/><path d="M21 8v5"/>' },
    { id: 'hammer', label: '构建 / 施工', color: '#a48a6f', path: '<path d="M14 4.5 20 10.5 17.5 13 11.5 7z"/><path d="M12.5 8.5 4 17l3 3 8.5-8.5"/>' },
    { id: 'toolbox', label: '工具集', color: '#b0895f', path: '<rect x="3.5" y="8" width="17" height="11" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3.5 13h17"/><path d="M10 13v2h4v-2"/>' },
    { id: 'api', label: '接口 / API', color: '#7f9a94', path: '<path d="M8 4.5 4.5 12 8 19.5"/><path d="M16 4.5 19.5 12 16 19.5"/><circle cx="12" cy="12" r="1.4"/>' },
    { id: 'kanban', label: '看板 / 项目', color: '#8a97b0', path: '<rect x="3.5" y="4.5" width="5" height="15" rx="1.5"/><rect x="9.5" y="4.5" width="5" height="10" rx="1.5"/><rect x="15.5" y="4.5" width="5" height="6" rx="1.5"/>' },
    { id: 'gauge', label: '评级 / 评分', color: '#c0a273', path: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/><circle cx="12" cy="17" r="1.2"/><path d="M5.5 13h1.5M17 13h1.5M8 8.5l1 1"/>' },
    { id: 'finance', label: '财务 / 账本', color: '#8ba596', path: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10"/><path d="M9.5 9.2h4a2 2 0 0 1 0 4h-3a2 2 0 0 0 0 4h4"/>' },
    { id: 'microscope', label: '研究 / 分析', color: '#96809a', path: '<path d="M9 4.5h4v8H9z"/><path d="M11 12.5v3"/><path d="M7 20h10"/><path d="M6.5 15.5a5 5 0 0 0 9 0"/><path d="M13 7l2-2"/>' },
    { id: 'font', label: '字体 / 设计', color: '#8f8a9e', path: '<path d="M5 19 10.5 5h3L19 19"/><path d="M7 14.5h10"/><path d="M4 19h4M16 19h4"/>' },
    { id: 'drive', label: '存储', color: '#8a97b0', path: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M4 12.5h16"/><circle cx="8" cy="15.5" r=".9"/><path d="M16 15.5h2"/>' },
    { id: 'queue', label: '队列', color: '#a8928a', path: '<rect x="3.5" y="5" width="12" height="4" rx="2"/><rect x="3.5" y="15" width="12" height="4" rx="2"/><circle cx="19" cy="7" r="1.2"/><circle cx="19" cy="17" r="1.2"/>' },
    { id: 'log', label: '日志', color: '#9a94a8', path: '<path d="M4 6h10M4 10h7M4 14h10M4 18h6"/><circle cx="19" cy="6" r="1"/><circle cx="16" cy="10" r="1"/><circle cx="19" cy="14" r="1"/>' },
    { id: 'scroll', label: '方案 / 卷轴', color: '#c0a273', path: '<path d="M6 4.5h11a2 2 0 0 1 0 4H8.5"/><path d="M6 4.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5"/><path d="M8 12h8M8 15.5h5"/>' },
    { id: 'blueprint', label: '蓝图', color: '#8a9bb0', path: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17M9 9v10.5M15 9v10.5"/>' },
    { id: 'atom', label: '科学', color: '#96809a', path: '<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="8" ry="3.2"/><ellipse cx="12" cy="12" rx="8" ry="3.2" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="8" ry="3.2" transform="rotate(120 12 12)"/>' },
    { id: 'compass', label: '罗盘', color: '#7f91a8', path: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5z"/>' },
    { id: 'orbit', label: '轨道', color: '#96809a', path: '<circle cx="12" cy="12" r="2.5"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-25 12 12)"/><circle cx="19" cy="8" r="1.4"/>' }
  ];
  const QUICK_COUNT = 32;
  const GLYPH = {};
  for (const it of CATALOG) GLYPH[it.id] = it;

  const MONO_COLORS = ['#9a7f6b', '#7f91a8', '#7f9a8b', '#a48a6f', '#8a97b0', '#7f9a94', '#8f8a9e', '#96809a'];

  const esc = PV.highlight.escapeAttr;

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  let projects = [];
  let activePath = '';
  let ready = false;
  let dockEl = null;
  let saveTimer = null;
  let tipEl = null;
  let tipTimer = 0;
  let popEl = null;
  let popFor = null;
  let warnEl = null;
  let warnTimer = 0;
  /** 切换项目时旧下划线的屏幕中心：新列表画好后从这里滑到新项目 */
  let lineFrom = null;
  let lineFromTimer = 0;

  const hooks = {
    switchTo: function () {},
    openNew: function () {},
    toast: function () {}
  };

  const samePath = PV.paths.same;
  const baseName = PV.paths.baseName;
  function isActive(p) { return activePath ? samePath(p, activePath) : false; }
  function find(path) { return projects.find((p) => samePath(p.path, path)) || null; }
  function isFull() { return projects.length >= MAX; }

  /** 首字：英文取大写首字母、中文取第一个字、数字取前两位 */
  function initials(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const chars = Array.from(s);
    if (/[0-9]/.test(chars[0])) return chars.slice(0, 2).join('');
    return /[a-z]/i.test(chars[0]) ? chars[0].toUpperCase() : chars[0];
  }
  function hashColor(s) {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return MONO_COLORS[Math.abs(h) % MONO_COLORS.length];
  }

  function sanitizeIcon(icon) {
    if (!icon || typeof icon !== 'object') return null;
    if (icon.type === 'glyph' && GLYPH[icon.id]) return { type: 'glyph', id: icon.id };
    if (icon.type === 'image' && typeof icon.data === 'string' && /^data:image\//.test(icon.data)) {
      return { type: 'image', data: icon.data };
    }
    if (icon.type === 'text' && typeof icon.text === 'string') {
      const text = Array.from(icon.text.replace(/[\r\n\t]/g, ' ').trim()).slice(0, 2).join('').trim();
      return text ? { type: 'text', text: text } : null;
    }
    return null;
  }

  function iconHtml(p, size) {
    const icon = p.icon;
    if (icon && icon.type === 'image') {
      return '<img class="proj-img" src="' + esc(icon.data) + '" alt="" width="' + size + '" height="' + size + '">';
    }
    if (icon && icon.type === 'glyph') {
      const g = GLYPH[icon.id];
      return '<svg class="pj-glyph" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" '
        + 'stroke="' + g.color + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true">' + g.path + '</svg>';
    }
    if (icon && icon.type === 'text') {
      return '<span class="proj-mono proj-text' + (Array.from(icon.text).length > 1 ? ' is-two' : '')
        + '" style="color:' + hashColor(p.name) + '">' + esc(icon.text) + '</span>';
    }
    return '<span class="proj-mono" style="color:' + hashColor(p.name) + '">' + esc(initials(p.name)) + '</span>';
  }

  /* ------------------------------------------------------------------ *
   * 持久化
   * ------------------------------------------------------------------ */
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const p = pv.setState({
          projects: projects.map((p) => ({ path: p.path, name: p.name, icon: p.icon, nav: p.nav }))
        });
        // 持久化是尽力而为：写不进去（例如测试环境没有这个 IPC）不影响使用
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* 同上 */ }
    }, 250);
  }

  function load(list) {
    const seen = new Set();
    projects = (Array.isArray(list) ? list : [])
      .filter((p) => p && typeof p.path === 'string' && p.path)
      .map((p) => ({
        path: p.path,
        name: typeof p.name === 'string' && p.name ? p.name : baseName(p.path),
        icon: sanitizeIcon(p.icon),
        nav: p.nav && typeof p.nav === 'object' ? p.nav : null
      }))
      .filter((p) => {
        const k = PV.paths.key(p.path);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX);
    ready = true;
    render();
  }

  function setActive(root) {
    markActive(root);
    render();
  }

  /** 打开了一个工作区：已在列表里就更新名字；还有空位就追加；满了只记录为当前。 */
  function noteOpened(root) {
    if (!root) return { project: null, added: false, full: false };
    if (!ready) { markActive(root); return { project: null, added: false, full: false, pending: true }; }
    const existing = find(root);
    if (existing) {
      existing.name = baseName(root);
      markActive(root);
      render();
      return { project: existing, added: false, full: false };
    }
    if (isFull()) {
      markActive(root);
      render();
      return { project: null, added: false, full: true };
    }
    const p = { path: root, name: baseName(root), icon: null, nav: null };
    projects.push(p);
    markActive(root);
    persist();
    render();
    return { project: p, added: true, full: false };
  }

  function navOf(root) {
    const p = find(root);
    return p && p.nav ? p.nav : null;
  }

  function saveNav(root, nav) {
    const p = find(root);
    if (!p || !nav) return;
    p.nav = nav;
    persist();
  }

  /* ------------------------------------------------------------------ *
   * 切换条
   * ------------------------------------------------------------------ */

  /** 活跃项目下划线当前的屏幕中心；动画进行中时取当前帧，而不是目标位置 */
  function lineCenter() {
    if (!dockEl) return null;
    const tile = dockEl.querySelector('.proj-tile.is-on');
    if (!tile) return null;
    const r = tile.getBoundingClientRect();
    let x = r.left + r.width / 2;
    const tr = getComputedStyle(tile, '::after').transform;
    const m = tr && tr !== 'none' ? /^matrix\(([^)]+)\)$/.exec(tr) : null;
    if (m) {
      const tx = Number(m[1].split(',')[4]);
      if (Number.isFinite(tx)) x += tx;
    }
    return x;
  }

  /** 活跃项目要变了：先记住旧下划线在哪，新列表渲染后从那里滑过去 */
  function rememberLine() {
    if (!dockEl || !dockEl.isConnected) return;
    const x = lineCenter();
    if (x == null) return;
    lineFrom = x;
    clearTimeout(lineFromTimer);
    lineFromTimer = setTimeout(() => { lineFrom = null; }, 400);
  }

  function markActive(next) {
    const path = next || '';
    if (samePath(path, activePath)) return;
    rememberLine();
    activePath = path;
  }

  /** 新列表已经画好：让新活跃项目的那条线从旧位置滑到现在的位置 */
  function applyLineMove() {
    if (lineFrom == null || !dockEl || !dockEl.isConnected) return;
    const tile = dockEl.querySelector('.proj-tile.is-on');
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    const delta = Math.round(lineFrom - (r.left + r.width / 2));
    if (Math.abs(delta) < 1) return;
    tile.style.setProperty('--proj-line-from', delta + 'px');
    tile.classList.add('is-line-move');
    const done = () => {
      tile.classList.remove('is-line-move');
      tile.style.removeProperty('--proj-line-from');
    };
    tile.addEventListener('animationend', (e) => {
      if (e.pseudoElement && e.pseudoElement !== '::after') return;
      done();
    }, { once: true });
    // 系统关掉动画时不会有 animationend，兜底把类收掉
    setTimeout(done, 400);
  }

  function renderDock() {
    if (!dockEl) return;
    dockEl.innerHTML = projects.map((p) =>
      '<button type="button" class="proj-tile' + (isActive(p.path) ? ' is-on' : '') + '" '
      + 'data-path="' + esc(p.path) + '" aria-label="' + esc(p.name) + '" title="">'
      + '<span class="proj-ic">' + iconHtml(p, 16) + '</span></button>'
    ).join('') + '<button type="button" class="proj-add" aria-label="打开工作区" title="打开工作区">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button>';
    applyLineMove();
  }

  function render() {
    if (dockEl && dockEl.isConnected) renderDock();
  }

  function mount(el) {
    dockEl = el;
    // app.js 先把 dock 建好再挂进左栏；没进文档时读不到图标位置，
    // 等这一轮任务结束、DOM 接上之后再画，这样切项目时的下划线起点是准的
    if (el.isConnected) renderDock();
    else queueMicrotask(() => { if (dockEl === el && el.isConnected) renderDock(); });
    if (el.dataset.bound) return;
    el.dataset.bound = '1';

    el.addEventListener('click', (e) => {
      const add = e.target.closest('.proj-add');
      if (add) {
        if (isFull()) warnFull();
        else hooks.openNew();
        return;
      }
      const tile = e.target.closest('.proj-tile');
      if (!tile) return;
      hideTip();
      const p = find(tile.dataset.path);
      if (p && !isActive(p.path)) hooks.switchTo(p.path);
    });

    el.addEventListener('contextmenu', (e) => {
      // 项目切换条在根目录栏里面，事件会继续冒泡到 #cols 的「空目录」右键菜单；
      // 那里只有一项「重新扫描目录」，出现在项目图标菜单旁边既多余又容易误点。
      e.preventDefault();
      e.stopPropagation();
      const tile = e.target.closest('.proj-tile');
      if (!tile) return;
      hideTip();
      const p = find(tile.dataset.path);
      if (p) openPicker(tile, p);
    });

    el.addEventListener('mouseover', (e) => {
      const tile = e.target.closest('.proj-tile');
      if (!tile) return;
      if (tile.contains(e.relatedTarget)) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(tile), 260);
    });

    el.addEventListener('mouseout', (e) => {
      const tile = e.target.closest('.proj-tile');
      if (!tile) return;
      if (tile.contains(e.relatedTarget)) return;
      clearTimeout(tipTimer);
      hideTip();
    });
  }

  /* ------------------------------------------------------------------ *
   * 悬停提示：项目名 + 完整路径
   * ------------------------------------------------------------------ */
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) { tipEl.remove(); tipEl = null; }
  }

  function showTip(tile) {
    hideTip();
    const p = find(tile.dataset.path);
    if (!p) return;
    tipEl = document.createElement('div');
    tipEl.className = 'proj-tip';
    tipEl.innerHTML = '<b>' + esc(p.name) + '</b><code>'
      + esc(p.path).replace(/\\/g, '\\<wbr>') + '</code>';
    document.body.appendChild(tipEl);
    const tr = tile.getBoundingClientRect();
    const r = tipEl.getBoundingClientRect();
    let left = tr.left + tr.width / 2 - r.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - r.width - 8, left));
    tipEl.style.left = left + 'px';
    tipEl.style.top = (tr.top - r.height - 9) + 'px';
    tipEl.style.setProperty('--arrow', (tr.left + tr.width / 2 - left) + 'px');
  }

  /* ------------------------------------------------------------------ *
   * 满了的提示
   * ------------------------------------------------------------------ */
  function hideWarn() {
    clearTimeout(warnTimer);
    if (warnEl) { warnEl.remove(); warnEl = null; }
  }

  function warnFull() {
    hideWarn();
    warnEl = document.createElement('div');
    warnEl.className = 'proj-warn';
    warnEl.setAttribute('role', 'status');
    warnEl.innerHTML = '<b>最多保留 ' + MAX + ' 个项目</b><span>先移除一个，再添加新的。</span>';
    document.body.appendChild(warnEl);
    if (dockEl && dockEl.isConnected) {
      const r = dockEl.getBoundingClientRect();
      warnEl.style.left = Math.round(r.left + 10) + 'px';
      warnEl.style.bottom = Math.round(window.innerHeight - r.top + 8) + 'px';
    }
    warnTimer = setTimeout(hideWarn, 2800);
  }

  /* ------------------------------------------------------------------ *
   * 图标选择
   * ------------------------------------------------------------------ */
  function cellHtml(entry, current) {
    const on = current && current.type === 'glyph' && current.id === entry.id;
    return '<button type="button" class="pj-cell' + (on ? ' is-on' : '') + '" data-glyph="' + entry.id + '" '
      + 'data-key="' + esc(entry.id + ' ' + entry.label) + '" title="' + esc(entry.label) + '">'
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + entry.color + '" '
      + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + entry.path + '</svg></button>';
  }

  function headHtml(p) {
    return '<div class="pj-pop-h">' + '<span class="pj-head-ic">' + iconHtml(p, 16) + '</span>'
      + '<div class="pj-meta"><b>' + esc(p.name) + '</b><span>' + esc(p.path) + '</span></div></div>';
  }

  function quickHtml(p) {
    return headHtml(p)
      + '<div class="pj-label">设置图标</div>'
      + '<div class="pj-grid">' + CATALOG.slice(0, QUICK_COUNT).map((g) => cellHtml(g, p.icon)).join('') + '</div>'
      + '<button type="button" class="pj-more">更多…'
      + '<svg class="pj-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M9.5 6.5 15 12l-5.5 5.5"/></svg></button>'
      + '<div class="pj-text"><span class="pj-label">文字</span>'
      + '<input class="pj-text-in" type="text" maxlength="2" placeholder="最多 2 个字符" '
      + 'aria-label="文字图标，最多两个字符" autocomplete="off" spellcheck="false" value="'
      + esc(p.icon && p.icon.type === 'text' ? p.icon.text : '') + '">'
      + '<button type="button" class="pj-text-ok" data-act="text">应用</button></div>'
      + '<div class="pj-sep"></div>'
      + '<button type="button" class="pj-item" data-act="reveal">' + PV.icons.icon('reveal', '', 14)
      + '在资源管理器中显示</button>'
      + '<button type="button" class="pj-item is-danger" data-act="remove">'
      + '<svg class="pj-ic2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M4 6.5h16"/><path d="M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"/>'
      + '<path d="M6.5 6.5 7.3 19a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12.5"/></svg>'
      + '从快捷栏移除</button>';
  }

  function moreHtml(p) {
    return '<div class="pj-pop-h"><button type="button" class="pj-back" data-act="back" aria-label="返回">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6.5 9 12l5.5 5.5"/></svg>'
      + '</button><span class="pj-title">更多图标</span></div>'
      + '<div class="pj-search">' + PV.icons.icon('search', '', 13)
      + '<input class="pj-search-in" type="text" placeholder="筛选…" autocomplete="off" spellcheck="false"></div>'
      + '<div class="pj-grid is-big">' + CATALOG.slice(QUICK_COUNT).map((g) => cellHtml(g, p.icon)).join('') + '</div>'
      + '<div class="pj-two"><button type="button" data-act="image">' + PV.icons.icon('image', '', 13)
      + '选择图片…</button><button type="button" data-act="reset">Aa 恢复默认</button></div>';
  }

  function placePop(tile) {
    if (!popEl) return;
    const pr = popEl.getBoundingClientRect();
    const dr = dockEl ? dockEl.getBoundingClientRect() : { top: window.innerHeight };
    const tr = tile.getBoundingClientRect();
    popEl.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - pr.width - 8, tr.left - 6))) + 'px';
    popEl.style.bottom = Math.round(Math.max(8, window.innerHeight - dr.top + 8)) + 'px';
  }

  function closePicker() {
    const had = !!popEl;
    if (popEl) { popEl.remove(); popEl = null; popFor = null; }
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', closePicker);
    window.removeEventListener('scroll', closePicker, true);
    // 网页视图是原生子视图，会盖住这个浮层；关掉后让它们回来
    if (had && window.PV && PV.web) PV.web.setOccluded(false);
  }

  function onDocPointer(e) {
    if (!popEl) return;
    if (popEl.contains(e.target) || e.target.closest('.proj-tile')) return;
    closePicker();
  }
  function onDocKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePicker();
      hideTip();
    }
  }

  function openPicker(tile, p) {
    closePicker();
    hideTip();
    hideWarn();
    popFor = p;
    popEl = document.createElement('div');
    popEl.className = 'pj-pop';
    popEl.innerHTML = quickHtml(p);
    document.body.appendChild(popEl);
    placePop(tile);
    bindPicker(tile);
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', closePicker);
    window.addEventListener('scroll', closePicker, true);
    // 网页视图会盖住这个浮层，先藏起来；关闭时恢复
    if (window.PV && PV.web) PV.web.setOccluded(true);
  }

  function setIcon(p, icon) {
    p.icon = sanitizeIcon(icon);
    persist();
    render();
    closePicker();
  }

  function removeProject(p) {
    const i = projects.findIndex((x) => x === p);
    if (i < 0) return;
    projects.splice(i, 1);
    persist();
    render();
    closePicker();
    hooks.toast('已从快捷栏移除：' + p.name);
  }

  function bindPicker(tile) {
    popEl.addEventListener('click', (e) => {
      const cell = e.target.closest('.pj-cell');
      if (cell) {
        setIcon(popFor, { type: 'glyph', id: cell.dataset.glyph });
        return;
      }
      const more = e.target.closest('.pj-more');
      if (more) {
        popEl.classList.add('is-wide');
        popEl.innerHTML = moreHtml(popFor);
        placePop(tile);
        const input = popEl.querySelector('.pj-search-in');
        if (input) input.focus();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const a = act.dataset.act;
      if (a === 'back') {
        popEl.classList.remove('is-wide');
        popEl.innerHTML = quickHtml(popFor);
        placePop(tile);
      } else if (a === 'reveal') {
        pv.reveal(popFor.path);
        closePicker();
      } else if (a === 'remove') {
        removeProject(popFor);
      } else if (a === 'reset') {
        setIcon(popFor, null);
      } else if (a === 'image') {
        pickImage();
      } else if (a === 'text') {
        applyTextIcon();
      }
    });

    popEl.addEventListener('input', (e) => {
      if (!e.target.classList.contains('pj-search-in')) return;
      const q = e.target.value.trim().toLowerCase();
      popEl.querySelectorAll('.pj-cell').forEach((cell) => {
        cell.hidden = !!q && cell.dataset.key.toLowerCase().indexOf(q) < 0;
      });
    });

    popEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.classList.contains('pj-text-in')) return;
      e.preventDefault();
      e.stopPropagation();
      applyTextIcon();
    });
  }

  /** 用 1–2 个字符做项目图标；输入里的空白会去掉 */
  function applyTextIcon() {
    if (!popEl) return;
    const input = popEl.querySelector('.pj-text-in');
    if (!input) return;
    const text = Array.from(input.value.replace(/[\r\n\t]/g, ' ').trim()).slice(0, 2).join('').trim();
    if (!text) {
      hooks.toast('请输入 1–2 个字符');
      input.focus();
      return;
    }
    input.value = text;
    setIcon(popFor, { type: 'text', text: text });
  }

  async function pickImage() {
    const res = await pv.pickProjectIcon();
    if (!res || res.canceled) return;
    if (res.error) { hooks.toast('无法读取这张图片'); return; }
    if (res.dataUrl) setIcon(popFor, { type: 'image', data: res.dataUrl });
  }

  /* ------------------------------------------------------------------ *
   * 对外
   * ------------------------------------------------------------------ */
  window.PV = window.PV || {};
  window.PV.projects = {
    MAX: MAX,
    init: (h) => Object.assign(hooks, h || {}),
    load: load,
    setActive: setActive,
    noteOpened: noteOpened,
    isFull: isFull,
    navOf: navOf,
    saveNav: saveNav,
    mount: mount,
    render: render,
    warnFull: warnFull,
    list: () => projects.slice(),
    samePath: samePath
  };
})();
