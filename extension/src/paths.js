'use strict';

const path = require('path');

/**
 * 数据目录：config.json / lyrics-cache.json / offsets.json 的存放位置。
 *
 * 直接跑源码时就是扩展目录本身；打包成 exe 后扩展位于程序安装目录内
 * （可能只读、升级时也会被覆盖），这时由主进程通过 R2N_DATA_DIR
 * 指向用户数据目录，配对信息与歌词缓存才不会丢。
 */
const dataDir = process.env.R2N_DATA_DIR ? path.resolve(process.env.R2N_DATA_DIR) : path.join(__dirname, '..');

module.exports = { dataDir };
