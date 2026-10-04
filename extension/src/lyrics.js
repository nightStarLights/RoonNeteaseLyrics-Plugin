'use strict';

const fs = require('fs');
const path = require('path');

const { buildLyrics } = require('./lrc');
const { pickBest, normalize } = require('./matcher');
const { NcmError } = require('./ncm');
const { dataDir } = require('./paths');

/**
 * 缓存格式 / 解析器版本。
 * 改动了 LRC 解析或合并逻辑后就 +1：旧缓存会被丢弃并重新解析，
 * 否则修复对已经缓存过的曲目不会生效（缓存里存的是解析好的结果）。
 */
const CACHE_VERSION = 2;

/**
 * 歌词服务：搜索匹配 + 拉取 + 解析 + 缓存。
 */
class LyricService {
  constructor({ ncm, config, logger }) {
    this.ncm = ncm;
    this.config = config;
    this.log = logger;

    this.memory = new Map();
    this.diskFile = path.join(dataDir, 'lyrics-cache.json');
    this.disk = this._loadDisk();
    this.offsetFile = path.join(dataDir, 'offsets.json');
    this.offsets = this._loadDisk(this.offsetFile); // trackCacheKey -> 毫秒偏移
    this._saveTimer = null;
    this._generation = 0;
    this.pins = new Map(); // trackCacheKey -> songId（用户手动指定）
    this.lastError = null;
  }

  /** 让正在进行的解析作废（切歌时调用） */
  invalidate() {
    this._generation += 1;
  }

  get generation() {
    return this._generation;
  }

  static trackCacheKey(track) {
    return [
      normalize(track.title || ''),
      (track.artists || []).map(normalize).sort().join(','),
      track.durationSec || 0,
    ].join('|');
  }

