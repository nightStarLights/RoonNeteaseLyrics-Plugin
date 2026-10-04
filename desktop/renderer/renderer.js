'use strict';

/* eslint-env browser */

const api = window.overlay || {};

const els = {
  app: document.getElementById('app'),
  cover: document.getElementById('cover'),
  meta: document.getElementById('meta'),
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  badges: document.getElementById('badges'),
  viewport: document.getElementById('viewport'),
  list: document.getElementById('list'),
  placeholder: document.getElementById('placeholder'),
  placeholderIcon: document.getElementById('placeholderIcon'),
  placeholderText: document.getElementById('placeholderText'),
  placeholderHint: document.getElementById('placeholderHint'),
  bottom: document.getElementById('bottom'),
  progressBar: document.getElementById('progressBar'),
  source: document.getElementById('source'),
  toolbar: document.getElementById('toolbar'),
  lockHint: document.getElementById('lockHint'),
  toast: document.getElementById('toast'),
  panelSearch: document.getElementById('panelSearch'),
  panelSettings: document.getElementById('panelSettings'),
  searchInput: document.getElementById('searchInput'),
  btnSearch: document.getElementById('btnSearch'),
  searchResults: document.getElementById('searchResults'),
  setWsUrl: document.getElementById('setWsUrl'),
  setFont: document.getElementById('setFont'),
  setFontVal: document.getElementById('setFontVal'),
  setOpacity: document.getElementById('setOpacity'),
  setOpacityVal: document.getElementById('setOpacityVal'),
  setCover: document.getElementById('setCover'),
  setMode: document.getElementById('setMode'),
  setTitle: document.getElementById('setTitle'),
  setProgress: document.getElementById('setProgress'),
  setPure: document.getElementById('setPure'),
  setOnTop: document.getElementById('setOnTop'),
  btnReconnect: document.getElementById('btnReconnect'),
  btnRefreshLyrics: document.getElementById('btnRefreshLyrics'),
  btnQuit: document.getElementById('btnQuit'),
  appInfo: document.getElementById('appInfo'),
  sourceInfo: document.getElementById('sourceInfo'),
  setSource: document.getElementById('setSource'),
  setNcmApi: document.getElementById('setNcmApi'),
  setZone: document.getElementById('setZone'),
  zoneOptions: document.getElementById('zoneOptions'),
  zoneHint: document.getElementById('zoneHint'),
  offsetVal: document.getElementById('offsetVal'),
  globalOffsetVal: document.getElementById('globalOffsetVal'),
  shortcutList: document.getElementById('shortcutList'),
  lockBar: document.getElementById('lockBar'),
  setColorAll: document.getElementById('setColorAll'),
  setColorLyric: document.getElementById('setColorLyric'),
  setColorSub: document.getElementById('setColorSub'),
  btnColorReset: document.getElementById('btnColorReset'),
};

const DEFAULT_SETTINGS = {
  wsUrl: 'ws://127.0.0.1:8687/ws',
  alwaysOnTop: true,
  locked: false,
  pureMode: false,
  lyricMode: 'translation',
  fontSize: 34,
  opacity: 1,
  showCover: true,
  showTitle: true,
  showProgress: true,
  colorLyric: '#ffffff',
  colorSub: '#dcdfec',
};

const DEFAULT_LYRIC_COLORS = { colorLyric: '#ffffff', colorSub: '#dcdfec' };

/** 歌词显示模式循环：原词+翻译 → 原词+注音 → 仅原词 */
const LYRIC_MODES = ['translation', 'romaji', 'original'];
const LYRIC_MODE_LABELS = {
  translation: '原词 + 翻译',
  romaji: '原词 + 注音',
  original: '仅原词',
};

const state = {
  settings: Object.assign({}, DEFAULT_SETTINGS),
  player: { state: 'idle', title: '', artist: '', album: '', durationSec: 0, position: 0 },
  lyrics: { status: 'idle', lines: [], synced: false },
  ncm: { online: null },
  roon: {},
  conn: 'connecting',
  basePosition: 0,
  baseAt: performance.now(),
  activeIndex: -1,
  lineEls: [],
  coverKey: null,
  searching: false,
  serverSettings: {},
  shortcuts: {},
  seekSeq: 0,
  floorPosition: -Infinity,
  stalled: false,
};

let ws = null;
let retryCount = 0;
let retryTimer = null;
let toastTimer = null;
let connectedOnce = false;

// ---------------------------------------------------------------- 工具

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function httpBase() {
  try {
    const url = new URL(state.settings.wsUrl || DEFAULT_SETTINGS.wsUrl);
    return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
  } catch (err) {
    return '';
  }
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(text, duration = 1800) {
  els.toast.textContent = text;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), duration);
}

// ---------------------------------------------------------------- WebSocket

function setConn(status) {
  if (state.conn === status) return;
  state.conn = status;
  renderBadges();
  renderPlaceholder();
}

