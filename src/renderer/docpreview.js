/**
 * docx / pptx 内嵌预览：纯前端解析（docx-preview、pptx-preview）。
 *
 * 这个文件带裸模块名 import，必须由 scripts/build-renderer.mjs 用 esbuild
 * 打成 IIFE（src/renderer/vendor/docpreview.js）后，浏览器才能直接加载。
 * 产物只挂在 window.PV.docpreview 上，不碰宿主界面。
 */
import { renderAsync } from 'docx-preview';
import { init as initPptx } from 'pptx-preview';
import JSZip from 'jszip';

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
 * 摘掉 [Content_Types].xml 里指向「包里并不存在的部件」的 Override。
 *
 * 这类文件是真实存在的：转换工具/脚本导出的 pptx 常留下陈旧的部件声明（实测一份
 * 29 页的稿子声明了 29 个 slideMaster，包里只有 1 个）。PowerPoint 按关系图找部件，
 * 照样能打开；pptx-preview 却是按 [Content_Types].xml 逐个部件去 zip 里取，取到缺失
 * 部件就抛异常，而它把这段逻辑整个包在 try/catch 里静默吞掉——表现就是「一张幻灯片
 * 都解析不出来」。这里先把不可用的声明去掉再交给它。
 *
 * 部件齐全的文件原样返回，不做多余的重新打包。
 */
async function dropStaleOverrides(data) {
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return { data: data, dropped: 0 };   // 不是能读的 zip，交给解析器自己报错
  }
  const ct = zip.file('[Content_Types].xml');
  if (!ct) return { data: data, dropped: 0 };
  const xml = await ct.async('text');
  let dropped = 0;
  const kept = xml.replace(/<Override\b[^>]*\/>/g, (tag) => {
    const m = /PartName="([^"]+)"/.exec(tag);
    if (!m) return tag;
    if (zip.file(m[1].replace(/^\//, ''))) return tag;
    dropped++;
    return '';
  });
  if (!dropped) return { data: data, dropped: 0 };
  zip.file('[Content_Types].xml', kept);
  return { data: await zip.generateAsync({ type: 'arraybuffer' }), dropped: dropped };
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

  const fixed = await dropStaleOverrides(data);
  if (fixed.dropped) {
    // 预览的是整理过的副本，这件事得让用户知道；放在滚动容器外面，不跟着幻灯片滚走
    const note = document.createElement('div');
    note.className = 'notice';
    note.textContent = '这个 PPTX 的部件声明里有 ' + fixed.dropped
      + ' 处指向不存在的部件，已按包里实际的内容整理后预览';
    const parent = container.parentNode;
    if (parent) parent.insertBefore(note, container);
    else container.appendChild(note);
  }

  const width = Math.max(360, container.clientWidth - 36);
  const previewer = initPptx(host, { width, mode: 'list' });
  await previewer.preview(fixed.data);
  // pptx-preview 解析失败时会静默返回 0 张幻灯片，这里主动暴露出来走兜底卡片
  if (!host.querySelector('.pptx-preview-slide-wrapper')) {
    throw new Error('未能解析出幻灯片，可能是不支持的 PPTX 结构');
  }
  return previewer;
}

window.PV = window.PV || {};
window.PV.docpreview = { renderDocx, renderPptx };
