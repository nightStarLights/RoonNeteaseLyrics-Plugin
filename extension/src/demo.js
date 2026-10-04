'use strict';

const { EventEmitter } = require('events');

/**
 * 演示数据源：在没有 Roon Core 的环境下模拟播放，
 * 用于联调桌面歌词窗口（node index.js --demo）。
 */
const PLAYLIST = [
  { title: '海阔天空', artists: ['Beyond'], album: '海阔天空', durationSec: 326 },
  { title: '夜に駆ける', artists: ['YOASOBI'], album: 'THE BOOK', durationSec: 261 },
  { title: '晴天', artists: ['周杰伦'], album: '叶惠美', durationSec: 269 },
];

class DemoSource extends EventEmitter {
  constructor({ config, logger, nowPlaying, secondsPerSong = 45 }) {
    super();
    this.config = config;
    this.log = logger;
    this.nowPlaying = nowPlaying;
    this.secondsPerSong = secondsPerSong;
    this.index = -1;
    this.elapsed = 0;
    this.timer = null;
    this.zones = new Map([
      ['demo-zone', { zone_id: 'demo-zone', display_name: 'Demo 播放区', state: 'playing' }],
    ]);
  }

  start() {
    this.log.warn('已启用演示模式（--demo），曲目信息为模拟数据');
    this._next();
    this.timer = setInterval(() => this._tick(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  _tick() {
    this.elapsed += 1;
    if (this.elapsed >= this.secondsPerSong) {
      this._next();
      return;
    }
    const track = PLAYLIST[this.index];
    this.nowPlaying.updateFromZone({
      zone_id: 'demo-zone',
      display_name: 'Demo 播放区',
      state: 'playing',
      now_playing: {
        seek_position: this.elapsed,
        length: track.durationSec,
        image_key: null,
        three_line: {
          line1: track.title,
          line2: track.artists.join(' / '),
          line3: track.album,
        },
      },
    });
  }

  _next() {
    this.index = (this.index + 1) % PLAYLIST.length;
    this.elapsed = 0;
    const track = PLAYLIST[this.index];

    const result = this.nowPlaying.updateFromZone({
      zone_id: 'demo-zone',
      display_name: 'Demo 播放区',
      state: 'playing',
      now_playing: {
        seek_position: 0,
        length: track.durationSec,
        image_key: null,
        three_line: {
          line1: track.title,
          line2: track.artists.join(' / '),
          line3: track.album,
        },
      },
    });

    if (result.trackChanged) this.emit('track', this.nowPlaying.track());
    this.emit('update');
  }

  snapshot() {
    return { paired: true, status: 'demo', message: '演示模式', coreName: 'Demo Core', zones: [...this.zones.values()], currentZoneId: 'demo-zone' };
  }

  getImage() {
    return Promise.resolve(null);
  }
}

module.exports = { DemoSource };