function connect() {
  clearTimeout(retryTimer);

  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch (err) {
      /* ignore */
    }
  }

  const url = state.settings.wsUrl || DEFAULT_SETTINGS.wsUrl;
  setConn('connecting');

  try {
    ws = new WebSocket(url);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    retryCount = 0;
    setConn('connected');
    if (!connectedOnce) {
      connectedOnce = true;
    } else {
      toast('已重新连接歌词服务');
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    setConn('disconnected');
    scheduleReconnect();
  };

  ws.onerror = () => {
    /* onclose 会处理重连 */
  };
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryCount += 1;
  const delay = Math.min(10000, 1000 * Math.pow(1.6, Math.min(retryCount, 6)));
  retryTimer = setTimeout(connect, delay);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      if (msg.data.player) applyPlayer(msg.data.player);
      if (msg.data.lyrics) applyLyrics(msg.data.lyrics);
      if (msg.data.ncm) {
        state.ncm = msg.data.ncm;
        renderBadges();
        renderSourceInfo();
      }
      if (msg.data.roon) {
        state.roon = msg.data.roon;
        renderBadges();
        renderZoneField();
      }
      if (msg.data.settings) {
        state.serverSettings = msg.data.settings;
        renderServerSettings();
      }
      break;

    case 'player':
      applyPlayer(msg.data);
      break;

    case 'lyrics':
      applyLyrics(msg.data);
      break;

    case 'progress': {
      const data = msg.data || {};
      if (data.trackId && state.player.trackId && data.trackId !== state.player.trackId) break;

      const predicted = currentPosition();
      state.player.state = data.state;
      state.stalled = Boolean(data.stalled);
      if (data.durationSec) state.player.durationSec = data.durationSec;

      if (state.stalled) {
        // 音频卡住（Roon 仍报 playing 但进度不再推进）：跟随服务端的冻结位置，不本地外推
        state.basePosition = data.position;
        state.baseAt = performance.now();
        state.floorPosition = data.position;
        break;
      }

      // 服务端确认过的跳转（用户拖动进度条 / 手动对齐）
      if (typeof data.seekSeq === 'number' && data.seekSeq !== state.seekSeq) {
        state.seekSeq = data.seekSeq;
        state.basePosition = data.position;
        state.baseAt = performance.now();
        resetFloor(data.position);
        break;
      }

      if (data.state !== 'playing') {
        state.basePosition = data.position;
        state.baseAt = performance.now();
        resetFloor(data.position);
        break;
      }

      const diff = data.position - predicted;

      if (Math.abs(diff) > 3) {
        // 偏差过大，说明本地外推跑偏了，硬对齐
        state.basePosition = data.position;
        state.baseAt = performance.now();
        resetFloor(data.position);
      } else if (diff > 0.4) {
        // 只吸收「向前」的小幅偏差，且只吸收一部分，避免在 Roon 的整秒台阶上来回过冲
        const next = predicted + diff * 0.25;
        state.basePosition = next;
        state.baseAt = performance.now();
      }
      // diff 为负且幅度不大时保持本地时钟，绝不让高亮往后退
      break;
    }

    case 'roon':
      state.roon = msg.data || {};
      renderBadges();
      renderZoneField();
      renderPlaceholder();
      break;

    case 'ncm':
      state.ncm = msg.data || {};
      renderBadges();
      renderSourceInfo();
      renderPlaceholder();
      break;

    case 'config':
      state.serverSettings = Object.assign({}, state.serverSettings, msg.data || {});
      renderServerSettings();
      renderSource();
      toast('扩展配置已更新');
      break;

    case 'offset':
      state.lyrics = Object.assign({}, state.lyrics, { trackOffsetMs: msg.data.offsetMs });
      renderOffset();
      toast(`时间轴偏移 ${msg.data.offsetMs > 0 ? '+' : ''}${msg.data.offsetMs} ms`);
      break;

    case 'realign': {
      const position = msg.data && msg.data.position;
      if (typeof position === 'number') {
        state.basePosition = position;
        state.baseAt = performance.now();
        resetFloor(position);
        toast(`已对齐到 ${Math.floor(position / 60)}:${String(Math.floor(position % 60)).padStart(2, '0')}`);
      } else {
        toast('Roon 暂未上报播放进度');
      }
      break;
    }

    case 'searchResult':
      state.searching = false;
      els.btnSearch.disabled = false;
      renderSearchResults(msg.data || {});
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------- 播放状态

/** 允许位置跳变（换曲 / 播放状态变化 / 服务端确认的 seek / 手动对齐） */
function resetFloor(value) {
  state.floorPosition = Number.isFinite(value) ? value : -Infinity;
}

/**
 * 展示用的播放位置。
 *
 * 播放中只增不减：Roon 上报的是整秒且可能滞后，任何向后的修正都会让
 * 歌词高亮在视觉上来回跳。真正需要跳转时，服务端会用 seekSeq 明确告知。
 */
function currentPosition() {
  if (state.player.state !== 'playing' || state.stalled) {
    // 非播放中，或服务端判定音频卡住了（Roon 仍报 playing 但进度不再推进）：
    // 完全冻结，不再用本地时钟外推
    state.floorPosition = state.basePosition;
    return state.basePosition;
  }

  const pos = state.basePosition + (performance.now() - state.baseAt) / 1000;

  if (pos < state.floorPosition) return state.floorPosition;
  state.floorPosition = pos;
  return pos;
}

function applyPlayer(player) {
  const prev = state.player;
  const trackChanged = player.trackId !== prev.trackId;
  const seqChanged = typeof player.seekSeq === 'number' && player.seekSeq !== state.seekSeq;

  state.player = Object.assign({}, prev, player);
  if (seqChanged) state.seekSeq = player.seekSeq;
  state.stalled = Boolean(player.stalled);

  const stateChanged = player.state !== prev.state;

  if (trackChanged) {
    // 换曲先清空上一首的歌词：万一扩展那边没来得及（或漏了）推送新歌词，
    // 也不会一直挂着上一首的内容
    applyLyrics({ status: 'searching', lines: [], synced: false, songId: null });
  }

  if (trackChanged || seqChanged || (stateChanged && player.state !== 'playing')) {
    // 换曲 / 服务端确认的跳转 / 暂停停止：允许位置跳变
    state.basePosition = Number(player.position) || 0;
    state.baseAt = performance.now();
    resetFloor(state.basePosition);
  } else if (stateChanged) {
    // 开始播放：保持单调，避免服务端的整秒滞后值把高亮拉回去
    state.basePosition = Number(player.position) || 0;
    state.baseAt = performance.now();
    state.floorPosition = Math.max(state.floorPosition, state.basePosition);
  }

  renderMeta();
  renderCover();
  renderBadges();
  renderPlaceholder();
}

function applyLyrics(lyrics) {
  const prev = state.lyrics || {};
  const changed =
    lyrics.status !== prev.status ||
    (lyrics.lines || []).length !== (prev.lines || []).length ||
    (lyrics.songId && lyrics.songId !== prev.songId);

  state.lyrics = Object.assign({ lines: [], synced: false }, lyrics);

  if (changed) {
    renderLyrics();
  }
  renderBadges();
  renderModeButton();
  renderPlaceholder();
  renderSource();
  renderOffset();
}

// ---------------------------------------------------------------- 渲染：顶部

function renderMeta() {
  const p = state.player;
  if (!state.settings.showTitle) {
    els.meta.classList.add('hidden');
    return;
  }
  els.meta.classList.remove('hidden');
  els.title.textContent = p.title || '等待 Roon 播放…';
  const bits = [];
  if (p.artist) bits.push(p.artist);
  if (p.album) bits.push(p.album);
  els.artist.textContent = bits.join(' · ');
}

function renderCover() {
  const p = state.player;
  if (!state.settings.showCover || !p.imageKey) {
    els.cover.classList.remove('visible');
    return;
  }
  if (p.imageKey === state.coverKey) {
    els.cover.classList.add('visible');
    return;
  }
  state.coverKey = p.imageKey;
  const url = `${httpBase()}${p.coverUrl || `/api/cover?key=${encodeURIComponent(p.imageKey)}`}`;
  const img = new Image();
  img.onload = () => {
    els.cover.style.backgroundImage = `url("${url}")`;
    els.cover.classList.add('visible');
  };
  img.onerror = () => els.cover.classList.remove('visible');
  img.src = url;
}

function renderBadges() {
  const out = [];

  if (state.conn === 'connecting') out.push(['连接中…', 'info']);
  else if (state.conn !== 'connected') out.push(['未连接', 'err']);

  const source = state.ncm || {};
  if (source.online === false) out.push(['网易云离线', 'err']);
  // else if (source.active === 'direct') out.push(['直连官方接口', 'info']);
  if (state.roon && state.roon.paired === false && state.roon.status !== 'starting') {
    out.push(['Roon 未连接', 'warn']);
  }

  if (state.stalled) out.push(['音频缓冲中，歌词已暂停', 'warn']);

  const ls = state.lyrics.status;
  if (ls === 'searching') out.push(['搜索歌词…', 'info']);
  else if (ls === 'notfound') out.push(['未找到歌词', 'warn']);
  else if (ls === 'empty') out.push(['纯音乐', 'warn']);
  else if (ls === 'error') out.push(['歌词获取失败', 'err']);

  if (state.settings.locked) out.push(['已锁定', 'info']);

  els.badges.innerHTML = '';
  for (const [text, cls] of out) {
    const el = document.createElement('span');
    el.className = `badge ${cls}`;
    el.textContent = text;
    els.badges.appendChild(el);
  }
}

function renderSourceInfo() {
  if (!els.sourceInfo) return;
  const s = state.ncm || {};
  const targets = s.targets || [];

  if (!s.activeLabel) {
    els.sourceInfo.innerHTML = '<span class="bad">尚未探测</span>';
    return;
  }

  const lines = [`<span class="${s.active ? 'ok' : 'bad'}">${escapeHtml(s.activeLabel)}</span>`];
  if (s.reason) lines.push(`<div class="sub">${escapeHtml(s.reason)}</div>`);

  if (targets.length) {
    const rows = targets
      .map((t) => {
        const state2 = t.online === null ? (t.used ? '未探测' : '未启用') : t.online ? '可用' : '不可用';
        return `${escapeHtml(t.label)}：${state2}`;
      })
      .join('<br>');
    lines.push(`<div class="sub">${rows}</div>`);
  }

  els.sourceInfo.innerHTML = lines.join('');
}

/** 扩展侧的配置（数据源 / NCM API 地址），由 snapshot 或 config 消息推送 */
function renderServerSettings() {
  const s = state.serverSettings || {};

  if (s.lyricSource && document.activeElement !== els.setSource) {
    els.setSource.value = s.lyricSource;
  }
  if (s.ncmApi && document.activeElement !== els.setNcmApi) {
    els.setNcmApi.value = s.ncmApi;
  }
  if (els.globalOffsetVal) {
    const v = Number(s.globalOffsetMs) || 0;
    els.globalOffsetVal.textContent = `${v > 0 ? '+' : ''}${v}`;
  }

  renderZoneField();
}

let lastZoneSig = '';

/**
 * 监听设备：可输入的下拉框（input + datalist）。
 * 留空 = 自动跟随正在播放的设备，填了 = 只认这一台；
 * 下拉里是 Roon 实际检测到的设备，也可以自己打字。
 */
function renderZoneField() {
  if (!els.setZone) return;

  const configured = String((state.serverSettings && state.serverSettings.zone) || '');
  if (document.activeElement !== els.setZone && els.setZone.value !== configured) {
    els.setZone.value = configured;
  }

  const zones = (state.roon && state.roon.zones) || [];
  const current = zones.find((z) => z.id === (state.roon && state.roon.currentZoneId));

  // 用 datalist 做候选：option 的 value 必须是纯设备名（扩展是按名字匹配的），
  // 状态放在 label 里，Chromium 会把它显示在下拉项旁边
  if (els.zoneOptions) {
    const sig = zones.map((z) => `${z.id}:${z.name}:${z.state}`).join('|');
    if (sig !== lastZoneSig) {
      lastZoneSig = sig;
      els.zoneOptions.innerHTML = zones
        .map((z) => {
          const label = z.state === 'playing' ? '播放中' : z.state === 'paused' ? '已暂停' : '';
          return `<option value="${escapeHtml(z.name)}"${label ? ` label="${label}"` : ''}></option>`;
        })
        .join('');
    }
  }

  if (!els.zoneHint) return;

  if (zones.length === 0) {
    els.zoneHint.textContent = '还没拿到 Roon 播放区列表（未连接或还没配对）。';
    return;
  }

  const names = zones
    .map((z) => `${z.name}${z.state === 'playing' ? '（播放中）' : z.state === 'paused' ? '（已暂停）' : ''}`)
    .join('、');
  const tail = current ? `当前监听：${current.name}` : '当前没有正在播放的设备';

  els.zoneHint.textContent = `Roon 里有 ${zones.length} 个播放区：${names}｜${tail}`;
}

/** 全局偏移：写进扩展的 config.json，对所有曲目生效 */
function nudgeGlobalOffset(delta) {
  const current = Number(state.serverSettings && state.serverSettings.globalOffsetMs) || 0;
  const next = delta === 0 ? 0 : current + delta;

  if (!send({ type: 'config', patch: { globalOffsetMs: next } })) {
    toast('未连接歌词服务');
    return;
  }
  state.serverSettings = Object.assign({}, state.serverSettings, { globalOffsetMs: next });
  renderServerSettings();
}

function renderOffset() {
  const value = Number(state.lyrics && state.lyrics.trackOffsetMs) || 0;
  els.offsetVal.textContent = `${value > 0 ? '+' : ''}${value}`;
}

const SHORTCUT_ACTIONS = [
  ['lock', '锁定 / 解锁（鼠标穿透）'],
  ['toggle', '显示 / 隐藏窗口'],
  ['fontUp', '放大字号'],
  ['fontDown', '缩小字号'],
  ['settings', '打开设置面板'],
  ['search', '打开搜索面板'],
  ['refresh', '重新匹配当前曲目'],
];

let capturing = null;

/** 浏览器 KeyboardEvent -> Electron accelerator */
function normalizeKey(key) {
  if (!key) return null;
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified'].includes(key)) return null;

  const map = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space',
    Escape: 'Esc',
    '+': 'Plus',
  };
  if (map[key]) return map[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function acceleratorFromEvent(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.metaKey) mods.push('Super');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');

  const key = normalizeKey(event.key);
  if (!key) return null;
  // 必须带修饰键，否则会把普通按键注册成全局快捷键
  if (mods.length === 0) return null;

  return mods.concat(key).join('+');
}

function stopCapture() {
  capturing = null;
  if (api.setCapture) api.setCapture(false);
}

/**
 * 锁定后窗口整体鼠标穿透（点击落到下层窗口），
 * 但鼠标移到锁按钮上时临时恢复可点击，这样不依赖快捷键也能解锁。
 */
let ignoringMouse = true;

function updateIgnoringMouse(ignoring) {
  if (!state.settings.locked) return;
  if (ignoring === ignoringMouse) return;
  ignoringMouse = ignoring;
  if (api.setIgnoringMouse) api.setIgnoringMouse(ignoring);
}

function saveShortcut(action, accelerator) {
  stopCapture();
  const shortcuts = Object.assign({}, state.settings.shortcuts, { [action]: accelerator });
  state.settings.shortcuts = shortcuts;
  if (api.setSettings) api.setSettings({ shortcuts });
  toast(accelerator ? `已设置为 ${accelerator}` : '已清除该快捷键');
}

function renderShortcuts() {
  if (!els.shortcutList) return;
  els.shortcutList.innerHTML = '';

  for (const [action, label] of SHORTCUT_ACTIONS) {
    const info = (state.shortcuts || {})[action] || {};

    const row = document.createElement('div');
    row.className = 'row';

    const dot = document.createElement('span');
    dot.className = 'dot';
    if (info.ok) dot.className = 'dot ok';
    else if (info.accelerator) dot.className = 'dot bad';
    dot.title = info.ok ? '可用' : info.reason || '未设置';

    const text = document.createElement('span');
    text.className = 'label';
    text.textContent = label;

    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.className = 'sc-input';
    input.placeholder = '未设置';
    input.value = info.accelerator || '';
    if (info.ok) input.classList.add('ok');
    else if (info.accelerator) input.classList.add('bad');

    input.addEventListener('focus', () => {
      capturing = action;
      input.value = '';
      input.placeholder = '按下组合键…';
      if (api.setCapture) api.setCapture(true);
    });

    input.addEventListener('blur', () => {
      if (capturing === action) stopCapture();
      input.placeholder = '未设置';
      input.value = ((state.shortcuts || {})[action] || {}).accelerator || '';
    });

    input.addEventListener('keydown', (event) => {
      if (capturing !== action) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        input.blur();
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        saveShortcut(action, '');
        input.blur();
        return;
      }

      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return; // 只按了修饰键，继续等主键

      saveShortcut(action, accelerator);
      input.blur();
    });

    row.appendChild(dot);
    row.appendChild(text);
    row.appendChild(input);
    els.shortcutList.appendChild(row);
  }
}

