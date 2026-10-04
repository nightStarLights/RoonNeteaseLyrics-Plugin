'use strict';

/**
 * NeteaseCloudMusicApi 客户端（只用到搜索与歌词两个接口）。
 * 期望本地已运行 https://github.com/Binaryify/NeteaseCloudMusicApi
 */

class NcmError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NcmError';
    this.code = code;
  }
}

class NcmClient {
  constructor({ baseUrl, cookie, timeoutMs = 8000 }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.cookie = cookie || '';
    this.timeoutMs = timeoutMs;
  }

  get origin() {
    return this.baseUrl;
  }

  async request(pathname, params = {}) {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    if (this.cookie) {
      url.searchParams.set('cookie', this.cookie);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      throw new NcmError(
        err.name === 'AbortError' ? `请求超时（${this.timeoutMs}ms）` : `无法连接网易云 API：${err.message}`,
        'NETWORK'
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new NcmError(`网易云 API 返回 HTTP ${res.status}`, 'HTTP');
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new NcmError('网易云 API 返回的不是合法 JSON', 'PARSE');
    }

    if (typeof data.code === 'number' && data.code !== 200) {
      throw new NcmError(`网易云接口 ${pathname} 返回 code=${data.code}`, 'API');
    }

    return data;
  }

  /** 健康检查 */
  async ping() {
    const url = new URL(this.baseUrl + '/search');
    url.searchParams.set('keywords', '海阔天空');
    url.searchParams.set('type', '1');
    url.searchParams.set('limit', '1');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5000));
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res.ok;
    } catch (err) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 搜索单曲。
   * @returns {Promise<Array>} 归一化后的候选曲目
   */
  async search(keywords, limit = 10) {
    const data = await this.request('/cloudsearch', { keywords, type: 1, limit, offset: 0 });
    const songs = (data.result && data.result.songs) || [];
    return songs.map(normalizeSong).filter(Boolean);
  }

  /** 获取歌词 */
  async lyric(songId) {
    const data = await this.request('/lyric', { id: songId });
    return {
      lrc: (data.lrc && data.lrc.lyric) || '',
      tlyric: (data.tlyric && data.tlyric.lyric) || '',
      romalrc: (data.romalrc && data.romalrc.lyric) || '',
      nolyric: Boolean(data.nolyric),
      uncollected: Boolean(data.uncollected),
    };
  }
}

function normalizeSong(song) {
  if (!song || !song.id) return null;
  const artists = (song.ar || song.artists || []).map((a) => a && a.name).filter(Boolean);
  const album = song.al || song.album || {};
  return {
    id: song.id,
    name: song.name || song.title || '',
    artists,
    album: album.name || '',
    albumId: album.id || null,
    durationSec: Math.round((song.dt || song.duration || 0) / 1000),
    fee: song.fee,
  };
}

module.exports = { NcmClient, NcmError, normalizeSong };
