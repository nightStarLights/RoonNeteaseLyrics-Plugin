'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

/**
 * 当前播放状态：把 Roon 的 zone 对象归一化成前端好用的结构，
 * 并在两次 Roon 更新之间用本地时钟推算播放进度。
 */
class NowPlaying extends EventEmitter {
  constructor({ progressIntervalMs = 400 } = {}) {
    super();

    this.progressIntervalMs = progressIntervalMs;

    this.zoneId = null;
    this.zoneName = null;
    this.state = 'idle'; // idle | stopped | paused | playing | loading
    this.title = '';
    this.artists = [];
    this.album = '';
    this.durationSec = 0;
    this.imageKey = null;
    this.trackId = null;
    this.trackChangedAt = 0;

    this._basePosition = 0;
    this._baseAt = Date.now();
    this._lastReportedSeek = null;
    this._lastSeekAt = null;
    this._pendingBackward = null;
    // 每次发生「用户主动跳转」类的位置变化就自增，客户端据此允许位置跳变
    this.seekSeq = 0;
    this.history = [];

    // 卡顿检测：Roon 上报值的变化间隔（指数滑动平均）与最近一次变化时刻
    this._reportIntervalMs = 1000;
    this._seekAdvanceAt = null;
    this._stallState = 'idle';
    this._frozen = false;
    this._frozenPosition = 0;

    this.lyrics = null;
    this.lyricsStatus = 'idle'; // idle | searching | found | notfound | empty | error
    this.lyricsError = null;

    this._timer = null;
  }

  /** 播放位置（秒）。卡顿时冻结在最后一次上报值附近，不再外推。 */
  get position() {
    if (this._frozen) return this._frozenPosition;
    if (this.state !== 'playing') return this._basePosition;
    const elapsed = (Date.now() - this._baseAt) / 1000;
    const pos = this._basePosition + Math.max(0, elapsed);
    return this.durationSec > 0 ? Math.min(pos, this.durationSec) : pos;
  }

  /** Roon 上报 seek_position 的典型间隔（毫秒），未测到时按 1 秒估 */
  get reportIntervalMs() {
    return this._reportIntervalMs > 0 ? this._reportIntervalMs : 1000;
  }

  /** 多久没看到上报值推进就认为音频卡住了 */
  get stallThresholdMs() {
    return Math.max(2000, this.reportIntervalMs * 2.5);
  }

  /** 卡顿时允许本地时钟最多超出最后一次上报值多少秒 */
  get stallAllowanceSec() {
    return Math.max(1.2, (this.reportIntervalMs * 1.3) / 1000);
  }

  get stalled() {
    return this._frozen;
  }

  /** 记录一次 Roon 上报值，并统计上报间隔 */
  _setReportedSeek(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;

    const now = Date.now();
    if (value !== this._lastReportedSeek) {
      // 只在播放中统计上报间隔：暂停期间计时会一直刷新，混进来会把间隔算小
      if (this._seekAdvanceAt && this.state === 'playing') {
        const dt = now - this._seekAdvanceAt;
        if (dt >= 100 && dt <= 15000) {
          this._reportIntervalMs = Math.round(this._reportIntervalMs * 0.6 + dt * 0.4);
        }
      }
      this._seekAdvanceAt = now;
      this._lastReportedSeek = value;
    }
  }

  /**
   * 卡顿检测。音频卡住时 Roon 仍然报 playing，但 seek_position 会停止推进，
   * 此时如果继续用本地时钟外推，歌词就会一路跑到前面去。
   * 所以长时间（stallThresholdMs）没看到上报值推进就冻结进度，
   * 冻结位置最多只比最后一次上报值多 stallAllowanceSec。
   */
  _updateStall() {
    const now = Date.now();

    // 播放状态发生变化（尤其是 暂停 → 播放）时重置计时。
    // Roon 在暂停期间不会推进 seek_position，恢复播放时上报的往往还是暂停前的
    // 同一秒；不重置就会把整段暂停时间算成「上报值没推进」，
    // 一恢复就误报「音频缓冲中，歌词已暂停」。
    if (this.state !== this._stallState) {
      this._stallState = this.state;
      this._seekAdvanceAt = now;
    }

    // 没在播放（暂停 / 停止）时不参与卡顿判定，并且持续刷新计时，
    // 这样恢复播放时不会带着暂停期间累积的时间
    if (this.state !== 'playing') {
      this._seekAdvanceAt = now;
      this._unfreeze(now);
      return;
    }

    if (this._lastReportedSeek === null || this._seekAdvanceAt === null) {
      this._unfreeze(now);
      return;
    }

    const quietMs = now - this._seekAdvanceAt;

    if (quietMs > this.stallThresholdMs) {
      if (!this._frozen) {
        const cap = Math.max(0, this._lastReportedSeek + this.stallAllowanceSec);
        const running = this._basePosition + (now - this._baseAt) / 1000;
        this._frozenPosition = Math.max(0, Math.min(running, cap));
        this._frozen = true;
        this._record('stall', {
          quietMs,
          frozenAt: Number(this._frozenPosition.toFixed(3)),
          cap: Number(cap.toFixed(3)),
        });
      }
      return;
    }

    this._unfreeze(now);
  }

