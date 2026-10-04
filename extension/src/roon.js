'use strict';

const { EventEmitter } = require('events');

const RoonApi = require('node-roon-api');
const RoonApiStatus = require('node-roon-api-status');
const RoonApiTransport = require('node-roon-api-transport');
const RoonApiImage = require('node-roon-api-image');

const EXTENSION_ID = 'com.roon2ncm.lyrics';
const DISPLAY_NAME = '网易云歌词 (NetEase Lyrics)';
const DISPLAY_VERSION = '1.0.0';

/**
 * 连接 Roon Core、订阅播放区、把信息推给 NowPlaying。
 */
class RoonBridge extends EventEmitter {
  constructor({ config, logger, nowPlaying }) {
    super();
    this.config = config;
    this.log = logger;
    this.nowPlaying = nowPlaying;

    this.core = null;
    this.transport = null;
    this.image = null;
    nowPlaying.debug = (msg) => logger.debug(msg);
    this.zones = new Map();
    this.paired = false;
    this.currentZoneId = null;
    this.status = 'starting';

    this.roon = new RoonApi({
      extension_id: EXTENSION_ID,
      display_name: DISPLAY_NAME,
      display_version: DISPLAY_VERSION,
      publisher: 'Roon2NCMAPI',
      email: 'roon2ncmapi@localhost',
      website: 'https://github.com/roonlabs/node-roon-api',
      log_level: config.roonLogLevel || 'none',

      core_paired: (core) => this._onPaired(core),
      core_unpaired: (core) => this._onUnpaired(core),
    });
  }