function renderSource() {
  const l = state.lyrics || {};
  if (!state.settings.showProgress && !state.settings.showTitle) {
    els.bottom.classList.add('hidden');
    return;
  }
  els.bottom.classList.remove('hidden');

  const bits = [];
  if (l.status === 'found' && l.songName) {
    bits.push(`网易云《${l.songName}》${l.artists && l.artists.length ? ' - ' + l.artists.join('、') : ''}`);
    if (typeof l.score === 'number') bits.push(`匹配 ${Math.round(l.score)}`);
    if (l.cached) bits.push('缓存');
  } else if (l.status === 'notfound') {
    bits.push('未匹配到网易云歌曲');
  } else if (l.status === 'error') {
    bits.push(l.error || '歌词服务异常');
  } else if (l.status === 'searching') {
    bits.push('正在搜索网易云…');
  }

  els.source.textContent = bits.join(' · ');
}

// ---------------------------------------------------------------- 渲染：歌词

function activeLines() {
  return (state.lyrics && state.lyrics.lines) || [];
}

function renderLyrics() {
  const lines = activeLines();
  state.activeIndex = -1;
  state.lineEls = [];
  els.list.innerHTML = '';
  els.list.style.transform = 'translate3d(0, 0, 0)';

  if (lines.length === 0) {
    renderPlaceholder();
    return;
  }

  const mode = state.settings.lyricMode;
  // 翻译与注音二选一（外加「仅原词」），不会同时显示，避免一行占三行高
  const subField = mode === 'romaji' ? 'rm' : mode === 'translation' ? 'tr' : null;
  const frag = document.createDocumentFragment();

  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'line';

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = line.text;
    div.appendChild(text);

    const sub = subField ? line[subField] : '';
    if (sub) {
      const el = document.createElement('div');
      el.className = subField; // 'tr' 或 'rm'
      el.textContent = sub;
      div.appendChild(el);
    }

    frag.appendChild(div);
    state.lineEls.push(div);
  }

  els.list.appendChild(frag);
  updateListPadding();
  fitLineFontSize();
  scrollToActive();
  renderPlaceholder();
  renderSource();
}