  _loadDisk(file = this.diskFile) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (err) {
      return {};
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.writeFileSync(this.diskFile, JSON.stringify(this.disk), 'utf8');
        fs.writeFileSync(this.offsetFile, JSON.stringify(this.offsets), 'utf8');
      } catch (err) {
        this.log.debug('写入歌词缓存失败:', err.message);
      }
    }, 1500);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /** 当前曲目的额外时间轴偏移（用户手动微调，毫秒） */
  getOffset(track) {
    return Number(this.offsets[LyricService.trackCacheKey(track)]) || 0;
  }

  /** 设置偏移，返回新值 */
  setOffset(track, ms) {
    const key = LyricService.trackCacheKey(track);
    const value = Math.max(-30000, Math.min(30000, Math.round(ms)));
    if (value === 0) delete this.offsets[key];
    else this.offsets[key] = value;
    this._scheduleSave();
    return value;
  }

  nudgeOffset(track, deltaMs) {
    return this.setOffset(track, this.getOffset(track) + deltaMs);
  }

  /** 应用偏移后重新解析已缓存的歌词（无需联网） */
  rebuild(track) {
    const key = LyricService.trackCacheKey(track);
    const entry = this.memory.get(key) || this.disk[key];
    if (!entry || entry.v !== CACHE_VERSION || !entry.raw || !entry.raw.lrc) return null;

    const parsed = buildLyrics({
      lrc: entry.raw.lrc,
      tlyric: this.config.translation ? entry.raw.tlyric : '',
      romalrc: this.config.romaji ? entry.raw.romalrc : '',
      offsetMs: this._totalOffset(key),
      durationSec: track.durationSec,
      filterCredits: this.config.filterCredits,
      translation: this.config.translation,
      romaji: this.config.romaji,
    });

    const result = Object.assign({}, stripRaw(entry), {
      status: parsed.lines.length > 0 ? 'found' : 'empty',
      lines: parsed.lines,
      synced: parsed.synced,
      offsetMs: parsed.offsetMs,
      trackOffsetMs: this.offsets[key] || 0,
    });

    this._setCached(key, result, entry.raw);
    return Object.assign({}, result);
  }

  _totalOffset(key) {
    return (Number(this.config.lyricOffsetMs) || 0) + (Number(this.offsets[key]) || 0);
  }

  _getCached(key) {
    const hit = this.memory.get(key) || this.disk[key];
    if (!hit) return null;

    if (hit.v !== CACHE_VERSION) {
      // 旧版本解析器留下的结果：丢掉，让调用方重新解析
      this.memory.delete(key);
      delete this.disk[key];
      this._scheduleSave();
      return null;
    }

    this.memory.set(key, hit); // 简单的 LRU 刷新
    const copy = stripRaw(hit);
    delete copy.v;
    copy.trackOffsetMs = this.offsets[key] || 0;
    return copy;
  }

  _setCached(key, value, raw) {
    const entry = raw ? Object.assign({}, value, { raw }) : Object.assign({}, value);
    entry.v = CACHE_VERSION;
    this.memory.set(key, entry);
    this.disk[key] = entry;

    while (this.memory.size > this.config.cacheLimit) {
      const oldest = this.memory.keys().next().value;
      this.memory.delete(oldest);
    }

    const keys = Object.keys(this.disk);
    if (keys.length > this.config.cacheLimit * 2) {
      for (const k of keys.slice(0, keys.length - this.config.cacheLimit)) {
        delete this.disk[k];
      }
    }

    this._scheduleSave();
  }

  /** 用户手动指定某个网易云歌曲 ID */
  pin(track, songId) {
    this.pins.set(LyricService.trackCacheKey(track), String(songId));
  }

  /**
   * 为指定曲目解析歌词。
   *
   * @param {Object} track { title, artists, album, durationSec }
   * @returns {Promise<Object>}
   */
  async resolve(track) {
    const gen = this._generation;
    const key = LyricService.trackCacheKey(track);
    const query = {
      title: track.title || '',
      artists: track.artists || [],
      album: track.album || '',
      durationSec: track.durationSec || 0,
    };

    if (!query.title) {
      return { status: 'empty', reason: 'unknown-track', lines: [], synced: false };
    }

    const pinned = this.pins.get(key);
    if (pinned) {
      const result = await this._loadBySongId(pinned, query, key);
      if (gen === this._generation && result.status === 'found') return result;
    }

    const cached = this._getCached(key);
    if (cached) {
      this.log.debug(`歌词命中缓存: ${query.title}`);
      return Object.assign({}, cached, { cached: true, status: cached.status === 'found' ? 'found' : cached.status });
    }

    const result = await this._searchAndLoad(query, key, gen);
    return result;
  }

  async _searchAndLoad(query, key, gen) {
    const attempts = buildSearchAttempts(query);
    const tried = [];
    let best = null;
    let lastError = null;

    for (const keywords of attempts) {
      if (gen !== this._generation) return { status: 'cancelled', lines: [], synced: false };

      let songs = [];
      try {
        songs = await this.ncm.search(keywords, this.config.searchLimit);
        this.lastError = null;
      } catch (err) {
        lastError = err;
        this.lastError = err.message;
        this.log.warn(`搜索歌词失败 [${keywords}]: ${err.message}`);
        if (err instanceof NcmError && err.code === 'NETWORK') break;
        continue;
      }

      tried.push(...songs);

      if (best && best.score >= this.config.minMatchScore) break;

      const candidate = pickBest(songs, query);
      if (candidate && (!best || candidate.score > best.score)) {
        best = candidate;
        best.keywords = keywords;
      }
      if (best && best.score >= this.config.minMatchScore + 25) break;
    }

    if (best && best.score >= this.config.minMatchScore) {
      this.log.info(
        `歌词匹配: 《${query.title}》 -> 《${best.song.name}》/${best.song.artists.join('、')} ` +
          `(评分 ${best.score.toFixed(1)}${best.durationDiff !== null ? `, 时长差 ${best.durationDiff}s` : ''})`
      );
      const loaded = await this._loadBySongId(best.song.id, query, key, best);
      if (loaded.status === 'found') return loaded;
      if (loaded.status === 'cancelled') return loaded;

      return Object.assign(loaded, { candidates: topCandidates(tried, query) });
    }

    const candidates = topCandidates(tried, query);
    const status = lastError && candidates.length === 0 ? 'error' : 'notfound';

    this.log.info(
      `未找到歌词: 《${query.title}》/${query.artists.join('、')}` +
        (best ? `（最佳候选评分 ${best.score.toFixed(1)}，低于阈值 ${this.config.minMatchScore}）` : '')
    );

    const result = {
      status,
      reason: status === 'error' ? 'api-error' : 'no-match',
      error: lastError ? lastError.message : null,
      lines: [],
      synced: false,
      candidates,
      bestGuess: best
        ? {
            songId: String(best.song.id),
            name: best.song.name,
            artists: best.song.artists,
            score: Number(best.score.toFixed(1)),
          }
        : null,
    };

    if (status === 'notfound') this._setCached(key, result);
    return result;
  }

  /** 直接按网易云歌曲 ID 取词（用户手动选择时使用） */
  async loadBySongId(songId, track) {
    const key = LyricService.trackCacheKey(track);
    return this._loadBySongId(songId, {
      title: track.title,
      artists: track.artists,
      album: track.album,
      durationSec: track.durationSec,
    }, key);
  }

  async _loadBySongId(songId, query, key, meta) {
    let lyric;
    try {
      lyric = await this.ncm.lyric(songId);
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      this.log.warn(`拉取歌词失败 id=${songId}: ${err.message}`);
      return { status: 'error', reason: 'api-error', error: err.message, lines: [], synced: false };
    }

    if (!lyric.lrc || !lyric.lrc.trim()) {
      const empty = {
        status: 'empty',
        reason: lyric.nolyric ? 'nolyric' : 'no-lyric',
        songId: String(songId),
        songName: meta && meta.song ? meta.song.name : '',
        artists: meta && meta.song ? meta.song.artists : [],
        album: meta && meta.song ? meta.song.album : '',
        score: meta && meta.score ? Number(meta.score.toFixed(1)) : null,
        lines: [],
        synced: false,
      };
      this._setCached(key, empty);
      return empty;
    }

    const parsed = buildLyrics({
      lrc: lyric.lrc,
      tlyric: this.config.translation ? lyric.tlyric : '',
      romalrc: this.config.romaji ? lyric.romalrc : '',
      offsetMs: this._totalOffset(key),
      durationSec: query.durationSec,
      filterCredits: this.config.filterCredits,
      translation: this.config.translation,
      romaji: this.config.romaji,
    });

    const result = {
      status: parsed.lines.length > 0 ? 'found' : 'empty',
      reason: parsed.lines.length > 0 ? 'ok' : 'no-lyric',
      songId: String(songId),
      songName: meta && meta.song ? meta.song.name : '',
      artists: meta && meta.song ? meta.song.artists : [],
      album: meta && meta.song ? meta.song.album : '',
      songDurationSec: meta && meta.song ? meta.song.durationSec : null,
      score: meta && meta.score ? Number(meta.score.toFixed(1)) : null,
      matchedBy: meta ? meta.keywords : null,
      hasTranslation: Boolean(this.config.translation && lyric.tlyric),
      hasRomaji: Boolean(this.config.romaji && lyric.romalrc),
      synced: parsed.synced,
      lines: parsed.lines,
      offsetMs: parsed.offsetMs,
      trackOffsetMs: this.offsets[key] || 0,
    };

    // 原始歌词一并缓存，便于用户调整时间轴偏移时立刻重解析（不用再联网）
    const raw = { lrc: lyric.lrc, tlyric: lyric.tlyric || '', romalrc: lyric.romalrc || '' };
    if (result.status === 'found') this._setCached(key, result, raw);
    return result;
  }
}