  _unfreeze(now) {
    if (!this._frozen) return;
    // 解冻：从冻结位置重新起步，别把卡顿期间的时间算进去
    this._basePosition = Math.max(0, this._frozenPosition);
    this._baseAt = now;
    this._frozen = false;
    this._record('unfreeze');
  }

  setLyrics(status, lyrics, error = null) {
    this.lyricsStatus = status;
    this.lyrics = lyrics ? Object.assign({}, lyrics, { status }) : null;
    this.lyricsError = error || (this.lyrics && this.lyrics.error) || null;
    this.emit('lyrics', this.lyricsPayload());
    this.emit('change');
  }

  lyricsPayload() {
    if (!this.lyrics) {
      return { status: this.lyricsStatus, error: this.lyricsError, lines: [], synced: false };
    }
    return this.lyrics;
  }

  /** Roon zone 数据 -> 内部状态，返回 {trackChanged, stateChanged} */
  updateFromZone(zone) {
    if (!zone) return { trackChanged: false, stateChanged: false };

    this.zoneId = zone.zone_id || this.zoneId;
    this.zoneName = zone.display_name || this.zoneName;

    const np = zone.now_playing;
    const prevTrackId = this.trackId;
    const prevState = this.state;

    if (!np) {
      this.state = zone.state === 'stopped' ? 'stopped' : 'idle';
      this.trackId = null;
      this.title = '';
      this.artists = [];
      this.album = '';
      this.durationSec = 0;
      this.imageKey = null;
      this._basePosition = 0;
      this._baseAt = Date.now();
      return { trackChanged: prevTrackId !== null, stateChanged: prevState !== this.state };
    }

    const three = np.three_line || {};
    const two = np.two_line || {};
    const one = np.one_line || {};

    const title = (three.line1 || two.line1 || one.line1 || '').trim();
    const artistLine = (three.line2 || two.line2 || '').trim();
    const album = (three.line3 || '').trim();

    this.title = title;
    this.artists = splitArtists(artistLine);
    this.album = album;
    this.durationSec = Number(np.length) > 0 ? Number(np.length) : 0;
    this.imageKey = np.image_key || null;
    this.state = zone.state || 'idle';

    // 曲目标识只用元信息计算，**不要用 image_key**。
    // 同一张专辑的多首曲目封面相同，Roon 返回的 image_key 也可能是同一个，
    // 用它判断换曲会让后面的曲目一直被当成「没换歌」——
    // 表现就是某首歌没匹配到歌词后，后续曲目全都不再重新匹配。
    const trackId = crypto
      .createHash('sha1')
      .update(`${title}|${artistLine}|${album}|${this.durationSec}`)
      .digest('hex')
      .slice(0, 16);

    const trackChanged = trackId !== prevTrackId;
    const stateChanged = prevState !== this.state;
    this.trackId = trackId;

    // 重新锚定播放进度。
    //
    // 注意：Roon 的 zones_changed 里带的 now_playing.seek_position 往往是**滞后**的，
    // 真正实时的进度只在 zones_seek_changed 里推送（见 updateSeek）。
    // 如果每次都无条件采用 zone 里的 seek_position，时间轴会被反复往回调，
    // 表现为「歌词和声音完全对不上」。所以这里分情况处理：
    //   - 换曲 / 播放状态改变：完全信任，重新锚定
    //   - 正在播放：只接受「向前」的修正，滞后的数据一律忽略，靠本地时钟外推
    //   - 暂停 / 停止：直接跟随报告的静止位置
    this._updateStall();

    const reported = typeof np.seek_position === 'number' ? dequantize(np.seek_position) : null;
    if (reported !== null) this._setReportedSeek(reported);

    if (trackChanged) {
      this._basePosition = Math.max(0, reported !== null ? reported : 0);
      this._baseAt = Date.now();
      this.trackChangedAt = Date.now();
      this.seekSeq += 1;
      this.lyrics = null;
      this.lyricsStatus = 'idle';
      this._record('track');
    } else if (stateChanged) {
      this._basePosition = Math.max(0, reported !== null ? reported : this._basePosition);
      this._baseAt = Date.now();
      // 状态切换后旧的「上报值停止推进」计时不再成立（暂停期间 Roon 本就不推进）
      this._seekAdvanceAt = Date.now();
      this._pendingBackward = null;
      this._record('state');
    } else if (reported !== null) {
      if (this.state !== 'playing') {
        this._basePosition = Math.max(0, reported);
        this._baseAt = Date.now();
        this._pendingBackward = null;
      } else {
        const predicted = this._basePosition + (Date.now() - this._baseAt) / 1000;

        if (reported > predicted + 1.5) {
          // 明显靠前：不可能是滞后数据，直接采纳
          this._basePosition = reported;
          this._baseAt = Date.now();
          this._pendingBackward = null;
          this._record('forward', { diff: Number((reported - predicted).toFixed(3)) });
        } else if (reported < predicted - 2) {
          // 靠后：可能是用户往回拖进度条，也可能是 Roon 推来的滞后数据。
          // 滞后数据会反复报同一个值，真实的 seek 之后会继续前进，
          // 所以要求连续两次、且新值比上一次更大才采纳。
          const pending = this._pendingBackward;
          if (pending && reported > pending.value && reported - pending.value <= 6) {
            this._basePosition = Math.max(0, reported);
            this._baseAt = Date.now();
            this._pendingBackward = null;
            this.seekSeq += 1;
          } else {
            this._pendingBackward = { value: reported, at: Date.now() };
          }
        } else {
          this._pendingBackward = null;
        }
      }
    }

    return { trackChanged, stateChanged: prevState !== this.state };
  }

