'use strict';

/**
 * 生成 Windows 用的 icon.ico（多尺寸），供打包时设置 exe 图标。
 * ICO 从 Vista 起可以直接内嵌 PNG，所以不需要引入额外的图像库，
 * 图形本体复用运行时那套 icon.js。
 */

const fs = require('fs');
const path = require('path');

const { createIcon } = require('./icon');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const img of images) {
    const entry = Buffer.alloc(16);
    // 256 用 0 表示
    entry[0] = img.size >= 256 ? 0 : img.size;
    entry[1] = img.size >= 256 ? 0 : img.size;
    entry[2] = 0; // 调色板颜色数
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(img.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += img.data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function writeIcon(file) {
  const images = SIZES.map((size) => ({ size, data: createIcon(size) }));
  fs.writeFileSync(file, buildIco(images));
  return file;
}

if (require.main === module) {
  console.log(`已生成 ${writeIcon(path.join(__dirname, 'icon.ico'))}`);
}

module.exports = { writeIcon, buildIco, SIZES };
