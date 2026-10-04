'use strict';

/**
 * 直连模式：不依赖 NeteaseCloudMusicApi，直接调用网易云官方公开接口。
 * 接口参考 https://github.com/XBisATrouble/netease-music-plugin 的 direct 模式。
 *
 *  搜索: GET  https://music.163.com/api/search/get/web?s=&type=1&offset=0&limit=&total=true
 *  歌词: GET  https://music.163.com/api/song/lyric?id=&lv=-1&kv=-1&tv=-1
 *        （备用 POST https://interface3.music.163.com/api/song/lyric）
 *
 * 实测不需要登录 Cookie 也能拿到歌词与翻译；填写 MUSIC_U 可提高冷门曲目的命中率。
 */

const { NcmError, normalizeSong } = require('./ncm');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_COOKIE = 'os=pc; appver=8.9.75;';

const SEARCH_URLS = [
  'https://music.163.com/api/search/get/web',
  'https://music.163.com/api/search/get',
];
const LYRIC_URL = 'https://music.163.com/api/song/lyric';
const LYRIC_FALLBACK_URL = 'https://interface3.music.163.com/api/song/lyric';

class DirectClient {
  constructor({ cookie = '', timeoutMs = 8000, userAgent = '' } = {}) {
    this.cookie = cookie || '';
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent || DEFAULT_UA;
  }

  get origin() {
    return 'https://music.163.com (直连)';
  }

  get headers() {
    return {
      'User-Agent': this.userAgent,
      Referer: 'https://music.163.com/',
      Accept: '*/*',
      Cookie: this.cookie ? `${BASE_COOKIE} ${this.cookie}` : BASE_COOKIE,
    };
  }

  async _request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await fetch(url, Object.assign({}, options, {
        headers: Object.assign({}, this.headers, options.headers || {}),
        signal: controller.signal,
      }));
    } catch (err) {
      throw new NcmError(
        err.name === 'AbortError' ? `请求超时（${this.timeoutMs}ms）` : `无法连接网易云官方接口：${err.message}`,
        'NETWORK'
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new NcmError(`网易云官方接口返回 HTTP ${res.status}`, 'HTTP');
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new NcmError('网易云官方接口返回的不是合法 JSON', 'PARSE');
    }

    if (typeof data.code === 'number' && data.code !== 200) {
      throw new NcmError(`网易云官方接口返回 code=${data.code}`, 'API');
    }

    return data;
  }

  /** 健康检查：跑一次最小搜索 */
  async ping() {
    try {
      await this.search('test', 1);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * 搜索单曲。官方接口字段为 artists / album / duration，
   * normalizeSong 会统一成与 NCM API 一致的结构。
   */
  async search(keywords, limit = 10) {
    let lastError = null;

    for (const base of SEARCH_URLS) {
      const url = new URL(base);
      url.searchParams.set('s', keywords);
      url.searchParams.set('type', '1');
      url.searchParams.set('offset', '0');
      url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
      url.searchParams.set('total', 'true');

      try {
        const data = await this._request(url.toString());
        const songs = (data.result && data.result.songs) || [];
        return songs.map(normalizeSong).filter(Boolean);
      } catch (err) {
        lastError = err;
        if (err.code === 'NETWORK') break;
      }
    }

    throw lastError || new NcmError('直连搜索失败', 'API');
  }

  /** 获取歌词 */
  async lyric(songId) {
    let lastError = null;

    // 主接口：GET，返回干净的 LRC + tlyric
    try {
      const url = new URL(LYRIC_URL);
      url.searchParams.set('id', String(songId));
      url.searchParams.set('lv', '-1');
      url.searchParams.set('kv', '-1');
      url.searchParams.set('tv', '-1');
      url.searchParams.set('rv', '-1');
      const data = await this._request(url.toString());
      return toLyricResult(data);
    } catch (err) {
      lastError = err;
      if (err.code === 'NETWORK') throw err;
    }

    // 备用接口：interface3 + POST 表单
    try {
      const data = await this._request(LYRIC_FALLBACK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: this.cookie
            ? `os=osx; osver=MacOS-14.3.1-arm; appver=2.0.3.131777; ${this.cookie}`
            : 'os=osx; osver=MacOS-14.3.1-arm; appver=2.0.3.131777',
        },
        body: `id=${encodeURIComponent(songId)}&cp=false&tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0`,
      });
      return toLyricResult(data);
    } catch (err) {
      throw lastError || err;
    }
  }
}

function pick(field) {
  return (field && typeof field.lyric === 'string' && field.lyric) || '';
}

function toLyricResult(data) {
  return {
    lrc: pick(data.lrc),
    tlyric: pick(data.tlyric) || pick(data.ytlrc),
    romalrc: pick(data.romalrc) || pick(data.yromalrc),
    nolyric: Boolean(data.nolyric),
    uncollected: Boolean(data.uncollected),
  };
}

module.exports = { DirectClient };
