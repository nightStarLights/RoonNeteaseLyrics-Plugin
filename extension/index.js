'use strict';

/**
 * Roon → 网易云歌词 扩展
 *
 * 1) 通过 node-roon-api 连接 Roon Core，订阅正在播放的区
 * 2) 拿曲目名/艺术家去 NeteaseCloudMusicApi 搜索并抓取歌词
 * 3) 通过 WebSocket 把曲目 + 歌词 + 实时进度广播给桌面歌词窗口
 */

const { dataDir } = require('./src/paths');

// node-roon-api 会以相对路径读写 config.json（存放配对信息），固定到数据目录。
// 直接跑源码时数据目录就是扩展目录；打包后指向用户数据目录。
process.chdir(dataDir);

const { load, savePatch } = require('./src/config');
const logger = require('./src/logger');
const { NcmRouter } = require('./src/ncm-router');
const { LyricService } = require('./src/lyrics');
const { NowPlaying } = require('./src/now-playing');
const { RoonBridge } = require('./src/roon');
const { DemoSource } = require('./src/demo');
const { OverlayServer } = require('./src/server');

const DEMO = process.argv.includes('--demo');
const SOURCE_LABELS = {
  auto: '自动（内置库可用就用它，否则官方直连）',
  lib: '仅内置库（可选组件，需自行安装）',
  direct: '仅网易云官方直连接口（免安装）',
  ncm: '仅外部独立运行的 NeteaseCloudMusicApi 服务',
};

const { config, configPath } = load(dataDir);
logger.setLevel(config.logLevel);

logger.info('--------------------------------------------------');
logger.info(' Roon → 网易云歌词扩展 v1.0.0');
logger.info(` 配置文件: ${configPath}`);
logger.info(` 歌词数据源: ${SOURCE_LABELS[config.lyricSource]}`);
if (config.lyricSource === 'ncm') logger.info(` 外部 NCM API: ${config.ncmApi}`);
logger.info(` 监听播放区: ${config.zone || '(自动选择正在播放的区)'}`);
if (DEMO) logger.info(' 运行模式: 演示模式（模拟播放，不连接 Roon）');
logger.info('--------------------------------------------------');

const ncm = new NcmRouter({ config, logger });

const nowPlaying = new NowPlaying({ progressIntervalMs: config.progressIntervalMs });
const lyricService = new LyricService({ ncm, config, logger });
// DEMO_SECONDS 可以缩短演示模式的单曲时长，方便验证连续切歌等场景
const roon = DEMO
  ? new DemoSource({
      config,
      logger,
      nowPlaying,
      secondsPerSong: Number(process.env.DEMO_SECONDS) || undefined,
    })
  : new RoonBridge({ config, logger, nowPlaying });

const server = new OverlayServer({
  config,
  logger,
  nowPlaying,
  lyricService,
  ncm,
  roon,
});

// ---------------------------------------------------------------- 歌词解析

// 正在解析的曲目 id。只用来避免「同一首歌重复解析」，
// 不再用它拦截切歌——早期版本是「有解析在跑就整个跳过」，
// 快速切歌或某次解析卡住时，新曲目会永远拿不到歌词，
// 表现就是一直挂着上一首（尤其明显的是上一首手动搜索的结果）。
let resolvingTrackId = null;

async function resolveCurrentTrack(force = false) {
  const track = nowPlaying.track();

  if (!track.title) {
    nowPlaying.setLyrics('idle', null);
    return;
  }

  if (force) resolvingTrackId = null;
  if (resolvingTrackId === track.trackId) {
    logger.debug(`《${track.title}》正在解析中，跳过重复请求`);
    return;
  }

  resolvingTrackId = track.trackId;
  lyricService.invalidate();
  const gen = lyricService.generation;
  const trackId = track.trackId;

  nowPlaying.setLyrics('searching', null);
  logger.debug(`开始解析歌词: 《${track.title}》 - ${track.artists.join('、')}`);

  try {
    const result = await lyricService.resolve(track);
    if (gen !== lyricService.generation || nowPlaying.trackId !== trackId) {
      logger.debug(`《${track.title}》的歌词结果已过期，忽略`);
      return;
    }
    applyResult(result);
  } catch (err) {
    if (gen !== lyricService.generation || nowPlaying.trackId !== trackId) return;
    logger.error('解析歌词异常:', err.stack || err.message);
    nowPlaying.setLyrics('error', { reason: 'exception', error: err.message, lines: [], synced: false });
  } finally {
    if (resolvingTrackId === trackId) resolvingTrackId = null;
  }
}

