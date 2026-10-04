'use strict';

const http = require('http');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const PROTOCOL_VERSION = 1;

/**
 * 对外服务：HTTP 查询接口 + WebSocket 实时推送（供桌面歌词窗口使用）。
 *
 * 事件：
 *   'select'  (songId)  用户手动选择了某首网易云歌曲
 *   'refresh' ()        请求重新解析当前曲目歌词
 *   'config'  (patch)   运行时修改配置（数据源 / NCM API 地址）
 *   'offset'  (opts)    调整当前曲目的时间轴偏移 { delta | value | reset }
 */
class OverlayServer extends EventEmitter {
  constructor({ config, logger, nowPlaying, lyricService, ncm, roon }) {
    super();
    this.config = config;
    this.log = logger;
    this.nowPlaying = nowPlaying;
    this.lyricService = lyricService;
    this.ncm = ncm;
    this.roon = roon;

    this._coverCache = new Map();

    this.httpServer = http.createServer((req, res) => this._handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
    this.wss.on('connection', (ws) => this._onConnection(ws));
  }

  start() {
    const { host, port } = this.config;
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        this.log.info(`歌词服务已启动: http://${host}:${port}  (WebSocket: ws://${host}:${port}/ws)`);
        resolve();
      });
    });
  }

  close() {
    try {
      for (const ws of this.wss.clients) ws.terminate();
      this.wss.close();
    } catch (err) {
      /* ignore */
    }
    try {
      this.httpServer.close();
    } catch (err) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ WS

  _onConnection(ws) {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (err) {
        return;
      }
      this._onClientMessage(ws, msg);
    });

    ws.on('error', () => {});

    this._send(ws, 'hello', { protocol: PROTOCOL_VERSION, version: '1.0.0' });
    this._send(ws, 'snapshot', this.snapshot());
  }

  _onClientMessage(ws, msg) {
    switch (msg.type) {
      case 'ping':
        this._send(ws, 'pong', { at: Date.now() });
        break;
      case 'select':
        if (msg.songId) this.emit('select', String(msg.songId));
        break;
      case 'refresh':
        this.emit('refresh');
        break;
      case 'config':
        this.emit('config', msg.patch || msg.data || {});
        break;
      case 'offset':
        this.emit('offset', msg);
        break;
      case 'search':
        this.emit('search', { keywords: String(msg.keywords || ''), ws });
        break;
      default:
        break;
    }
  }

  _send(ws, type, data) {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({ type, data }));
    } catch (err) {
      /* ignore */
    }
  }

  broadcast(type, data) {
    const payload = JSON.stringify({ type, data });
    for (const ws of this.wss.clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(payload);
        } catch (err) {
          /* ignore */
        }
      }
    }
  }

  sendTo(ws, type, data) {
    this._send(ws, type, data);
  }

  // ---------------------------------------------------------------- HTTP

  /** 可运行时调整的配置快照（桌面端设置面板用） */
  settingsPayload() {
    return {
      lyricSource: this.ncm.configured,
      ncmApi: this.ncm.clients.ncm.baseUrl,
      zone: this.config.zone || '',
      translation: this.config.translation,
      filterCredits: this.config.filterCredits,
      globalOffsetMs: Number(this.config.lyricOffsetMs) || 0,
    };
  }

  snapshot() {
    return {
      protocol: PROTOCOL_VERSION,
      player: this.nowPlaying.playerPayload(),
      lyrics: this.nowPlaying.lyricsPayload(),
      roon: this.roon ? this.roon.snapshot() : null,
      ncm: this.ncm.status(),
      settings: this.settingsPayload(),
    };
  }

  async _handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      if (path === '/health') {
        const source = this.ncm.status();
        this._json(res, 200, {
          ok: true,
          roon: this.roon ? this.roon.snapshot().status : 'unavailable',
          source: source.active || null,
          online: source.online,
          targets: source.targets,
          clients: this.wss.clients.size,
        });
        return;
      }

      if (path === '/api/state') {
        this._json(res, 200, this.snapshot());
        return;
      }

      if (path === '/api/lyrics') {
        this._json(res, 200, {
          player: this.nowPlaying.playerPayload(),
          lyrics: this.nowPlaying.lyricsPayload(),
        });
        return;
      }

      if (path === '/api/search') {
        const keywords = url.searchParams.get('keywords') || '';
        if (!keywords.trim()) {
          this._json(res, 400, { error: '缺少 keywords 参数' });
          return;
        }
        const candidates = await this.searchCandidates(keywords);
        this._json(res, 200, { keywords, candidates });
        return;
      }

      if (path === '/api/diagnostics/history') {
        const limit = Number(url.searchParams.get('limit')) || 60;
        this._json(res, 200, { events: this.nowPlaying.historyPayload(limit) });
        return;
      }

      if (path === '/api/diagnostics') {
        this._json(res, 200, {
          player: this.nowPlaying.diagnostics(),
          track: this.nowPlaying.track(),
          source: this.ncm.status(),
          roon: this.roon ? this.roon.snapshot() : null,
          lyrics: {
            status: this.nowPlaying.lyricsStatus,
            lines: (this.nowPlaying.lyrics && this.nowPlaying.lyrics.lines
              ? this.nowPlaying.lyrics.lines.length
              : 0),
            offsetMs: (this.nowPlaying.lyrics && this.nowPlaying.lyrics.offsetMs) || 0,
          },
          serverTime: Date.now(),
        });
        return;
      }

      if (path === '/api/select' || path === '/api/refresh' || path === '/api/config' || path === '/api/offset') {
        let body = {};
        if (req.method === 'POST') body = await readJsonBody(req);
        const songId = body.songId || url.searchParams.get('songId');

        if (path === '/api/select' && songId) this.emit('select', String(songId));
        if (path === '/api/refresh') this.emit('refresh');
        if (path === '/api/config') {
          const patch = {
            ncmApi: body.ncmApi || url.searchParams.get('ncmApi'),
            lyricSource: body.lyricSource || url.searchParams.get('lyricSource'),
          };
          const rawOffset =
            body.globalOffsetMs !== undefined ? body.globalOffsetMs : url.searchParams.get('globalOffsetMs');
          if (rawOffset !== undefined && rawOffset !== null && rawOffset !== '') {
            patch.globalOffsetMs = Number(rawOffset);
          }
          // 空字符串表示恢复「自动跟随正在播放的区」
          if (body.zone !== undefined) patch.zone = body.zone;
          else if (url.searchParams.has('zone')) patch.zone = url.searchParams.get('zone');
          this.emit('config', patch);
        }
        if (path === '/api/offset') {
          this.emit('offset', {
            delta: body.delta,
            value: body.value,
            reset: body.reset,
            realign: body.realign,
          });
        }
        this._json(res, 200, { ok: true });
        return;
      }

      if (path === '/api/cover') {
        await this._serveCover(url, res);
        return;
      }

      if (path === '/' || path === '/index.html') {
        this._html(res, 200, DEBUG_PAGE);
        return;
      }

      this._json(res, 404, { error: 'Not Found' });
    } catch (err) {
      this.log.error('HTTP 处理异常:', err.stack || err.message);
      this._json(res, 500, { error: err.message });
    }
  }

  /** 关键字搜索候选曲目，并按当前曲目匹配度排序 */
  async searchCandidates(keywords) {
    const songs = await this.ncm.search(keywords, this.config.searchLimit);
    const { pickBest } = require('./matcher');
    const track = this.nowPlaying.track();
    const query = {
      title: track.title,
      artists: track.artists,
      album: track.album,
      durationSec: track.durationSec,
    };

    return songs
      .map((song) => {
        const entry = pickBest([song], query);
        return {
          songId: String(song.id),
          name: song.name,
          artists: song.artists,
          album: song.album,
          durationSec: song.durationSec,
          score: entry ? Number(entry.score.toFixed(1)) : 0,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  async _serveCover(url, res) {
    const key = url.searchParams.get('key');
    if (!key || !this.roon) {
      res.writeHead(404).end();
      return;
    }

    const size = Math.min(1000, Math.max(64, Number(url.searchParams.get('size')) || 600));
    const cacheKey = `${key}@${size}`;
    let entry = this._coverCache.get(cacheKey);

    if (!entry) {
      entry = await this.roon.getImage(key, { scale: 'fit', width: size, height: size, format: 'image/jpeg' });
      if (entry) {
        if (this._coverCache.size > 40) this._coverCache.clear();
        this._coverCache.set(cacheKey, entry);
      }
    }

    if (!entry) {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': entry.body.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(entry.body);
  }

  _json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  _html(res, code, html) {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const DEBUG_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Roon 网易云歌词 · 服务状态</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { background:#11131a; color:#e8eaf2; font-family:"Microsoft YaHei UI",system-ui,sans-serif; margin:0; padding:24px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 16px; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  .card { background:#1a1d27; border:1px solid #262b39; border-radius:12px; padding:16px; }
  .card h2 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:#8b93a7; margin:0 0 10px; }
  pre { margin:0; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-all; color:#c6cbe0; max-height:280px; overflow:auto; }
  .pill { display:inline-block; padding:2px 8px; border-radius:99px; font-size:12px; background:#2a3145; }
  .ok { background:#17402c; color:#5ce69a; }
  .bad { background:#411d22; color:#ff7b8a; }
</style>
</head>
<body>
<h1>Roon → 网易云歌词 服务</h1>
<div class="grid">
  <div class="card"><h2>连接状态</h2><div id="status" class="pill">连接中…</div><pre id="conn"></pre></div>
  <div class="card"><h2>当前曲目</h2><pre id="player"></pre></div>
  <div class="card"><h2>歌词</h2><pre id="lyrics"></pre></div>
</div>
<script>
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
let player = {}, lyrics = {};
ws.onopen = () => { document.getElementById('status').className = 'pill ok'; document.getElementById('status').textContent = '已连接'; };
ws.onclose = () => { document.getElementById('status').className = 'pill bad'; document.getElementById('status').textContent = '已断开'; };
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'snapshot') { player = msg.data.player; lyrics = msg.data.lyrics; document.getElementById('conn').textContent = JSON.stringify(msg.data.roon, null, 2) + '\\n\\n' + JSON.stringify(msg.data.ncm, null, 2); }
  if (msg.type === 'player') player = msg.data;
  if (msg.type === 'lyrics') lyrics = msg.data;
  if (msg.type === 'progress') player.position = msg.data.position;
  render();
};
function render() {
  document.getElementById('player').textContent = JSON.stringify(player, null, 2);
  const l = Object.assign({}, lyrics, { lines: (lyrics.lines || []).slice(0, 40) });
  document.getElementById('lyrics').textContent = JSON.stringify(l, null, 2);
}
</script>
</body>
</html>`;

module.exports = { OverlayServer, PROTOCOL_VERSION };
