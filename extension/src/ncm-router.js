'use strict';

const { NcmClient, NcmError } = require('./ncm');
const { DirectClient } = require('./ncm-direct');
const { LibClient } = require('./ncm-lib');

/**
 * 歌词数据源路由。三种数据源：
 *
 *   lib     内置 NeteaseCloudMusicApi 库（进程内调用，**可选组件**：
 *           package.json 里没有这个依赖，上游仓库已归档，需要自己
 *           npm install NeteaseCloudMusicApi 才会启用）
 *   direct  网易云官方公开接口直连（不依赖任何依赖包，默认兜底）
 *   ncm     外部独立运行的 NeteaseCloudMusicApi 服务（需要自己部署，选填）
 *
 * lyricSource 取值：
 *   "auto"   内置库可用就用它，否则自动回退官方直连（推荐，也是默认值）
 *   "lib"    只用内置库
 *   "direct" 只用官方直连
 *   "ncm"    只用外部独立服务
 *
 * 对外暴露与 NcmClient 相同的接口（search / lyric / origin），
 * 上层 LyricService 不需要关心具体走哪条路。
 */
class NcmRouter {
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger;

    this.clients = {
      lib: new LibClient({
        cookie: config.cookie,
        timeoutMs: config.ncmTimeoutMs,
      }),
      direct: new DirectClient({
        cookie: config.cookie,
        timeoutMs: config.ncmTimeoutMs,
        userAgent: config.directUserAgent,
      }),
      ncm: new NcmClient({
        baseUrl: config.ncmApi,
        cookie: config.cookie,
        timeoutMs: config.ncmTimeoutMs,
      }),
    };

    this.labels = {
      lib: '内置库（可选，需自行安装）',
      direct: '网易云官方接口（直连，免安装）',
      ncm: '本机 NeteaseCloudMusicApi 服务',
    };

    this.configured = config.lyricSource;
    this.online = { lib: null, direct: null, ncm: null };
    this.active = null;
    this.lastError = null;
    this.lastSwitchReason = '尚未探测';
  }

  /** auto 模式下的尝试顺序 */
  get chain() {
    if (this.configured === 'auto') return ['lib', 'direct'];
    return [this.configured];
  }

  get current() {
    return this.active ? this.clients[this.active] : null;
  }

  get origin() {
    if (this.current) return this.current.origin;
    return this.clients[this.chain[0]].origin;
  }

  get isOnline() {
    return this.active !== null;
  }

  status() {
    return {
      configured: this.configured,
      active: this.active,
      activeLabel: this.active ? this.labels[this.active] : '不可用',
      online: this.isOnline,
      error: this.lastError,
      reason: this.lastSwitchReason,
      targets: ['lib', 'direct', 'ncm'].map((id) => ({
        id,
        label: this.labels[id],
        url: this.clients[id].origin,
        online: this.online[id],
        used: this.chain.includes(id),
      })),
    };
  }

  /**
   * 运行时改配置（桌面端设置面板里改数据源 / 外部服务地址）。
   * @returns {boolean} 是否有实际变化
   */
  updateConfig({ ncmApi, lyricSource }) {
    let changed = false;

    if (ncmApi && String(ncmApi) !== this.clients.ncm.baseUrl) {
      this.clients.ncm.baseUrl = String(ncmApi).replace(/\/+$/, '');
      this.config.ncmApi = this.clients.ncm.baseUrl;
      changed = true;
      this.log.info(`外部 NCM API 地址已改为 ${this.clients.ncm.baseUrl}`);
    }

    const next = String(lyricSource || '').toLowerCase();
    if (next && ['auto', 'lib', 'direct', 'ncm'].includes(next) && next !== this.configured) {
      this.configured = next;
      this.config.lyricSource = next;
      changed = true;
      this.log.info(`歌词数据源已改为 ${next}`);
    }

    if (changed) {
      this.online = { lib: null, direct: null, ncm: null };
      this.active = null;
      this._warnedLibMissing = false;
    }
    return changed;
  }

  /** 探测可用性并决定实际数据源，返回状态是否发生变化 */
  async refresh() {
    const before = `${this.active}|${JSON.stringify(this.online)}`;
    const tried = [];

    this.active = null;
    this.online = { lib: null, direct: null, ncm: null };

    for (const id of this.chain) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.clients[id].ping();
      this.online[id] = ok;
      tried.push(`${this.labels[id]}:${ok ? '可用' : '不可用'}`);

      if (ok) {
        this.active = id;
        break;
      }

      if (id === 'lib' && !LibClient.isInstalled()) {
        // 没装内置库是正常情况（它就是可选组件），提示一次即可，别每次探测都刷警告
        if (!this._warnedLibMissing) {
          this._warnedLibMissing = true;
          this.log.info(
            '未安装可选的「内置库」，改用官方直连（想启用：cd extension && npm install NeteaseCloudMusicApi）'
          );
        }
      } else if (this.chain.length > 1) {
        this.log.warn(`${this.labels[id]} 不可用，尝试下一个数据源…`);
      }
    }

    if (this.active) {
      this.lastError = null;
      this.lastSwitchReason =
        this.active === this.chain[0]
          ? `使用${this.labels[this.active]}`
          : `${this.labels[this.chain[0]]}不可用，已自动切换到${this.labels[this.active]}`;
    } else {
      this.lastError = '没有可用的歌词数据源';
      this.lastSwitchReason = `全部数据源不可用（${tried.join('，')}）`;
    }

    const after = `${this.active}|${JSON.stringify(this.online)}`;
    const changed = before !== after;

    if (changed) {
      if (this.active) {
        this.log.info(`歌词数据源: ${this.labels[this.active]} —— ${this.lastSwitchReason}`);
      } else {
        this.log.warn(`歌词数据源不可用: ${this.lastSwitchReason}`);
        if (this.chain.includes('lib') && !LibClient.isInstalled()) {
          this.log.warn(
            '  可选的「内置库」没有安装：cd extension && npm install NeteaseCloudMusicApi'
          );
        }
      }
    }

    return changed;
  }

  async search(keywords, limit) {
    return this._run('search', (client) => client.search(keywords, limit));
  }

  async lyric(songId) {
    return this._run('lyric', (client) => client.lyric(songId));
  }

  /**
   * 按当前选中的数据源执行；auto 模式下当前源突然失效时，
   * 立刻重新探测并重试一次。
   */
  async _run(action, fn) {
    const first = this.current || this.clients[this.chain[0]];

    try {
      return await fn(first);
    } catch (err) {
      const isNetwork = err instanceof NcmError && ['NETWORK', 'HTTP', 'LOAD'].includes(err.code);
      if (!isNetwork || this.chain.length === 1) throw err;

      this.log.warn(`${action} 在「${this.labels[this.active || this.chain[0]]}」上失败，重新探测数据源…`);
      await this.refresh();

      const second = this.current;
      if (!second || second === first) throw err;
      return fn(second);
    }
  }
}

module.exports = { NcmRouter };
