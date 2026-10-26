/* 图标与文件类型映射 */
(function () {
  'use strict';

  const ICONS = {
    folder: '<path d="M3 7.4A2.4 2.4 0 0 1 5.4 5h3.3c.5 0 1 .2 1.4.6l1 1.2h7.5A2.4 2.4 0 0 1 21 9.2v8.4A2.4 2.4 0 0 1 18.6 20H5.4A2.4 2.4 0 0 1 3 17.6z"/>',
    file: '<path d="M13.5 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8.5z"/><path d="M13.5 3v5.5H19"/>',
    code: '<path d="M9.5 8.5 5.5 12l4 3.5"/><path d="M14.5 8.5 18.5 12l-4 3.5"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5 9 13l3.5 3.5L16 14l4 4"/>',
    slide: '<rect x="3.5" y="4.5" width="17" height="11" rx="2"/><path d="M12 15.5V19"/><path d="M8.5 19h7"/>',
    box: '<path d="M12 3.4 20 8v8l-8 4.6L4 16V8z"/><path d="M4 8l8 4.6L20 8"/><path d="M12 12.6V20.6"/>',
    hash: '<path d="M9.5 4 7.5 20"/><path d="M16.5 4l-2 16"/><path d="M5 9.5h14"/><path d="M4 14.5h14"/>',
    chevron: '<path d="M9.5 6.5 15 12l-5.5 5.5"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.5 4v4.5H16"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M19 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.5"/>',
    close: '<path d="M6.5 6.5 17.5 17.5"/><path d="M17.5 6.5 6.5 17.5"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    home: '<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5"/>',
    zap: '<path d="M13.2 2.6 4.8 13h5.4l-1.4 8.4L17.2 11h-5.4z"/>',
    zapFilled: '<path d="M13.2 2.6 4.8 13h5.4l-1.4 8.4L17.2 11h-5.4z" fill="currentColor" stroke="none"/>',
    pin: '<path d="M9.3 4.3h5.4l-.8 5.1 2.9 2.9H7.2l2.9-2.9z"/><path d="M12 12.3V20.4"/>',
    pinFilled: '<path d="M9.3 4.3h5.4l-.8 5.1 2.9 2.9H7.2l2.9-2.9z" fill="currentColor" stroke="none"/><path d="M12 12.3V20.4"/>',
    toTop: '<path d="M4.6 3.8h14.8"/><path d="M12 20V8.4"/><path d="M6.6 13.8 12 8.4l5.4 5.4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    arrowUp: '<path d="M12 19.2V5.4"/><path d="M6.4 11 12 5.4 17.6 11"/>',
    arrowDown: '<path d="M12 4.8v13.8"/><path d="M6.4 13 12 18.6 17.6 13"/>',
    zoomIn: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4 20 20"/><path d="M10.6 8.2v4.8"/><path d="M8.2 10.6h4.8"/>',
    zoomOut: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4 20 20"/><path d="M8.2 10.6h4.8"/>',
    pencil: '<path d="M4 20h4.2L20 8.2 15.8 4 4 15.8z"/><path d="M13.6 6.2 17.8 10.4"/>',
    eye: '<path d="M2.6 12S6.1 5.8 12 5.8 21.4 12 21.4 12 17.9 18.2 12 18.2 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M4 4.2 20 20"/><path d="M9.9 5.2A9.9 9.9 0 0 1 12 5c5.9 0 9.4 7 9.4 7a18 18 0 0 1-2.5 3.6"/><path d="M6.2 7.2A18 18 0 0 0 2.6 12S6.1 19 12 19a9.7 9.7 0 0 0 3.6-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.4 3.5 5.3 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.3-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    reveal: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3l1.6 2h8.4A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="13" r="2.5"/>'
  };

  const KIND_ICON = {
    md: ['file', 'c-md'],
    html: ['code', 'c-html'],
    docx: ['file', 'c-doc'],
    pptx: ['slide', 'c-ppt'],
    pdf: ['file', 'c-pdf'],
    js: ['code', 'c-js'],
    json: ['box', 'c-json'],
    css: ['hash', 'c-css'],
    svg: ['image', 'c-img'],
    image: ['image', 'c-img'],
    txt: ['file', 'c-txt'],
    binary: ['box', 'c-bin'],
    folder: ['folder', 'c-folder'],
    web: ['globe', 'c-web']
  };

  function icon(name, cls, size) {
    const s = size || 16;
    return '<svg class="ic ' + (cls || '') + '" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" '
      + 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" '
      + 'aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function nodeIcon(node, size) {
    const kind = node.isDir ? 'folder' : node.kind;
    const pair = KIND_ICON[kind] || KIND_ICON.txt;
    return icon(pair[0], pair[1], size);
  }

  window.PV = window.PV || {};
  window.PV.icons = { ICONS: ICONS, icon: icon, nodeIcon: nodeIcon };
})();