function updateListPadding() {
  const h = els.viewport.clientHeight;
  els.list.style.paddingTop = `${Math.max(0, h / 2 - 24)}px`;
  els.list.style.paddingBottom = `${Math.max(0, h / 2 - 24)}px`;
}

// 下面几个尺寸常量必须和 styles.css 里 .line 的写法保持一致
const LINE_HEIGHT = 1.34; // .line .text 的 line-height
const SUB_K = 0.56 * 1.4; // 翻译行高度相对主歌词的比例
const SUB_MARGIN = 3;
// 缩放下限：只对「字号调得很大 + 句子特别长」的极端组合生效。
// 设得太高那种情况下依旧会裁字，这里让「长句一定能完整显示」成为硬保证
const MIN_LINE_SCALE = 0.3;

let measureCtx = null;
let measureFamily = '';

/** 用 canvas 量文字宽度，避免为了测量反复触发页面重排 */
function measureText(text, px, weight = 700) {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d');
    measureFamily = getComputedStyle(els.list).fontFamily || 'sans-serif';
  }
  measureCtx.font = `${weight} ${px}px ${measureFamily}`;
  // letter-spacing: 0.01em 的余量
  return measureCtx.measureText(text).width * 1.02;
}

/**
 * 逐行算一个字号缩放值。
 *
 * 长句折行后行数一多，总高度就会超出歌词区（上下还有 14% 的渐变遮罩），
 * 表现为首尾几行的字被裁掉。这里先按「宽度 × 行数」估一个初值，
 * 再用真实渲染出来的高度迭代收敛——纯公式算不准 inline-block 的基线留白。
 */
