/**
 * 从 assets/icon-source.png 生成各尺寸 PNG/ICO，保留原图的透明边缘与立体层次。
 *
 * 用法：node scripts/build-icons.mjs
 * 产物：build/icon.ico（多尺寸）、build/icons/*.png
 */

import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* ---------------- PNG 解码与缩放 ---------------- */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('assets/icon-source.png 的 PNG 文件头无效');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const compressed = [];
  for (let offset = 8; offset < buffer.length;) {
    if (offset + 12 > buffer.length) throw new Error('PNG 数据块不完整');
    const length = buffer.readUInt32BE(offset);
    if (offset + length + 12 > buffer.length) throw new Error('PNG 数据块越界');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13 || body[10] || body[11] || body[12]) {
        throw new Error('图标源文件必须是非交错的标准 PNG');
      }
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') compressed.push(body);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  if (bitDepth !== 8 || colorType !== 6 || !width || width !== height) {
    throw new Error('assets/icon-source.png 必须是正方形的 8 位 RGBA PNG');
  }

  const bpp = 4;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(compressed));
  if (raw.length !== height * (stride + 1)) throw new Error('PNG 像素数据长度不符');
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`不支持的 PNG 过滤器：${filter}`);
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? pixels[dst + x - bpp] : 0;
      const up = y ? pixels[dst + x - stride] : 0;
      const upperLeft = y && x >= bpp ? pixels[dst + x - stride - bpp] : 0;
      const predictor = filter === 1 ? left
        : filter === 2 ? up
          : filter === 3 ? Math.floor((left + up) / 2)
            : filter === 4 ? paeth(left, up, upperLeft) : 0;
      pixels[dst + x] = (raw[src + x] + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

const source = decodePng(readFileSync(path.join(root, 'assets', 'icon-source.png')));

function renderRgba(size) {
  const data = Buffer.alloc(size * size * 4);
  const scale = source.width / size;
  // 按像素面积缩小，避免大图缩到任务栏尺寸时跳采样；预乘 alpha 防止透明边缘出现白边。
  for (let y = 0; y < size; y++) {
    const top = y * scale;
    const bottom = (y + 1) * scale;
    for (let x = 0; x < size; x++) {
      const left = x * scale;
      const right = (x + 1) * scale;
      const i = (y * size + x) * 4;
      let alpha = 0;
      const premultiplied = [0, 0, 0];
      for (let sy = Math.floor(top); sy < Math.min(source.height, Math.ceil(bottom)); sy++) {
        const height = Math.min(bottom, sy + 1) - Math.max(top, sy);
        for (let sx = Math.floor(left); sx < Math.min(source.width, Math.ceil(right)); sx++) {
          const weight = height * (Math.min(right, sx + 1) - Math.max(left, sx));
          const sourceIndex = (sy * source.width + sx) * 4;
          const a = source.pixels[sourceIndex + 3] / 255;
          alpha += a * weight;
          for (let channel = 0; channel < 3; channel++) {
            premultiplied[channel] += source.pixels[sourceIndex + channel] * a * weight;
          }
        }
      }
      data[i + 3] = Math.round(alpha * 255 / (scale * scale));
      if (alpha) {
        for (let channel = 0; channel < 3; channel++) {
          data[i + channel] = Math.round(premultiplied[channel] / alpha);
        }
      }
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

/* ---------------- 输出 ---------------- */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

mkdirSync(path.join(root, 'assets'), { recursive: true });
mkdirSync(path.join(root, 'build', 'icons'), { recursive: true });

const entries = [];
for (const size of SIZES) {
  const png = encodePng(size, renderRgba(size));
  entries.push({ size, png });
  writeFileSync(path.join(root, 'build', 'icons', `icon-${size}.png`), png);
}
console.log('[icon] build/icons/ ' + SIZES.join(', ') + ' px');

writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(entries));
console.log('[icon] build/icon.ico (' + entries.length + ' 个尺寸)');
