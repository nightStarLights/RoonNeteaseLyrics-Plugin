'use strict';

/**
 * 内置库模式（可选组件）：在进程内直接调用 NeteaseCloudMusicApi，不需要外部服务、不占端口。
 *
 *   const { cloudsearch, lyric } = require('NeteaseCloudMusicApi')
 *   const res = await cloudsearch({ keywords, type: 1, limit })
 *   res -> { status, body, cookie: [...] }
 *
 * ⚠️ 这个包**不是本项目的依赖**，package.json 里刻意没有列它。
 * 上游仓库 Binaryify/NeteaseCloudMusicApi 已经 Public archive（删库归档），
 * 为了不再向下游分发这个依赖，这里改成「本机装了才启用」：
 *
 *     cd extension && npm install NeteaseCloudMusicApi
 *
 * 不装也完全可用——默认的「官方直连」数据源不依赖任何依赖包，
 * auto 模式下内置库缺席会自动走直连。
 *
 * 实测不需要登录 Cookie，也不依赖启动时的 generateConfig（匿名 token 为空同样可用）。
 */

const { NcmError, normalizeSong } = require('./ncm');

const SESSION_KEYS = ['MUSIC_A', 'MUSIC_U', 'MUSIC_R_U', '__csrf'];

function parseCookie(str) {
  const out = {};
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new NcmError(`${label} 请求超时（${ms}ms）`, 'NETWORK')), ms);
      if (timer.unref) timer.unref();
    }),
  ]);
}

class LibClient {
  constructor({ cookie = '', timeoutMs = 8000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.cookie = parseCookie(cookie);
    this.api = null;
    this._unavailable = null;
  }

  get origin() {
    return '内置 NeteaseCloudMusicApi 库（进程内调用）';
  }

  /** 本机是否装了可选的内置库（不触发加载，只看能不能解析到） */
  static isInstalled() {
    try {
      // eslint-disable-next-line global-require
      require.resolve('NeteaseCloudMusicApi');
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 懒加载：377 个接口模块，首次调用时才 require */
  _load() {
    if (this.api) return this.api;
    if (this._unavailable) throw new NcmError(this._unavailable, 'LOAD');

    try {
      // eslint-disable-next-line global-require
      this.api = require('NeteaseCloudMusicApi');
    } catch (err) {
      // 区分「没装（正常情况，可选组件）」和「装了但加载失败（真出问题了）」
      this._unavailable =
        err && err.code === 'MODULE_NOT_FOUND'
          ? '未安装可选的「内置库」。需要的话执行：cd extension && npm install NeteaseCloudMusicApi；不装也能用「官方直连」数据源'
          : `内置库加载失败：${err.message}`;
      throw new NcmError(this._unavailable, 'LOAD');
    }

    return this.api;
  }

  _absorb(setCookies) {
    for (const raw of setCookies) {
      const head = String(raw).split(';')[0];
      const i = head.indexOf('=');
      if (i <= 0) continue;
      const key = head.slice(0, i).trim();
      const value = head.slice(i + 1).trim();
      if (SESSION_KEYS.includes(key) && value) this.cookie[key] = value;
    }
  }

  async _call(name, params) {
    const api = this._load();
    const fn = api[name];

    if (typeof fn !== 'function') {
      throw new NcmError(`NeteaseCloudMusicApi 未导出接口 ${name}`, 'LOAD');
    }

    const options = Object.assign({}, params);
    if (Object.keys(this.cookie).length > 0) options.cookie = this.cookie;

    let res;
    try {
      res = await withTimeout(Promise.resolve(fn(options)), this.timeoutMs, name);
    } catch (err) {
      if (err instanceof NcmError) throw err;
      const detail = err && err.body ? ` (code=${err.body.code || err.status})` : '';
      throw new NcmError(`调用 ${name} 失败${detail}`, 'NETWORK');
    }

    if (res && Array.isArray(res.cookie) && res.cookie.length > 0) {
      this._absorb(res.cookie);
    }

    const body = res && res.body ? res.body : res;
    if (body && typeof body.code === 'number' && body.code !== 200) {
      throw new NcmError(`网易云接口 ${name} 返回 code=${body.code}`, 'API');
    }

    return body || {};
  }

  /** 健康检查 */
  async ping() {
    try {
      await this.search('海阔天空', 1);
      return true;
    } catch (err) {
      return false;
    }
  }

  async search(keywords, limit = 10) {
    const body = await this._call('cloudsearch', {
      keywords,
      type: 1,
      offset: 0,
      limit: Math.min(100, Math.max(1, limit)),
    });

    const songs = (body.result && body.result.songs) || [];
    return songs.map(normalizeSong).filter(Boolean);
  }

  async lyric(songId) {
    const body = await this._call('lyric', { id: songId });

    const pick = (field) => (field && typeof field.lyric === 'string' ? field.lyric : '');

    return {
      lrc: pick(body.lrc),
      tlyric: pick(body.tlyric) || pick(body.ytlrc),
      romalrc: pick(body.romalrc) || pick(body.yromalrc),
      nolyric: Boolean(body.nolyric),
      uncollected: Boolean(body.uncollected),
    };
  }
}

module.exports = { LibClient };
