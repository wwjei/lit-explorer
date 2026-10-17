/* Markdown 渲染：标题/段落/列表(含嵌套)/引用/分割线/表格/代码块/行内样式 */
(function () {
  'use strict';

  const esc = PV.highlight.escapeHtml;

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + esc(codes[+i]) + '</code>');
    return s;
  }

  function renderList(items, start, base) {
    const level = base === undefined ? items[start].indent : base;
    const tag = items[start].ordered ? 'ol' : 'ul';
    let html = '<' + tag + '>';
    let i = start;
    while (i < items.length) {
      const it = items[i];
      if (it.indent < level) break;
      if (it.indent > level) {
        const nested = renderList(items, i, it.indent);
        html += nested.html;
        i = nested.next;
        continue;
      }
      html += '<li>' + inline(it.text);
      if (i + 1 < items.length && items[i + 1].indent > level) {
        const nested = renderList(items, i + 1, items[i + 1].indent);
        html += nested.html;
        i = nested.next;
      }
      html += '</li>';
      i++;
    }
    return { html: html + '</' + tag + '>', next: i };
  }

  function toHtml(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let i = 0;
    const flush = () => {
      if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
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
        out.push('<h' + n + '>' + inline(m[2].replace(/\s+#+\s*$/, '')) + '</h' + n + '>');
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
        out.push('<blockquote>' + toHtml(buf.join('\n')) + '</blockquote>');
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
          + head.map((c, k) => '<th' + attr(k) + '>' + inline(c) + '</th>').join('')
          + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + head.map((_, k) => '<td' + attr(k) + '>' + inline(r[k] || '') + '</td>').join('') + '</tr>').join('')
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
        out.push(renderList(items, 0).html);
        continue;
      }

      para.push(line.trim());
      i++;
    }
    flush();
    return out.join('\n');
  }

  window.PV = window.PV || {};
  window.PV.markdown = { toHtml: toHtml };
})();
