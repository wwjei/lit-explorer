/**
 * docx / pptx 内嵌预览：纯前端解析（docx-preview、pptx-preview）。
 *
 * 这个文件带裸模块名 import，必须由 scripts/build-renderer.mjs 用 esbuild
 * 打成 IIFE（src/renderer/vendor/docpreview.js）后，浏览器才能直接加载。
 * 产物只挂在 window.PV.docpreview 上，不碰宿主界面。
 */
import { renderAsync } from 'docx-preview';
import { init as initPptx } from 'pptx-preview';

/** Word：渲染为近似版式的分页 DOM（样式由 docx-preview 注入到容器内） */
async function renderDocx(data, container) {
  const host = document.createElement('div');
  host.className = 'docview-docx';
  container.appendChild(host);
  await renderAsync(data, host, host, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    useBase64URL: true,
    experimental: true
  });
  if (!host.querySelector('.docx-wrapper, section.docx')) {
    throw new Error('未能解析出文档内容');
  }
}

/**
 * PowerPoint：逐页渲染成 DOM。
 * 不传 height，让 wrapper 随内容撑高、由外层 .docview 统一滚动
 * （传 height 时库会给 wrapper 加 overflow，出现内外两层滚动条）。
 */
async function renderPptx(data, container) {
  const host = document.createElement('div');
  host.className = 'docview-pptx';
  container.appendChild(host);
  const width = Math.max(360, container.clientWidth - 36);
  const previewer = initPptx(host, { width, mode: 'list' });
  await previewer.preview(data);
  // pptx-preview 解析失败时会静默返回 0 张幻灯片，这里主动暴露出来走兜底卡片
  if (!host.querySelector('.pptx-preview-slide-wrapper')) {
    throw new Error('未能解析出幻灯片，可能是不支持的 PPTX 结构');
  }
  return previewer;
}

window.PV = window.PV || {};
window.PV.docpreview = { renderDocx, renderPptx };