  start() {
    this.statusSvc = new RoonApiStatus(this.roon);

    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiImage],
      provided_services: [this.statusSvc],
    });

    this.statusSvc.set_status('正在启动…', false);
    this.roon.start_discovery();
    this._setStatus('discovering', '正在搜索 Roon Core…');
  }

  _setStatus(status, message) {
    this.status = status;
    this.statusMessage = message;
    this.emit('status', { status, message });
  }

  _onPaired(core) {
    this.core = core;
    this.paired = true;
    this.transport = core.services.RoonApiTransport;
    this.image = core.services.RoonApiImage;

    this.log.info(`已配对 Roon Core: ${core.display_name} (${core.core_id})`);
    this.statusSvc.set_status(`已连接 ${core.display_name}`, false);
    this._setStatus('paired', `已连接 ${core.display_name}`);

    this.transport.subscribe_zones((response, data) => {
      if (response === 'Subscribed') {
        this.zones.clear();
        for (const zone of data.zones || []) this.zones.set(zone.zone_id, zone);
        this.log.info(`已订阅 ${this.zones.size} 个播放区: ${[...this.zones.values()].map((z) => z.display_name).join(', ')}`);
        this._onZonesChanged(true);
      } else if (response === 'Changed') {
        if (data.zones_added) for (const z of data.zones_added) this.zones.set(z.zone_id, z);
        if (data.zones_changed) for (const z of data.zones_changed) this.zones.set(z.zone_id, z);
        if (data.zones_removed) for (const z of data.zones_removed) this.zones.delete(z.zone_id);
        if (data.zones_seek_changed) {
          for (const z of data.zones_seek_changed) {
            const zone = this.zones.get(z.zone_id);
            if (zone && zone.now_playing) zone.now_playing.seek_position = z.seek_position;
            this.nowPlaying.updateSeek(z);
          }
        }
        this._onZonesChanged(false, data);
      } else if (response === 'Unsubscribed') {
        this.zones.clear();
        this.log.warn('Roon 已取消订阅 zones');
      }
    });
  }

  _onUnpaired(core) {
    this.log.warn(`Roon Core 断开: ${core && core.display_name}`);
    this.paired = false;
    this.core = null;
    this.transport = null;
    this.zones.clear();
    this.currentZoneId = null;
    this._setStatus('discovering', 'Roon Core 已断开，正在重新搜索…');
    if (this.statusSvc) this.statusSvc.set_status('Roon Core 已断开', true);
  }

  _onZonesChanged(isInitial, data) {
    // 播放区列表有增减就往上抛一次，界面要能知道 Roon 里到底有哪些设备。
    // 注意配对成功时 zones 还没订阅回来，那时候广播出去的列表是空的，
    // 所以不能只在状态变化时推。
    const listChanged = Boolean(
      isInitial ||
        (data &&
          ((data.zones_added && data.zones_added.length) ||
            (data.zones_removed && data.zones_removed.length)))
    );

    const zone = this._pickZone();
    if (!zone) {
      if (isInitial) this.log.warn('没有找到可用的播放区');
      this.nowPlaying.zoneId = null;
      this.nowPlaying.zoneName = null;
      if (listChanged) this.emit('zones', this.snapshot());
      return;
    }

    const zoneChanged = zone.zone_id !== this.currentZoneId;
    if (zoneChanged) {
      this.currentZoneId = zone.zone_id;
      this.log.info(`当前监听播放区: ${zone.display_name}`);
      this.emit('zone', { zoneId: zone.zone_id, zoneName: zone.display_name });
    }

    const result = this.nowPlaying.updateFromZone(zone);

    if (result.trackChanged) {
      this.log.info(`曲目切换: 《${this.nowPlaying.title}》 - ${this.nowPlaying.artists.join('、')}`);
      this.emit('track', this.nowPlaying.track());
    } else if (result.stateChanged || zoneChanged) {
      this.emit('state', { state: this.nowPlaying.state });
    }
    this.emit('update');
    if (listChanged) this.emit('zones', this.snapshot());
  }

  /**
   * 配置里指定的播放区变了：立刻重新选一次，
   * 不用等下一次 Roon 推送（用户在设置里换设备后应当马上生效）。
   */
  refreshZone() {
    if (!this.paired || this.zones.size === 0) return;
    this._warnedZone = false;
    this._onZonesChanged(false);
  }

  /** 选择要监听的播放区 */
  _pickZone() {
    const list = [...this.zones.values()];
    if (list.length === 0) return null;

    const wanted = (this.config.zone || '').trim().toLowerCase();
    if (wanted) {
      const match =
        list.find((z) => String(z.display_name || '').toLowerCase() === wanted) ||
        list.find((z) => String(z.display_name || '').toLowerCase().includes(wanted));
      if (match) return match;
      if (!this._warnedZone) {
        this._warnedZone = true;
        this.log.warn(`配置的播放区 "${this.config.zone}" 不存在，已改为自动选择正在播放的区`);
      }
    }

    const current = this.currentZoneId ? this.zones.get(this.currentZoneId) : null;

    // 优先级：正在播放 > 当前区 > 暂停 > 任何有曲目信息的区
    const playing = list.filter((z) => z.state === 'playing' && z.now_playing);
    if (playing.length > 0) {
      if (current && current.state === 'playing' && current.now_playing) return current;
      return playing[0];
    }

    if (current && current.now_playing) return current;

    const paused = list.filter((z) => z.state === 'paused' && z.now_playing);
    if (paused.length > 0) return paused[0];

    const withNp = list.find((z) => z.now_playing);
    if (withNp) return withNp;

    return current || list[0];
  }

  /**
   * 主动向 Roon 拉一次最新的播放区数据（用户点「对齐时间轴」时使用）。
   * 只在真正播放的区上会带回实时的 seek_position。
   */
  refreshZones() {
    return new Promise((resolve) => {
      if (!this.transport) {
        resolve(false);
        return;
      }
      this.transport.get_zones((err, body) => {
        if (!err && body && Array.isArray(body.zones)) {
          for (const zone of body.zones) this.zones.set(zone.zone_id, zone);
          this._onZonesChanged(false);
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  /** 取当前曲目的封面图 */
  getImage(imageKey, opts = {}) {
    return new Promise((resolve) => {
      if (!this.image || !imageKey) {
        resolve(null);
        return;
      }
      const options = Object.assign({ scale: 'fit', width: 600, height: 600, format: 'image/jpeg' }, opts);
      try {
        this.image.get_image(imageKey, options, (err, contentType, body) => {
          if (err || !body) {
            resolve(null);
            return;
          }
          resolve({ contentType: contentType || 'image/jpeg', body });
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  snapshot() {
    return {
      paired: this.paired,
      status: this.status,
      message: this.statusMessage || null,
      coreName: this.core ? this.core.display_name : null,
      zones: [...this.zones.values()].map((z) => ({
        id: z.zone_id,
        name: z.display_name,
        state: z.state,
      })),
      currentZoneId: this.currentZoneId,
    };
  }
}

module.exports = { RoonBridge, EXTENSION_ID, DISPLAY_NAME };