function applyResult(result) {
  switch (result.status) {
    case 'found':
      logger.info(`歌词就绪: 《${result.songName}》(共 ${result.lines.length} 行${result.hasTranslation ? '，含翻译' : ''})`);
      nowPlaying.setLyrics('found', result);
      break;
    case 'empty':
      nowPlaying.setLyrics('empty', result);
      break;
    case 'notfound':
      nowPlaying.setLyrics('notfound', result);
      break;
    case 'error':
      nowPlaying.setLyrics('error', result);
      break;
    case 'cancelled':
      break;
    default:
      nowPlaying.setLyrics('error', result);
      break;
  }
}

// ---------------------------------------------------------------- 事件接线

// 连续切歌时先等元信息稳定下来再解析：否则每跳一首都会发一轮搜索请求，
// 既抢带宽又互相把结果顶掉，表现就是「切了半天还是没反应」。
let resolveTimer = null;

function scheduleResolve(delayMs = 320) {
  if (resolveTimer) clearTimeout(resolveTimer);
  resolveTimer = setTimeout(() => {
    resolveTimer = null;
    resolveCurrentTrack();
  }, delayMs);
}

roon.on('track', () => {
  server.broadcast('player', nowPlaying.playerPayload());
  // 先立刻清掉上一首的歌词，避免新歌词到达前一直挂着旧的
  nowPlaying.setLyrics('searching', null);
  scheduleResolve();
});

roon.on('state', () => {
  server.broadcast('player', nowPlaying.playerPayload());
  server.broadcast('progress', nowPlaying.progressPayload());
});

roon.on('zone', (data) => {
  logger.info(`切换监听播放区 -> ${data.zoneName}`);
  server.broadcast('player', nowPlaying.playerPayload());
  // 一起推一份播放区列表，桌面端要显示「当前在监听哪台设备」
  server.broadcast('roon', roon.snapshot());
});

roon.on('zones', (snapshot) => {
  server.broadcast('roon', snapshot || roon.snapshot());
});

roon.on('status', (data) => {
  server.broadcast('roon', Object.assign({}, roon.snapshot(), data));
});

nowPlaying.on('progress', (data) => {
  server.broadcast('progress', data);
});

nowPlaying.on('lyrics', (data) => {
  server.broadcast('lyrics', data);
});

server.on('refresh', () => {
  logger.info('收到重新解析请求');
  if (resolveTimer) {
    clearTimeout(resolveTimer);
    resolveTimer = null;
  }
  resolveCurrentTrack(true);
});

server.on('select', async (songId) => {
  const track = nowPlaying.track();
  if (!track.title) return;
  logger.info(`手动指定歌词: id=${songId}`);
  lyricService.pin(track, songId);
  lyricService.invalidate();
  const gen = lyricService.generation;
  const trackId = track.trackId;

  nowPlaying.setLyrics('searching', null);
  try {
    const result = await lyricService.loadBySongId(songId, track);
    if (gen !== lyricService.generation || nowPlaying.trackId !== trackId) return;
    applyResult(result);
  } catch (err) {
    if (gen !== lyricService.generation) return;
    nowPlaying.setLyrics('error', { reason: 'exception', error: err.message, lines: [], synced: false });
  }
});

