/**
 * 生成应用图标：黑底 + 白色「lit」字标。
 *
 * 三个竖条同时是字母 l / i / t，也对应文件浏览器的多栏结构。
 * 几何定义在这里是唯一来源，SVG 与各尺寸 PNG/ICO 都由它生成，
 * 避免矢量图和位图各改一份导致不一致。
 *
 * 用法：node scripts/build-icons.mjs
 * 产物：assets/icon.svg（矢量母版）、build/icon.ico（多尺寸）、build/icons/*.png
 */

import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 1024;
const INK = '#ffffff';
const BG = '#000000';

/* ---------------- 几何（1024 画布，视觉重心居中） ---------------- */
const BAR_W = 128;
/** 笔画端部圆角：明显小于半宽，做成圆角矩形而不是胶囊 */
const CAP_R = 36;
const BG_RADIUS = 228;        // 22.3%，接近现代桌面图标
const ASC_TOP = 228;          // 上升部顶线（l 与 T 横线对齐）
const BASELINE = 796;         // 基线
const STEM_H = BASELINE - ASC_TOP;
const X_TOP = 372;            // i 的字干顶（x-height）

const COL_L = 180;
const COL_I = 380;
const COL_T = 580;            // T 横线左端
const T_BAR_W = 264;
const T_STEM_X = COL_T + (T_BAR_W - BAR_W) / 2;

const SHAPES = [
  // l
  { type: 'rect', x: COL_L, y: ASC_TOP, w: BAR_W, h: STEM_H, r: CAP_R },
  // i：点 + 字干（点也用圆角矩形，和笔画保持同一套造型语言）
  { type: 'rect', x: COL_I, y: ASC_TOP, w: BAR_W, h: 120, r: CAP_R },
  { type: 'rect', x: COL_I, y: X_TOP, w: BAR_W, h: BASELINE - X_TOP, r: CAP_R },
  // T：横线在最上，竖笔从横线中间往下
  { type: 'rect', x: COL_T, y: ASC_TOP, w: T_BAR_W, h: BAR_W, r: CAP_R },
  { type: 'rect', x: T_STEM_X, y: ASC_TOP, w: BAR_W, h: STEM_H, r: CAP_R }
];

/* ---------------- 有符号距离场 ---------------- */
function rectSdf(px, py, s) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const hx = s.w / 2 - s.r;
  const hy = s.h / 2 - s.r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - s.r;
}

function circleSdf(px, py, s) {
  const dx = px - s.cx;
  const dy = py - s.cy;
  return Math.sqrt(dx * dx + dy * dy) - s.r;
}

/** 覆盖率：1px 过渡带做抗锯齿 */
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d));

function renderRgba(size) {
  const scale = SIZE / size;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 取像素中心在 1024 坐标系下的位置
      const px = (x + 0.5) * scale;
      const py = (y + 0.5) * scale;

      const bg = coverage(rectSdf(px, py, { x: 0, y: 0, w: SIZE, h: SIZE, r: BG_RADIUS }));
      let glyph = 1e9;
      for (const s of SHAPES) {
        glyph = Math.min(glyph, s.type === 'circle' ? circleSdf(px, py, s) : rectSdf(px, py, s));
      }
      const ink = coverage(glyph) * bg;

      // 黑底 + 白字：按覆盖率合成
      const r = Math.round(0 * (1 - ink) + 255 * ink);
      const g = Math.round(0 * (1 - ink) + 255 * ink);
      const b = Math.round(0 * (1 - ink) + 255 * ink);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(255 * bg);
    }
  }
  return data;
}

/* ---------------- PNG 编码 ---------------- */
const crc = typeof crc32 === 'function' ? crc32 : (() => {
  let table = null;
  return (buf) => {
    if (!table) {
      table = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, body])));
  return Buffer.concat([len, typeBuf, body, crcBuf]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前置一个 filter 字节（0 = None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- ICO 封装（内嵌 PNG，Vista+ 支持） ---------------- */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);            // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;   // 256 记作 0
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);           // planes
    dir.writeUInt16LE(32, o + 6);          // bpp
    dir.writeUInt32BE(0, o + 8);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ---------------- SVG 母版 ---------------- */
function toSvg() {
  const parts = SHAPES.map((s) => s.type === 'circle'
    ? `  <circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${INK}"/>`
    : `  <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${INK}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="lit explorer">
  <title>lit explorer</title>
  <rect width="${SIZE}" height="${SIZE}" rx="${BG_RADIUS}" fill="${BG}"/>
${parts.join('\n')}
</svg>
`;
}

/* ---------------- 输出 ---------------- */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

mkdirSync(path.join(root, 'assets'), { recursive: true });
mkdirSync(path.join(root, 'build', 'icons'), { recursive: true });

writeFileSync(path.join(root, 'assets', 'icon.svg'), toSvg(), 'utf8');
console.log('[icon] assets/icon.svg');

const entries = [];
for (const size of SIZES) {
  const png = encodePng(size, renderRgba(size));
  entries.push({ size, png });
  writeFileSync(path.join(root, 'build', 'icons', `icon-${size}.png`), png);
}
console.log('[icon] build/icons/ ' + SIZES.join(', ') + ' px');

writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(entries));
console.log('[icon] build/icon.ico (' + entries.length + ' 个尺寸)');
