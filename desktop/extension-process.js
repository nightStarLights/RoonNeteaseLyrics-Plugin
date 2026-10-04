'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * 内置的歌词扩展进程。
 *
 * 打包成 exe 后，用户机器上不一定装着 Node，所以这里用 Electron 自带的运行时来跑扩展：
 * 同一个 exe 加上 ELECTRON_RUN_AS_NODE=1 就是一个纯 Node 进程，
 * 扩展是纯 JS、没有原生模块，不需要任何额外安装即可启动。
 */

let child = null;
let lastExit = null;
let stopping = false; // 是不是我们自己要求停的，用来区分「正常停止」和「意外退出」
let recent = []; // 最近几行输出，启动失败时用来给用户一个能看懂的原因
const listeners = new Set();

const MAX_RECENT = 12;

/** 扩展目录：打包后在 resources/extension，开发时是上一级目录里的 extension */
function resolveDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'extension'));
  candidates.push(path.join(__dirname, '..', 'extension'));

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'index.js'))) return dir;
  }
  return null;
}

function available() {
  return Boolean(resolveDir());
}

function isRunning() {
  return Boolean(child);
}

/** 扩展自己读写 config.json / 缓存的位置。放在用户数据目录，
 *  这样程序目录只读或升级覆盖都不会丢配对信息。 */
function dataDir() {
  const dir = path.join(app.getPath('userData'), 'extension');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 首次运行把随包携带的配置复制过去，省去重新在 Roon 里配对 */
function seedConfig(dir) {
  const target = path.join(dir, 'config.json');
  if (fs.existsSync(target)) return;

  const bundled = path.join(resolveDir() || '', 'config.json');
  try {
    if (fs.existsSync(bundled)) fs.copyFileSync(bundled, target);
  } catch (err) {
    /* 复制失败也无所谓，扩展会按默认值自己创建 */
  }
}

function status() {
  return {
    available: available(),
    running: isRunning(),
    dir: resolveDir(),
    dataDir: (() => {
      try {
        return dataDir();
      } catch (err) {
        return null;
      }
    })(),
    lastExit,
    recent: recent.slice(-MAX_RECENT),
  };
}

function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const s = status();
  for (const fn of listeners) {
    try {
      fn(s);
    } catch (err) {
      /* ignore */
    }
  }
}

function pushLog(line) {
  const text = String(line).trimEnd();
  if (!text) return;
  recent.push(text);
  if (recent.length > MAX_RECENT * 2) recent = recent.slice(-MAX_RECENT);
  console.log(`[扩展] ${text}`);
}

function drain(stream) {
  if (!stream) return;
  stream.setEncoding('utf8');
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) pushLog(line);
  });
}

/** 把扩展的报错翻译成一句用户能看懂的话 */
function explain(exit) {
  const text = recent.join('\n');

  if (/EADDRINUSE/.test(text)) {
    const port = (text.match(/127\.0\.0\.1:(\d+)/) || [])[1] || '8687';
    return `端口 ${port} 已被占用：可能已经有一个歌词扩展在运行了`;
  }
  if (/Cannot find module/.test(text)) {
    const mod = (text.match(/Cannot find module '([^']+)'/) || [])[1] || '';
    return `扩展缺少依赖${mod ? `：${mod}` : ''}`;
  }
  if (exit && exit.code !== 0) {
    const lastError = recent.filter((l) => /error|Error/.test(l)).pop();
    return lastError || `扩展异常退出（code=${exit.code}）`;
  }
  return null;
}

/**
 * 启动扩展。
 * @returns {{ok:boolean, reason?:string}}
 */
function start() {
  if (child) return { ok: true };

  const dir = resolveDir();
  if (!dir) return { ok: false, reason: '没有找到扩展目录（extension/）' };

  // 数据目录建不出来就退回扩展目录本身
  let data = dir;
  try {
    data = dataDir();
    seedConfig(data);
  } catch (err) {
    data = dir;
  }

  recent = [];
  lastExit = null;

  try {
    child = spawn(process.execPath, [path.join(dir, 'index.js')], {
      cwd: data,
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',
        R2N_DATA_DIR: data,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    child = null;
    lastExit = { code: null, reason: err.message, at: Date.now() };
    emit();
    return { ok: false, reason: err.message };
  }

  drain(child.stdout);
  drain(child.stderr);

  child.on('error', (err) => {
    pushLog(`启动失败: ${err.message}`);
  });

  const startedAt = Date.now();
  child.on('exit', (code, signal) => {
    const uptime = Date.now() - startedAt;
    child = null;
    lastExit = { code, signal, at: Date.now(), uptimeMs: uptime, expected: stopping };
    stopping = false;
    pushLog(`扩展已退出 code=${code} signal=${signal}`);
    emit();
  });

  console.log(`[扩展] 已启动: ${path.join(dir, 'index.js')}（数据目录 ${data}）`);
  emit();
  return { ok: true };
}

function stop() {
  if (!child) return;
  stopping = true;
  try {
    child.kill();
  } catch (err) {
    stopping = false;
  }
  console.log('[扩展] 已停止');
}

module.exports = { available, isRunning, start, stop, status, onStatus, explain };