function fitLineFontSize() {
  if (!els.list || state.lineEls.length === 0) return;

  const base = Number(state.settings.fontSize) || 34;
  const style = getComputedStyle(els.list);
  const avail = Math.max(
    60,
    els.list.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0)
  );
  // 遮罩把上下各 14% 渐隐掉，留出余量；当前行还有 scale(1.06) 的放大，也一并扣掉
  const targetH = Math.max(base * LINE_HEIGHT, els.viewport.clientHeight * 0.7) / 1.06;

  for (const el of state.lineEls) {
    const span = el.querySelector('.text');
    if (!span) continue;

    el.style.setProperty('--line-scale', '1');

    const text = span.textContent || '';
    const natural = measureText(text, base);
    const subK = el.querySelector('.tr, .rm') ? SUB_K : 0;

    let scale = 1;
    if (natural > avail) {
      // 按「折成 rows 行时的高度」估个初值，省得一点点试
      const rows = Math.max(1, Math.ceil(natural / avail));
      scale = Math.min(1, targetH / (base * (rows * LINE_HEIGHT + subK) + SUB_MARGIN));
      scale = Math.max(MIN_LINE_SCALE, scale);
      el.style.setProperty('--line-scale', String(scale));
    }

    // 用真实高度收敛
    for (let i = 0; i < 5 && scale > MIN_LINE_SCALE; i += 1) {
      const h = el.offsetHeight;
      if (h <= targetH) break;
      scale = Math.max(MIN_LINE_SCALE, scale * (targetH / h) * 0.97);
      el.style.setProperty('--line-scale', String(scale));
    }

    // 折行行数是台阶式变化的，上面可能收过头，试探着放大回来一点
    const grown = Math.min(1, scale * 1.15);
    if (grown > scale) {
      el.style.setProperty('--line-scale', String(grown));
      if (el.offsetHeight > targetH) el.style.setProperty('--line-scale', String(scale));
    }
  }
}

function setActive(index) {
  if (index === state.activeIndex) return;

  const prev = state.lineEls[state.activeIndex];
  if (prev) prev.classList.remove('active');

  state.activeIndex = index;

  const synced = Boolean(state.lyrics && state.lyrics.synced);
  for (let i = 0; i < state.lineEls.length; i += 1) {
    const el = state.lineEls[i];
    const active = synced && i === index;
    el.classList.toggle('active', active);
    if (!synced) {
      el.style.opacity = '0.85';
      continue;
    }
    const d = index < 0 ? 5 : Math.abs(i - index);
    el.style.opacity = d === 0 ? '1' : d === 1 ? '0.55' : d === 2 ? '0.3' : d === 3 ? '0.16' : '0.08';
  }

  scrollToActive();
}

function scrollToActive() {
  const index = state.activeIndex;
  if (index < 0 || !state.lineEls[index]) {
    els.list.style.transform = 'translate3d(0, 0, 0)';
    return;
  }
  const el = state.lineEls[index];
  const viewH = els.viewport.clientHeight;
  const target = el.offsetTop + el.offsetHeight / 2 - viewH / 2;
  const max = Math.max(0, els.list.scrollHeight - viewH);
  els.list.style.transform = `translate3d(0, ${-clamp(target, 0, max)}px, 0)`;
}