server.on('config', async (patch) => {
  const ncmPatch = {};
  if (patch.ncmApi) ncmPatch.ncmApi = String(patch.ncmApi).trim();
  if (patch.lyricSource) ncmPatch.lyricSource = String(patch.lyricSource).trim().toLowerCase();

  // 全局时间轴偏移：整条音频链路有固定延迟时（例如经 HQPlayer / 网络端点，
  // Roon 上报的位置会领先实际听到的声音若干秒）一次性校准所有曲目。
  // 与「按曲目偏移」相加，正数 = 歌词提前显示。
  const filePatch = Object.assign({}, ncmPatch);

  // 监听哪个播放区（空字符串 = 自动跟随正在播放的区）
  let zoneChanged = false;
  if (patch.zone !== undefined) {
    const zone = String(patch.zone || '').trim();
    if (zone !== (config.zone || '')) {
      filePatch.zone = zone;
      zoneChanged = true;
    }
  }

  let offsetChanged = false;
  if (patch.globalOffsetMs !== undefined) {
    const value = Math.max(-15000, Math.min(15000, Math.round(Number(patch.globalOffsetMs) || 0)));
    if (value !== (Number(config.lyricOffsetMs) || 0)) {
      filePatch.lyricOffsetMs = value;
      offsetChanged = true;
    }
  }

  if (Object.keys(filePatch).length === 0) return;

  const changed = ncm.updateConfig(ncmPatch);
  Object.assign(config, savePatch(dataDir, filePatch));

  logger.info(`配置已更新: ${JSON.stringify(filePatch)}（已写入 config.json）`);
  server.broadcast('config', server.settingsPayload());

  if (zoneChanged) {
    logger.info(`监听播放区已改为: ${config.zone || '(自动跟随正在播放的区)'}`);
    if (typeof roon.refreshZone === 'function') roon.refreshZone();
  }

  if (offsetChanged) {
    // 用缓存里的原始歌词重新出时间轴，不用重新联网
    const rebuilt = lyricService.rebuild(nowPlaying.track());
    if (rebuilt) applyResult(rebuilt);
  }

  await checkSource();
  if (changed) resolveCurrentTrack(true);
});

server.on('offset', async (opts) => {
  const track = nowPlaying.track();
  if (!track.title) return;

  // 手动强制对齐：先向 Roon 拉一次最新进度，再把本地时钟对齐过去
  if (opts.realign) {
    if (typeof roon.refreshZones === 'function') await roon.refreshZones();
    const position = nowPlaying.realign();
    logger.info(`时间轴已对齐到 ${position === null ? '未知位置' : position.toFixed(2) + 's'}`);
    server.broadcast('realign', { position });
    return;
  }

  let value;
  if (opts.reset) value = lyricService.setOffset(track, 0);
  else if (opts.value !== undefined) value = lyricService.setOffset(track, Number(opts.value));
  else value = lyricService.nudgeOffset(track, Number(opts.delta) || 0);

  logger.info(`时间轴偏移: ${value > 0 ? '+' : ''}${value}ms (《${track.title}》)`);
  server.broadcast('offset', { trackId: track.trackId, offsetMs: value });

  const rebuilt = lyricService.rebuild(track);
  if (rebuilt) applyResult(rebuilt);
  else resolveCurrentTrack(true);
});

server.on('search', async ({ keywords, ws }) => {
  if (!keywords.trim()) return;
  try {
    const candidates = await server.searchCandidates(keywords);
    server.sendTo(ws, 'searchResult', { keywords, candidates });
  } catch (err) {
    server.sendTo(ws, 'searchResult', { keywords, candidates: [], error: err.message });
  }
});

// ---------------------------------------------------------------- 数据源健康检查

async function checkSource() {
  const changed = await ncm.refresh();
  if (changed) {
    server.broadcast('ncm', ncm.status());
  }
}

// ---------------------------------------------------------------- 启动

async function main() {
  try {
    await server.start();
  } catch (err) {
    logger.error(`启动 HTTP/WebSocket 服务失败: ${err.message}`);
    process.exit(1);
  }

  await checkSource();
  setInterval(checkSource, config.ncmHealthIntervalMs).unref();

  nowPlaying.startTicker();
  roon.start();

  logger.info('扩展已启动，请在 Roon 的「设置 → 扩展」中启用 “网易云歌词 (NetEase Lyrics)”');
}

function shutdown(signal) {
  logger.info(`收到 ${signal}，正在退出…`);
  nowPlaying.stopTicker();
  if (typeof roon.stop === 'function') roon.stop();
  server.close();
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error('未处理的 Promise 异常:', err && err.stack ? err.stack : err);
});

main();
