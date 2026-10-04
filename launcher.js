#!/usr/bin/env node
'use strict';

/**
 * 统一启动器 —— 避免弹出一堆控制台窗口。
 *
 *   node launcher.js start   启动 Roon 扩展 + 桌面歌词窗口
 *   node launcher.js stop    停止上面启动的所有进程
 *   node launcher.js status  查看运行状态
 *
 * 歌词默认走「官方直连」（不依赖任何外部依赖包），不需要另外跑网易云 API 服务；
 * 如果本机装了可选的内置库（npm install NeteaseCloudMusicApi），会优先用它。
 * 后台服务以隐藏窗口 + 分离进程运行，日志写到 logs/ 目录。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const PID_FILE = path.join(LOG_DIR, 'pids.json');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const DESKTOP_DIR = path.join(ROOT, 'desktop');

const EXTENSION_PORT = process.env.EXTENSION_PORT || '8687';

const action = (process.argv[2] || 'start').toLowerCase();

// ---------------------------------------------------------------- 工具

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readPids() {
  try {
    const data = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

function writePids(list) {
  fs.writeFileSync(PID_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch (err) {
      /* 继续尝试普通 kill */
    }
  }
  try {
    process.kill(pid);
  } catch (err) {
    /* 已退出 */
  }
}

function logStream(name) {
  const fd = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  return { fd };
}

/** 以隐藏窗口、分离进程的方式启动，父进程退出后子进程继续存活 */
function launch({ name, command, args, cwd, env }) {
  ensureLogDir();
  const { fd } = logStream(name);

  const child = spawn(command, args, {
    cwd,
    env: Object.assign({}, process.env, env || {}),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });

  child.unref();
  return child.pid;
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitFor(url, seconds, label) {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (await httpGet(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------- stop

function stop() {
  const pids = readPids().filter((p) => alive(p.pid));
  if (pids.length === 0) {
    console.log('没有由启动器启动的进程在运行。');
    writePids([]);
    return;
  }
  for (const p of pids) {
    console.log(`停止 ${p.name} (pid ${p.pid})…`);
    killTree(p.pid);
  }
  writePids([]);
  console.log('已全部停止。');
}

// ---------------------------------------------------------------- status

async function status() {
  const pids = readPids();

  console.log('进程：');
  if (pids.length === 0) console.log('  （无记录）');
  for (const p of pids) {
    console.log(`  ${alive(p.pid) ? '运行中' : '已退出'}  ${p.name}  pid=${p.pid}`);
  }

  const ext = await httpGet(`http://127.0.0.1:${EXTENSION_PORT}/health`);

  console.log('');
  console.log(`Roon 歌词扩展 (${EXTENSION_PORT}): ${ext ? '可用' : '不可用'}`);
}

// ---------------------------------------------------------------- start

async function start() {
  ensureLogDir();

  const old = readPids().filter((p) => alive(p.pid));
  if (old.length > 0) {
    console.log('检测到启动器已在运行，先停止旧进程…');
    stop();
    await new Promise((r) => setTimeout(r, 800));
  }

  const pids = [];

  // 1. Roon 扩展（歌词走官方直连或内置库，都无需额外服务）
  const extensionPid = launch({
    name: 'extension',
    command: process.execPath,
    args: ['index.js'],
    cwd: EXTENSION_DIR,
  });
  pids.push({ name: 'extension', pid: extensionPid, port: EXTENSION_PORT });
  console.log(`[1/2] Roon 歌词扩展已启动 (pid ${extensionPid}, 端口 ${EXTENSION_PORT})`);

  const ok = await waitFor(`http://127.0.0.1:${EXTENSION_PORT}/health`, 15, 'extension');
  if (!ok) {
    console.warn('      扩展启动较慢或失败，请查看 logs/extension.log');
  }

  // 2. 桌面歌词窗口
  const electronBin = path.join(
    DESKTOP_DIR,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  );

  if (!fs.existsSync(electronBin)) {
    console.error('[2/2] 找不到 Electron，请先执行：cd desktop && npm install');
    writePids(pids);
    process.exitCode = 1;
    return;
  }

  const desktopPid = launch({
    name: 'desktop',
    command: electronBin,
    args: ['.'],
    cwd: DESKTOP_DIR,
  });
  pids.push({ name: 'desktop', pid: desktopPid });
  console.log(`[2/2] 桌面歌词窗口已启动 (pid ${desktopPid})`);

  writePids(pids);

  console.log('');
  console.log('全部启动完成。');
  console.log('  · 首次使用请在 Roon 的「设置 → 扩展」启用「网易云歌词 (NetEase Lyrics)」');
  console.log(`  · 服务状态 / 时间轴诊断: http://127.0.0.1:${EXTENSION_PORT}/api/diagnostics`);
  console.log(`  · 日志目录: ${LOG_DIR}`);
  console.log('  · 停止全部进程: 双击 stop-all.bat');
}

(async () => {
  try {
    if (action === 'stop') stop();
    else if (action === 'status') await status();
    else await start();
  } catch (err) {
    console.error('启动失败:', err.stack || err.message);
    process.exitCode = 1;
  }
})();