function findActiveIndex(position) {
  const lines = activeLines();
  let lo = 0;
  let hi = lines.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= position) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function tick() {
  const position = currentPosition();

  if (state.settings.showProgress) {
    const duration = Number(state.player.durationSec) || 0;
    const pct = duration > 0 ? clamp((position / duration) * 100, 0, 100) : 0;
    els.progressBar.style.width = `${pct.toFixed(2)}%`;
  }

  // 只按行高亮：行内每个字的起止时间无法从 LRC 推出来，
  // 插值填充只会制造「看起来精确其实不准」的错觉。
  if (state.lyrics && state.lyrics.synced && state.lineEls.length > 0) {
    const index = findActiveIndex(position);
    if (index !== state.activeIndex) setActive(index);
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- 渲染：占位提示

function renderPlaceholder() {
  const lines = activeLines();
  if (lines.length > 0) {
    els.placeholder.classList.remove('visible');
    return;
  }

  const ls = state.lyrics.status;
  let icon = '♪';
  let text = '等待播放…';
  let hint = '在 Roon 中开始播放，歌词会自动出现在这里';

  if (state.conn !== 'connected') {
    icon = '🔌';
    text = state.conn === 'connecting' ? '正在连接歌词服务…' : '未连接到歌词服务';
    hint = `目标地址 ${state.settings.wsUrl}，请确认扩展已启动（extension 目录执行 node .）`;
  } else if (ls === 'searching') {
    icon = '🔍';
    text = '正在搜索歌词…';
    hint = state.player.title ? `《${state.player.title}》 - ${state.player.artist || '未知艺术家'}` : '';
  } else if (ls === 'notfound') {
    icon = '🤔';
    text = '未找到歌词';
    hint = '可以点击右上方 🔍 手动搜索匹配';
  } else if (ls === 'empty') {
    icon = '🎼';
    text = '纯音乐 / 暂无歌词';
    hint = '';
  } else if (ls === 'error') {
    icon = '⚠️';
    text = '歌词获取失败';
    hint =
      state.lyrics.error ||
      '网易云数据源都不可用：可在 config.json 里把 lyricSource 设为 direct（官方直连，免安装），或启动自建的 NeteaseCloudMusicApi 服务';
  } else if (!state.player.title) {
    icon = '♪';
    text = state.roon && state.roon.status === 'paired' ? '等待 Roon 播放…' : '等待 Roon Core 连接…';
    hint = state.roon && state.roon.message ? state.roon.message : '请在 Roon 设置 → 扩展 中启用「网易云歌词」';
  }

  els.placeholderIcon.textContent = icon;
  els.placeholderText.textContent = text;
  els.placeholderHint.textContent = hint;
  els.placeholder.classList.add('visible');
}

// ---------------------------------------------------------------- 设置

function applySettings(next, persist = false) {
  state.settings = Object.assign({}, state.settings, next || {});
  const s = state.settings;

  document.documentElement.style.setProperty('--font-size', `${s.fontSize}px`);
  document.documentElement.style.setProperty('--win-opacity', String(s.opacity));
  document.documentElement.style.setProperty('--lyric-fg', s.colorLyric || DEFAULT_LYRIC_COLORS.colorLyric);
  document.documentElement.style.setProperty('--lyric-sub', s.colorSub || DEFAULT_LYRIC_COLORS.colorSub);
  els.app.classList.toggle('locked', Boolean(s.locked));
  els.app.classList.toggle('pure', Boolean(s.pureMode));
  // 锁定时主进程会把窗口设为鼠标穿透，这里的本地状态要同步重置，
  // 否则下一次鼠标移到锁按钮上时不会触发「临时恢复可点击」
  if (s.locked) ignoringMouse = true;

  els.setWsUrl.value = s.wsUrl;
  els.setFont.value = String(s.fontSize);
  els.setFontVal.textContent = String(s.fontSize);
  els.setOpacity.value = String(Math.round(s.opacity * 100));
  els.setOpacityVal.textContent = String(Math.round(s.opacity * 100));
  els.setCover.checked = Boolean(s.showCover);
  els.setMode.value = s.lyricMode;
  els.setTitle.checked = Boolean(s.showTitle);
  els.setProgress.checked = Boolean(s.showProgress);
  els.setPure.checked = Boolean(s.pureMode);
  els.setOnTop.checked = Boolean(s.alwaysOnTop);

  // 颜色选择框跟着设置走（当前没在编辑它们时）
  const colors = [
    [els.setColorAll, s.colorLyric || DEFAULT_LYRIC_COLORS.colorLyric],
    [els.setColorLyric, s.colorLyric || DEFAULT_LYRIC_COLORS.colorLyric],
    [els.setColorSub, s.colorSub || DEFAULT_LYRIC_COLORS.colorSub],
  ];
  for (const [el, value] of colors) {
    if (el && document.activeElement !== el) el.value = value;
  }

  // 工具条和锁定浮动条里各有一个锁按钮，图标要保持一致
  for (const btn of document.querySelectorAll('[data-action="lock"]')) {
    btn.textContent = s.locked ? '🔒' : '🔓';
  }

  renderModeButton();

  const pureBtn = els.toolbar.querySelector('[data-action="pure"]');
  if (pureBtn) pureBtn.classList.toggle('active', Boolean(s.pureMode));

  renderMeta();
  renderCover();
  renderBadges();
  renderSource();

  // 字号变了行高就变了，必须重新算「过长歌词的缩放」和列表位置，
  // 否则当前高亮的歌词会停在按旧字号算出来的位置上（要等下一句才复位）
  updateListPadding();
  fitLineFontSize();
  scrollToActive();

  if (persist) api.setSettings && api.setSettings(state.settings);
}

function update(patch) {
  const needRender = 'lyricMode' in patch || 'showTranslation' in patch;
  applySettings(patch, true);
  if (needRender) renderLyrics();
}

/** 显示模式按钮：点亮当前生效的那一半（译 / 音），都没有则两个字都是灰的 */
function renderModeButton() {
  const modeBtn = els.toolbar.querySelector('[data-action="mode"]');
  if (!modeBtn) return;

  const mode = state.settings.lyricMode || 'translation';
  modeBtn.classList.remove('mode-translation', 'mode-romaji', 'mode-original');
  modeBtn.classList.add(`mode-${mode}`);

  const lyrics = state.lyrics || {};
  const hasSub =
    mode === 'romaji' ? Boolean(lyrics.hasRomaji) : mode === 'translation' ? Boolean(lyrics.hasTranslation) : false;

  modeBtn.title = `歌词显示：${LYRIC_MODE_LABELS[mode]}${hasSub ? '' : '（当前曲目没有对应内容）'}（快捷键 T）`;
}

/** 依次切换：原词+翻译 → 原词+注音 → 仅原词 → … */
function cycleLyricMode() {
  const cur = state.settings.lyricMode || 'translation';
  const next = LYRIC_MODES[(LYRIC_MODES.indexOf(cur) + 1) % LYRIC_MODES.length];
  update({ lyricMode: next });
  toast(`歌词显示：${LYRIC_MODE_LABELS[next]}`);
}

// ---------------------------------------------------------------- 面板

function closePanels() {
  els.panelSearch.hidden = true;
  els.panelSettings.hidden = true;
}

function openPanel(name) {
  closePanels();
  if (name === 'search') {
    els.panelSearch.hidden = false;
    els.searchInput.focus();
    els.searchInput.select();
  } else if (name === 'settings') {
    els.panelSettings.hidden = false;
  }
}

function renderSearchResults(data) {
  const items = data.candidates || [];
  els.searchResults.innerHTML = '';

  if (data.error) {
    const div = document.createElement('div');
    div.className = 'empty-tip';
    div.textContent = `搜索失败：${data.error}`;
    els.searchResults.appendChild(div);
    return;
  }

  if (items.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty-tip';
    div.textContent = '没有找到相关歌曲';
    els.searchResults.appendChild(div);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'result-item';

    const left = document.createElement('div');
    left.style.minWidth = '0';

    const name = document.createElement('div');
    name.className = 'result-name';
    name.textContent = item.name || '(未知)';

    const sub = document.createElement('div');
    sub.className = 'result-sub';
    sub.textContent = [item.artists && item.artists.join('、'), item.album].filter(Boolean).join(' · ');

    left.appendChild(name);
    left.appendChild(sub);

    const score = document.createElement('div');
    score.className = 'result-score';
    score.textContent = typeof item.score === 'number' ? Math.round(item.score) : '';

    row.appendChild(left);
    row.appendChild(score);

    row.addEventListener('click', () => {
      if (send({ type: 'select', songId: item.songId })) {
        toast(`已选择《${item.name}》`);
        closePanels();
      } else {
        toast('未连接歌词服务');
      }
    });

    els.searchResults.appendChild(row);
  }
}

function doSearch() {
  const keywords = els.searchInput.value.trim();
  if (!keywords) return;
  if (!send({ type: 'search', keywords })) {
    toast('未连接歌词服务');
    return;
  }
  state.searching = true;
  els.btnSearch.disabled = true;
  els.searchResults.innerHTML = '<div class="empty-tip">搜索中…</div>';
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents() {
  // 工具条和锁定浮动条共用同一套动作
  const handleAction = (action) => {
    if (action === 'mode') {
      cycleLyricMode();
    } else if (action === 'pure') {
      update({ pureMode: !state.settings.pureMode });
      toast(state.settings.pureMode ? '纯享模式：只显示歌词（P 键切换）' : '已退出纯享模式');
    } else if (action === 'search') openPanel('search');
    else if (action === 'settings') openPanel('settings');
    else if (action === 'refresh') {
      send({ type: 'refresh' });
      toast('已请求重新匹配歌词');
    } else if (action === 'lock') {
      update({ locked: !state.settings.locked });
      toast(state.settings.locked ? '已锁定，鼠标将穿透窗口（Alt+Shift+L 解锁）' : '已解锁');
    } else if (action === 'fontUp') {
      const next = Math.min(72, state.settings.fontSize + 4);
      update({ fontSize: next });
      toast(`字号 ${next}px`);
    } else if (action === 'fontDown') {
      const next = Math.max(16, state.settings.fontSize - 4);
      update({ fontSize: next });
      toast(`字号 ${next}px`);
    } else if (action === 'hide') {
      api.hide && api.hide();
    }
  };

  for (const bar of [els.toolbar, els.lockBar]) {
    if (!bar) continue;
    bar.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      handleAction(btn.dataset.action);
    });
  }

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => {
      const panel = document.getElementById(btn.dataset.close);
      if (panel) panel.hidden = true;
    });
  }

  els.btnSearch.addEventListener('click', doSearch);
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doSearch();
  });

  els.setWsUrl.addEventListener('change', () => {
    update({ wsUrl: els.setWsUrl.value.trim() || DEFAULT_SETTINGS.wsUrl });
    toast('正在重新连接…');
    retryCount = 0;
    connect();
  });

  els.setFont.addEventListener('input', () => update({ fontSize: Number(els.setFont.value) }));
  els.setOpacity.addEventListener('input', () => update({ opacity: Number(els.setOpacity.value) / 100 }));

  els.setMode.addEventListener('change', () => update({ lyricMode: els.setMode.value }));

  if (els.setZone) {
    const applyZone = () => {
      const zone = els.setZone.value.trim();
      if (zone === String((state.serverSettings && state.serverSettings.zone) || '')) return;
      if (!send({ type: 'config', patch: { zone } })) {
        toast('未连接歌词服务');
        return;
      }
      state.serverSettings = Object.assign({}, state.serverSettings, { zone });
      renderZoneField();
      toast(zone ? `只监听设备：${zone}` : '已改为自动识别正在播放的设备');
    };

    els.setZone.addEventListener('change', applyZone);
    els.setZone.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      applyZone();
      els.setZone.blur();
    });
  }

  // 「全局」改一次同时设置原歌词与翻译/注音两种颜色
  if (els.setColorAll) {
    els.setColorAll.addEventListener('input', () => {
      els.setColorLyric.value = els.setColorAll.value;
      els.setColorSub.value = els.setColorAll.value;
      update({ colorLyric: els.setColorAll.value, colorSub: els.setColorAll.value });
    });
  }
  if (els.setColorLyric) {
    els.setColorLyric.addEventListener('input', () => {
      els.setColorAll.value = els.setColorLyric.value;
      update({ colorLyric: els.setColorLyric.value });
    });
  }
  if (els.setColorSub) {
    els.setColorSub.addEventListener('input', () => update({ colorSub: els.setColorSub.value }));
  }
  if (els.btnColorReset) {
    els.btnColorReset.addEventListener('click', () => {
      els.setColorLyric.value = DEFAULT_LYRIC_COLORS.colorLyric;
      els.setColorSub.value = DEFAULT_LYRIC_COLORS.colorSub;
      els.setColorAll.value = DEFAULT_LYRIC_COLORS.colorLyric;
      update(Object.assign({}, DEFAULT_LYRIC_COLORS));
      toast('已恢复默认歌词颜色');
    });
  }

  const toggles = [
    [els.setCover, 'showCover'],
    [els.setTitle, 'showTitle'],
    [els.setProgress, 'showProgress'],
    [els.setPure, 'pureMode'],
    [els.setOnTop, 'alwaysOnTop'],
  ];
  for (const [el, key] of toggles) {
    el.addEventListener('change', () => update({ [key]: el.checked }));
  }

  els.btnReconnect.addEventListener('click', () => {
    retryCount = 0;
    connect();
    toast('正在重新连接…');
  });

  els.btnRefreshLyrics.addEventListener('click', () => {
    send({ type: 'refresh' });
    toast('已请求重新匹配歌词');
  });

  els.btnQuit.addEventListener('click', () => api.quit && api.quit());

  // 扩展侧的配置：改数据源 / NCM API 地址
  els.setSource.addEventListener('change', () => {
    const lyricSource = els.setSource.value;
    if (send({ type: 'config', patch: { lyricSource } })) {
      state.serverSettings.lyricSource = lyricSource;
      toast('已切换歌词数据源');
    } else {
      toast('未连接歌词服务');
    }
  });

  els.setNcmApi.addEventListener('change', () => {
    const ncmApi = els.setNcmApi.value.trim();
    if (!ncmApi) return;
    if (send({ type: 'config', patch: { ncmApi } })) {
      state.serverSettings.ncmApi = ncmApi;
      toast('已更新 NCM API 地址');
    } else {
      toast('未连接歌词服务');
    }
  });

  for (const btn of document.querySelectorAll('[data-offset]')) {
    btn.addEventListener('click', () => {
      const value = btn.dataset.offset;
      let message;
      if (value === 'reset') message = { type: 'offset', reset: true };
      else if (value === 'realign') message = { type: 'offset', realign: true };
      else message = { type: 'offset', delta: Number(value) };
      if (!send(message)) toast('未连接歌词服务');
      else if (value === 'realign') toast('正在向 Roon 请求最新进度…');
    });
  }

  for (const btn of document.querySelectorAll('[data-goffset]')) {
    btn.addEventListener('click', () => nudgeGlobalOffset(Number(btn.dataset.goffset)));
  }

  document.addEventListener('keydown', (event) => {
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (event.key === 'Escape') {
      closePanels();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.key) {
      case '[':
        if (!send({ type: 'offset', delta: -500 })) toast('未连接歌词服务');
        break;
      case ']':
        if (!send({ type: 'offset', delta: 500 })) toast('未连接歌词服务');
        break;
      case '\\':
        if (!send({ type: 'offset', reset: true })) toast('未连接歌词服务');
        break;
      case 'a':
      case 'A':
        if (!send({ type: 'offset', realign: true })) toast('未连接歌词服务');
        else toast('正在向 Roon 请求最新进度…');
        break;
      case 't':
      case 'T':
        cycleLyricMode();
        break;
      case 'p':
      case 'P':
        update({ pureMode: !state.settings.pureMode });
        toast(state.settings.pureMode ? '纯享模式：只显示歌词' : '已退出纯享模式');
        break;
      case 'l':
      case 'L':
        update({ locked: !state.settings.locked });
        toast(state.settings.locked ? '已锁定（Alt+Shift+L 解锁）' : '已解锁');
        break;
      case 'h':
      case 'H':
        api.hide && api.hide();
        break;
      case 's':
      case 'S':
        openPanel('settings');
        break;
      case 'f':
      case 'F':
        openPanel('search');
        break;
      case 'r':
      case 'R':
        send({ type: 'refresh' });
        toast('已请求重新匹配歌词');
        break;
      case 'ArrowUp':
        update({ fontSize: Math.min(72, state.settings.fontSize + 4) });
        break;
      case 'ArrowDown':
        update({ fontSize: Math.max(16, state.settings.fontSize - 4) });
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  els.viewport.addEventListener('wheel', (event) => {
    // 歌词列表跟随播放自动滚动，这里只阻止默认滚动
    event.preventDefault();
  }, { passive: false });

  window.addEventListener('resize', () => {
    updateListPadding();
    fitLineFontSize();
    scrollToActive();
  });

  if (api.onSettings) {
    api.onSettings((settings) => applySettings(settings, false));
  }

  if (api.onShortcuts) {
    api.onShortcuts((status) => {
      state.shortcuts = status || {};
      renderShortcuts();
    });
  }

  document.addEventListener('mousemove', (event) => {
    if (!state.settings.locked) return;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    // 锁定浮动条整条都可点（解锁 + 字号），不只是锁按钮本身
    const interactive = el && typeof el.closest === 'function' && el.closest('.lock-bar, [data-action="lock"]');
    updateIgnoringMouse(!interactive);
  });

  document.addEventListener('mouseleave', () => updateIgnoringMouse(true));

  // 自己实现窗口拖动。
  // 不能用 -webkit-app-region: drag —— Windows 下拖拽区域不派发鼠标事件，
  // :hover 也随之失效，纯享模式的悬停还原就只剩几个小按钮能用了。
  let dragPoint = null;

  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('button, input, select, textarea, .panel, .result-item')) {
      return;
    }
    if (state.settings.locked) return; // 锁定时不该拖动窗口
    dragPoint = { x: event.screenX, y: event.screenY };
    // 让主进程记下拖动开始时的窗口位置与尺寸，
    // 之后每次移动都基于它计算，避免尺寸被反复叠加
    if (api.dragStart) api.dragStart();
    event.preventDefault();
  });

  document.addEventListener('mousemove', (event) => {
    if (!dragPoint) return;
    const dx = event.screenX - dragPoint.x;
    const dy = event.screenY - dragPoint.y;
    dragPoint = { x: event.screenX, y: event.screenY };
    if (api.dragBy) api.dragBy(dx, dy);
    event.preventDefault();
  });

  const endDrag = () => {
    if (!dragPoint) return;
    dragPoint = null;
    if (api.dragEnd) api.dragEnd();
  };

  document.addEventListener('mouseup', endDrag);
  // 窗口失焦时收尾，避免残留一次「拖动中」的状态。
  // 不用 mouseleave：拖动过程中窗口是跟着鼠标走的，高速移动时可能短暂移出又移回，
  // 用它会让拖动中途断掉。
  window.addEventListener('blur', endDrag);

  if (api.onCommand) {
    api.onCommand((cmd) => {
      if (!cmd) return;
      if (cmd.type === 'open-panel') openPanel(cmd.panel);
      else if (cmd.type === 'refresh') send({ type: 'refresh' });
      else if (cmd.type === 'toast' && cmd.text) toast(cmd.text);
    });
  }
}

// ---------------------------------------------------------------- 启动

async function boot() {
  bindEvents();

  if (api.getSettings) {
    try {
      const settings = await api.getSettings();
      applySettings(settings, false);
    } catch (err) {
      /* ignore */
    }
  } else {
    applySettings(DEFAULT_SETTINGS, false);
  }

  if (api.getAppInfo) {
    try {
      const info = await api.getAppInfo();
      els.appInfo.textContent = `桌面歌词 v${info.version} · ${info.platform} · 设置文件: ${info.settingsFile || '-'}`;
    } catch (err) {
      /* ignore */
    }
  }

  if (api.getShortcuts) {
    try {
      state.shortcuts = await api.getShortcuts();
    } catch (err) {
      state.shortcuts = {};
    }
  }

  renderMeta();
  renderBadges();
  renderServerSettings();
  renderSourceInfo();
  renderPlaceholder();
  renderSource();
  renderOffset();
  renderShortcuts();

  connect();
  requestAnimationFrame(tick);

  // 定期校准（防止长时间播放后本地推算漂移）
  setInterval(() => {
    if (state.conn === 'connected' && state.player.state === 'playing') {
      send({ type: 'ping' });
    }
  }, 30000);
}

boot();