  /**
   * Roon 的 zones_seek_changed 是播放进度的权威来源，用它校准本地外推的时钟。
   *
   * 关键点：校正必须基于「当前推算位置」，而不是「锚点位置」。
   * 早期写法 `_basePosition += diff * 0.4` 会把上一个锚点之后流逝的时间整段丢掉，
   * 每收到一次上报就先把进度倒退近 1 秒再往前补一点，表现就是歌词来回跳。
   */
  updateSeek(seekZone) {
    if (!seekZone || seekZone.zone_id !== this.zoneId) return;
    if (typeof seekZone.seek_position !== 'number') return;

    this._updateStall();

    const target = dequantize(seekZone.seek_position);
    const predicted = this.position;
    const diff = target - predicted;

    this._setReportedSeek(target);
    this._lastSeekAt = Date.now();
    this._pendingBackward = null;

    if (this.debug) {
      this.debug(`seek_changed: 报告 ${seekZone.seek_position}s，本地推算 ${predicted.toFixed(3)}s，偏差 ${diff.toFixed(3)}s`);
    }

    if (Math.abs(diff) > 2.5) {
      // 明确的跳转（用户拖动进度条 / 明显漂移）：直接对齐
      this.seekSeq += 1;
      this._basePosition = Math.max(0, target);
      this._record('seek-hard', { diff: Number(diff.toFixed(3)) });
    } else if (Math.abs(diff) > 0.25) {
      // 小幅漂移：以「当前推算位置」为基准缓慢收敛，绝不丢掉已流逝的时间
      this._basePosition = Math.max(0, predicted + diff * 0.5);
      this._record('seek-soft', { diff: Number(diff.toFixed(3)) });
    } else {
      // 已在容差内，什么都不做，避免在 Roon 的整秒台阶上反复过冲
      return;
    }

    this._baseAt = Date.now();

    if (Math.abs(diff) > 0.5) {
      this.emit('progress', this.progressPayload());
    }
  }

  /**
   * 强制把本地时钟对齐到 Roon 最近一次上报的进度。
   * 用户发现时间轴明显偏了时可以手动触发（桌面端「对齐」按钮 / A 键）。
   * @returns {number|null} 对齐后的进度
   */
  realign() {
    if (typeof this._lastReportedSeek !== 'number') return null;
    this._basePosition = Math.max(0, this._lastReportedSeek);
    this._baseAt = this._lastSeekAt && this.state !== 'playing' ? this._lastSeekAt : Date.now();
    this._pendingBackward = null;
    this.seekSeq += 1;
    this._record('realign');
    this.emit('progress', this.progressPayload());
    return this._basePosition;
  }