/** 构造若干搜索关键词，从精确到宽松依次尝试 */
function buildSearchAttempts(query) {
  const list = [];
  const push = (v) => {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s && !list.includes(s)) list.push(s);
  };

  const title = query.title;
  const primary = (query.artists || [])[0] || '';
  const allArtists = (query.artists || []).join(' ');

  const variants = [title];
  const stripped = title
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, ' ')
    .replace(/\s*[-–—]\s*(live|remaster(ed)?|version|ver|acoustic|instrumental|demo|edit|mix).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped && stripped !== title) variants.push(stripped);

  for (const v of variants) {
    if (primary) push(`${v} ${primary}`);
    push(v);
  }
  if (allArtists && allArtists !== primary) push(`${title} ${allArtists}`);
  if (query.album) push(`${title} ${query.album}`);

  return list.slice(0, 6);
}

/** 去掉内部使用的原始歌词字段，避免通过 WebSocket 发送冗余数据 */
function stripRaw(entry) {
  if (!entry) return entry;
  if (!entry.raw) return entry;
  const copy = Object.assign({}, entry);
  delete copy.raw;
  return copy;
}

function topCandidates(songs, query, limit = 8) {
  const seen = new Set();
  const scored = [];
  for (const song of songs) {
    if (seen.has(song.id)) continue;
    seen.add(song.id);
    scored.push({ song, ...pickBest([song], query) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => ({
    songId: String(entry.song.id),
    name: entry.song.name,
    artists: entry.song.artists,
    album: entry.song.album,
    durationSec: entry.song.durationSec,
    score: Number(entry.score.toFixed(1)),
  }));
}

module.exports = { LyricService, buildSearchAttempts, topCandidates };
