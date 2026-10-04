'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 默认配置。注意：node-roon-api 会把自己的配对信息（roonstate）
 * 写进同一个 config.json，所以这里解析时必须忽略未知字段。
 */
const DEFAULTS = {
  host: '127.0.0.1',
  port: 8687,

  // auto:   内置库可用就用它（可选组件，需自行安装），否则回退官方直连（默认）
  // lib:    只用内置库（进程内调用，需要 npm install NeteaseCloudMusicApi）
  // direct: 只用网易云官方公开接口（不依赖任何依赖包，免安装）
  // ncm:    只用外部独立运行的 NeteaseCloudMusicApi 服务（需要自己部署）
  lyricSource: 'auto',

  // 仅 lyricSource = "ncm" 时使用
  ncmApi: 'http://127.0.0.1:14300',
  cookie: '',
  directUserAgent: '',
  ncmTimeoutMs: 8000,
  ncmHealthIntervalMs: 30000,

  zone: '',
  searchLimit: 10,
  minMatchScore: 55,
  filterCredits: true,
  translation: true,
  romaji: true,
  lyricOffsetMs: 0,

  progressIntervalMs: 400,
  cacheLimit: 500,
  logLevel: 'info',
};

function readJson(file) {
  try {
    // 记事本等编辑器保存 UTF-8 时会写 BOM，JSON.parse 遇到 BOM 会直接抛错，
    // 那样用户手改过的 config.json 会被当成不存在、又被默认值覆盖掉
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function normalize(raw) {
  const cfg = Object.assign({}, DEFAULTS, raw || {});

  cfg.host = String(cfg.host || DEFAULTS.host);
  cfg.port = Number(cfg.port) || DEFAULTS.port;
  cfg.ncmApi = String(cfg.ncmApi || DEFAULTS.ncmApi).replace(/\/+$/, '');
  cfg.cookie = String(cfg.cookie || cfg.ncmCookie || '');
  cfg.directUserAgent = String(cfg.directUserAgent || '');

  cfg.lyricSource = ['auto', 'lib', 'direct', 'ncm'].includes(String(cfg.lyricSource || '').toLowerCase())
    ? String(cfg.lyricSource).toLowerCase()
    : DEFAULTS.lyricSource;

  cfg.ncmTimeoutMs = Math.max(1000, Number(cfg.ncmTimeoutMs) || DEFAULTS.ncmTimeoutMs);
  cfg.ncmHealthIntervalMs = Math.max(5000, Number(cfg.ncmHealthIntervalMs) || DEFAULTS.ncmHealthIntervalMs);
  cfg.zone = String(cfg.zone || '').trim();
  cfg.searchLimit = Math.min(50, Math.max(1, Number(cfg.searchLimit) || DEFAULTS.searchLimit));
  cfg.minMatchScore = Math.min(200, Math.max(0, Number(cfg.minMatchScore) || DEFAULTS.minMatchScore));
  cfg.filterCredits = cfg.filterCredits !== false;
  cfg.translation = cfg.translation !== false;
  cfg.romaji = cfg.romaji !== false;
  cfg.lyricOffsetMs = Number(cfg.lyricOffsetMs) || 0;
  cfg.progressIntervalMs = Math.min(2000, Math.max(100, Number(cfg.progressIntervalMs) || DEFAULTS.progressIntervalMs));
  cfg.cacheLimit = Math.max(10, Number(cfg.cacheLimit) || DEFAULTS.cacheLimit);
  cfg.logLevel = String(cfg.logLevel || DEFAULTS.logLevel);

  return cfg;
}

/**
 * 读取 config.json（不存在则按默认值创建）。
 * @param {string} rootDir 扩展根目录
 */
function load(rootDir) {
  const file = path.join(rootDir, 'config.json');
  let raw = readJson(file);

  if (!raw) {
    raw = Object.assign({}, DEFAULTS);
    try {
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    } catch (err) {
      // 只读目录下不致命
    }
  }

  return { config: normalize(raw), configPath: file };
}

/**
 * 把部分配置写回 config.json（保留 node-roon-api 写入的 roonstate 等其它字段）。
 * @returns {Object} 写入后的完整配置
 */
function savePatch(rootDir, patch) {
  const file = path.join(rootDir, 'config.json');
  const existing = readJson(file) || {};
  const merged = Object.assign({}, existing, patch || {});

  try {
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  } catch (err) {
    // 写入失败不影响运行
  }

  return normalize(merged);
}

module.exports = { load, normalize, savePatch, DEFAULTS };