  /**
   * 记录一次位置变化。用于排查「歌词跳来跳去」——
   * 打开 http://127.0.0.1:8687/api/diagnostics/history 就能看到
   * 每一次重新锚定的时间、原因、Roon 报的值与本地推算值。
   */
  _record(event, extra) {
    this.history.push(
      Object.assign(
        {
          at: Date.now(),
          event,
          state: this.state,
          reported: this._lastReportedSeek,
          anchor: Number(this._basePosition.toFixed(3)),
          position: Number(this.position.toFixed(3)),
          seekSeq: this.seekSeq,
        },
        extra || {}
      )
    );
    if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
  }

  historyPayload(limit = 60) {
    return this.history.slice(-Math.max(1, Math.min(300, limit)));
  }

  /** 服务端认为当前应该高亮的歌词行（用于和时间轴对照排查） */
  activeLine() {
    const lines = (this.lyrics && this.lyrics.lines) || [];
    if (lines.length === 0 || !this.lyrics.synced) return null;

    const position = this.position;
    let index = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].time <= position) {
        index = i;
        break;
      }
    }
    if (index < 0) return { index: -1, time: null, text: null };

    return {
      index,
      time: lines[index].time,
      text: lines[index].text,
      deltaSec: Number((position - lines[index].time).toFixed(3)),
    };
  }

  /** 时间轴诊断信息，用于排查「歌词对不上」这类问题 */
  diagnostics() {
    return {
      state: this.state,
      position: Number(this.position.toFixed(3)),
      anchorPosition: Number(this._basePosition.toFixed(3)),
      anchorAgeMs: Date.now() - this._baseAt,
      lastReportedSeek: this._lastReportedSeek,
      lastSeekAgeMs: this._lastSeekAt ? Date.now() - this._lastSeekAt : null,
      reportIntervalMs: this.reportIntervalMs,
      reportedSeekAgeMs: this._seekAdvanceAt ? Date.now() - this._seekAdvanceAt : null,
      stalled: this._frozen,
      stallThresholdMs: this.stallThresholdMs,
      stallAllowanceSec: Number(this.stallAllowanceSec.toFixed(2)),
      durationSec: this.durationSec,
      lyricsOffsetMs: this.lyrics && this.lyrics.offsetMs ? this.lyrics.offsetMs : 0,
      trackOffsetMs: this.lyrics && this.lyrics.trackOffsetMs ? this.lyrics.trackOffsetMs : 0,
      activeLine: this.activeLine(),
    };
  }

  track() {
    return {
      trackId: this.trackId,
      title: this.title,
      artists: this.artists,
      artist: this.artists.join('、'),
      album: this.album,
      durationSec: this.durationSec,
      imageKey: this.imageKey,
    };
  }

  playerPayload() {
    return {
      state: this.state,
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      trackId: this.trackId,
      title: this.title,
      artists: this.artists,
      artist: this.artists.join('、'),
      album: this.album,
      durationSec: this.durationSec,
      position: Number(this.position.toFixed(3)),
      seekSeq: this.seekSeq,
      stalled: this._frozen,
      imageKey: this.imageKey,
      coverUrl: this.imageKey ? `/api/cover?key=${encodeURIComponent(this.imageKey)}` : null,
      updatedAt: Date.now(),
    };
  }

  progressPayload() {
    return {
      state: this.state,
      position: Number(this.position.toFixed(3)),
      durationSec: this.durationSec,
      trackId: this.trackId,
      seekSeq: this.seekSeq,
      stalled: this._frozen,
      updatedAt: Date.now(),
    };
  }

  startTicker() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this._updateStall();
      if (this.state === 'playing') {
        this.emit('progress', this.progressPayload());
      }
    }, this.progressIntervalMs);
  }

  stopTicker() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

/**
 * Roon 的 seek_position 是整秒（实测取的是向下取整），比真实位置平均小 0.5s。
 * 直接用会导致推算位置被系统性地往回拉，这里补上半秒中点。
 * 如果某个环境给的是带小数的精确值，就原样使用。
 */
function dequantize(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Number.isInteger(value) ? value + 0.5 : value;
}

/** "A / B / C"、"A, B"、"A feat. B" -> ["A","B","C"] */
function splitArtists(line) {
  if (!line) return [];
  return line
    .split(/\s*[/,;、]\s*|\s+(?:feat\.?|ft\.?|with)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

module.exports = { NowPlaying, splitArtists };
