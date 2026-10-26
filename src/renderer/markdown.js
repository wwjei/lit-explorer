/* Markdown 渲染：标题/段落/列表(含嵌套)/引用/分割线/表格/代码块/行内样式/图片 */
(function () {
  'use strict';

  const esc = PV.highlight.escapeHtml;
  const escAttr = PV.highlight.escapeAttr;

  /** 有协议头吗？单字母是 Windows 盘符（C:\...），不算协议 */
  function hasScheme(u) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
    return !!m && m[1].length > 1;
  }

  /** 链接协议白名单：相对地址与锚点放行，有协议头的只认 http(s) / mailto */
  function safeHref(url) {
    const u = String(url).trim();
    // 浏览器解析地址时会忽略制表符 / 换行；带控制字符的一律不给链接
    if (/[\u0000-\u001f\u007f]/.test(u)) return false;
    if (!hasScheme(u)) return true;
    return /^(https?|mailto):/i.test(u);
  }

  /**
   * 图片地址：本地地址（相对 / 绝对）原样返回，交给主进程解析成 pv:// 地址；
   * 远程只认 http(s)；协议相对按 https 处理（在 file:// 宿主里会变成 file://主机名）；
   * data: / file: / javascript: 一律不放行。
   */
  function safeImgSrc(url) {
    const u = String(url).trim();
    if (!u) return '';
    // 控制字符：浏览器解析地址时会忽略它们；占位符也可能混进来
    if (/[\u0000-\u001f\u007f]/.test(u)) return '';
    if (hasScheme(u)) return /^https?:/i.test(u) ? u : '';
    if (u.startsWith('//')) return 'https:' + u;
    return u;
  }

  /** 图片语法：![alt](地址 "标题")；地址可以用 <> 包住含空格的路径 */
  const IMG_RE = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^)\s\u0000\u0001]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g;

  /** 图片没出来时的占位说明；错误码来自主进程的 fs:resolve-images */
  const IMG_ERRORS = {
    ENOENT: '文件不存在',
    EACCES_ROOT: '不在工作区内',
    ENOT_IMAGE: '不是图片',
    ENOT_FILE: '不是文件',
    ETOO_LARGE: '图片过大',
    EBAD_SRC: '地址无效',
    EIMG: '无法读取'
  };

  /**
   * 一张图片的 HTML。远程地址直接交给 Chromium（README 的隐私说明已经把外链图片
   * 算作联网来源）；本地地址用主进程解析好的 pv:// 地址；两者都没有就落成占位。
   */
  function imageHtml(pic, images) {
    const hit = images && images.get ? images.get(pic.src) : null;
    const url = /^https?:/i.test(pic.src) ? pic.src : hit && hit.url;
    const title = pic.title ? ' title="' + escAttr(pic.title) + '"' : '';
    if (url) {
      return '<img src="' + escAttr(url) + '" alt="' + escAttr(pic.alt) + '"' + title
        + ' loading="lazy" decoding="async">';
    }
    const reason = IMG_ERRORS[(hit && hit.error) || 'EIMG'] || IMG_ERRORS.EIMG;
    return '<span class="md-img-missing" title="' + escAttr(reason + '：' + pic.src) + '">'
      + esc(pic.alt || pic.src) + '<span class="why">' + esc(reason) + '</span></span>';
  }

  function inline(s, images) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });

    // 图片要在转义前抽出来：地址要单独判断协议，alt 里的行内代码占位符也要先还原
    const pics = [];
    s = s.replace(IMG_RE, (m, alt, rawSrc, dq, sq) => {
      const src = safeImgSrc(rawSrc.replace(/^</, '').replace(/>$/, ''));
      if (!src) return m;                    // 危险协议：整段留成普通文本
      pics.push({
        alt: alt.replace(/\u0000(\d+)\u0000/g, (t, i) => codes[+i]),
        src: src,
        title: dq || sq || ''
      });
      return '\u0001' + (pics.length - 1) + '\u0001';
    });

    s = esc(s);
    // 地址跟着正文一起转义过（& < > 已安全）；协议判断不受转义影响，
    // 剩下的唯一危险字符是引号——转义成 %22 后就不可能逃出 href 属性。
    // 地址里不允许出现占位符：否则回填 <code> / <img> 时会落到属性中间。
    s = s.replace(/\[([^\]]+)\]\(([^)\s\u0000\u0001]+)\)/g, (m, text, url) => {
      if (!safeHref(url)) return m;
      const href = url.replace(/"/g, '%22').replace(/'/g, '%27');
      return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 图片先回填：alt 里的行内代码在上一步已经还原成原文，不会再落进属性
    s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => imageHtml(pics[+i], images));
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + escAttr(codes[+i]) + '</code>');
    return s;
  }

  function renderList(items, start, base, images) {
    const level = base === undefined ? items[start].indent : base;
    const tag = items[start].ordered ? 'ol' : 'ul';
    let html = '<' + tag + '>';
    let i = start;
    while (i < items.length) {
      const it = items[i];
      if (it.indent < level) break;
      if (it.indent > level) {
        const nested = renderList(items, i, it.indent, images);
        html += nested.html;
        i = nested.next;
        continue;
      }
      html += '<li>' + inline(it.text, images);
      if (i + 1 < items.length && items[i + 1].indent > level) {
        const nested = renderList(items, i + 1, items[i + 1].indent, images);
        html += nested.html;
        i = nested.next;
      }
      html += '</li>';
      i++;
    }
    return { html: html + '</' + tag + '>', next: i };
  }

  function toHtml(src, images) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let i = 0;
    const flush = () => {
      if (para.length) { out.push('<p>' + inline(para.join(' '), images) + '</p>'); para = []; }
    };

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { flush(); i++; continue; }

      let m = line.match(/^\s*```(\w*)\s*$/);
      if (m) {
        flush();
        const lang = m[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        // 先输出转义后的纯文本，稍后由 PV.highlight.highlightFences 原地升级为高亮
        out.push('<pre class="md-code" data-lang="' + esc(lang) + '"><code>'
          + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flush();
        const n = m[1].length;
        out.push('<h' + n + '>' + inline(m[2].replace(/\s+#+\s*$/, ''), images) + '</h' + n + '>');
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }

      if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + toHtml(buf.join('\n'), images) + '</blockquote>');
        continue;
      }

      const next = lines[i + 1];
      if (line.indexOf('|') >= 0 && next && /-/.test(next) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next)) {
        flush();
        const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line);
        const align = cells(next).map((a) => (/^:-+:$/.test(a) ? 'center' : /-+:$/.test(a) ? 'right' : 'left'));
        const attr = (k) => (align[k] && align[k] !== 'left' ? ' style="text-align:' + align[k] + '"' : '');
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          rows.push(cells(lines[i]));
          i++;
        }
        out.push('<div class="md-table-wrap"><table><thead><tr>'
          + head.map((c, k) => '<th' + attr(k) + '>' + inline(c, images) + '</th>').join('')
          + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + head.map((_, k) => '<td' + attr(k) + '>' + inline(r[k] || '', images) + '</td>').join('') + '</tr>').join('')
          + '</tbody></table></div>');
        continue;
      }

      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        flush();
        const items = [];
        while (i < lines.length) {
          const lm = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          if (!lm) {
            if (!lines[i].trim() && i + 1 < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i + 1])) { i++; continue; }
            break;
          }
          items.push({ indent: lm[1].replace(/\t/g, '  ').length, ordered: /\d/.test(lm[2]), text: lm[3] });
          i++;
        }
        out.push(renderList(items, 0, undefined, images).html);
        continue;
      }

      para.push(line.trim());
      i++;
    }
    flush();
    return out.join('\n');
  }

  /** 一次最多解析多少张本地图片，避免一份文档把 IPC 与磁盘读打满 */
  const MAX_IMAGES = PV.contracts.MAX_MD_IMAGES;

  /**
   * 正文里出现的本地图片地址（去重、跳过围栏代码块），供主进程批量解析成 pv://。
   * 行内代码里的图片语法也会被收进来——最多多问一次主进程，不会多出 <img>。
   */
  function imageSources(src) {
    const out = [];
    const seen = new Set();
    let fence = false;
    for (const line of String(src).replace(/\r\n?/g, '\n').split('\n')) {
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      IMG_RE.lastIndex = 0;
      let m;
      while ((m = IMG_RE.exec(line))) {
        const url = safeImgSrc(m[2].replace(/^</, '').replace(/>$/, ''));
        // 远程地址渲染时直接用，危险协议也不会产图，两种都不用问主进程
        if (!url || /^https?:/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= MAX_IMAGES) return out;
      }
    }
    return out;
  }

  window.PV = window.PV || {};
  window.PV.markdown = { toHtml: toHtml, imageSources: imageSources };
})();
