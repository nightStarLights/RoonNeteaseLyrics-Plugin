'use strict';

/**
 * 运行时生成托盘 / 窗口图标（PNG），避免仓库里放二进制资源。
 * 图形：紫粉渐变圆角方块 + 白色唱片环。
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function roundedRectAlpha(u, v, x0, y0, w, h, r) {
  const qx = Math.abs(u - (x0 + w / 2)) - (w / 2 - r);
  const qy = Math.abs(v - (y0 + h / 2)) - (h / 2 - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return 1 - smoothstep(-0.01, 0.01, d);
}

function band(d, inner, outer, soft) {
  const a = inner <= 0 ? 1 : smoothstep(inner - soft, inner + soft, d);
  const b = 1 - smoothstep(outer - soft, outer + soft, d);
  return Math.min(a, b);
}

function sample(u, v) {
  const alpha = roundedRectAlpha(u, v, 0.03, 0.03, 0.94, 0.94, 0.26);
  if (alpha <= 0) return [0, 0, 0, 0];

  let col = mix([139, 92, 246], [236, 72, 153], clamp01((u + v) / 2 - 0.15));

  const d = Math.hypot(u - 0.5, v - 0.5);
  const ring = band(d, 0.2, 0.31, 0.012);
  const dot = band(d, 0, 0.085, 0.012);
  const white = Math.max(ring, dot) * 0.96;
  if (white > 0) col = mix(col, [255, 255, 255], white);

  return [col[0], col[1], col[2], alpha];
}

function createIcon(size = 32) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const c = sample(u, v);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
        px[i + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
  }

  return encodePng(size, size, px);
}

module.exports = { createIcon };
