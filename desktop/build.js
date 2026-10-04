'use strict';

/**
 * 打包成 Windows 可执行程序：
 *
 *   node build.js            （或双击 build.bat）
 *
 * 产物：../dist/RoonNeteaseLyrics-win32-x64/RoonNeteaseLyrics.exe
 *
 * 注意：扩展（../extension）会作为额外资源整包放进去（resources/extension）。
 * 主进程启动时用 ELECTRON_RUN_AS_NODE 复用 Electron 自带的 Node 去跑它，
 * 所以目标机器上不需要单独安装 Node，双击一个 exe 就能用。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { packager } = require('@electron/packager');

const { writeIcon } = require('./make-icon');

const ROOT = path.join(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
// 默认输出到项目根的 dist；R2N_DIST 可以指定到别处
// （上次的产物正被运行中的 exe 占用、删不掉时很有用）
const OUT = process.env.R2N_DIST ? path.resolve(process.env.R2N_DIST) : path.join(ROOT, 'dist');
const NAME = 'RoonNeteaseLyrics';

/**
 * 打包前确保扩展（extension/）的依赖已装好。
 * 扩展依赖 node-roon-api、ws 等运行时模块，靠 ELECTRON_RUN_AS_NODE 跑在 exe 里，
 * 如果这里缺 node_modules，打出来的 exe 里扩展一启动就会「找不到模块」直接退出。
 */
function ensureExtensionDeps() {
  const marker = path.join(EXTENSION_DIR, 'node_modules', 'ws');
  if (fs.existsSync(marker)) return;

  console.log('检测到扩展依赖尚未安装，正在安装 extension/ 依赖…');
  try {
    execSync('npm install --no-fund --no-audit', {
      cwd: EXTENSION_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });
  } catch (err) {
    throw new Error(
      '扩展依赖安装失败（extension/ 目录执行 npm install）。' +
      '请确认能联网、并能通过 git 访问 github.com，然后重试。\n' +
      (err && err.message ? err.message : err)
    );
  }

  if (!fs.existsSync(marker)) {
    throw new Error('扩展依赖安装后仍缺少 node_modules/ws，请检查 extension/package.json');
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  try {
    walk(dir);
  } catch (err) {
    /* ignore */
  }
  return total;
}

(async () => {
  const icon = writeIcon(path.join(__dirname, 'icon.ico'));

  ensureExtensionDeps();

  // 自己清掉上一次的产物：交给打包工具删的话，几千个文件会被当成批量删除拦下来
  const target = path.join(OUT, `${NAME}-win32-x64`);
  if (fs.existsSync(target)) {
    console.log('清理上一次的产物…');
    fs.rmSync(target, { recursive: true, force: true });
  }

  console.log('正在打包（首次会复制 Electron 运行时，需要一两分钟）…\n');

  const appPaths = await packager({
    dir: __dirname,
    name: NAME,
    platform: 'win32',
    arch: 'x64',
    out: OUT,
    overwrite: true,
    asar: true,
    prune: true,
    icon,
    extraResource: [path.join(ROOT, 'extension')],
    ignore: [/^\/\.tmp/, /^\/dist/, /^\/icon\.ico$/, /^\/build\.js$/, /^\/make-icon\.js$/],
  });

  const outDir = appPaths[0];
  const exe = path.join(outDir, `${NAME}.exe`);
  const mb = (dirSize(outDir) / 1024 / 1024).toFixed(0);

  console.log('\n打包完成：');
  console.log(`  目录: ${outDir}`);
  console.log(`  程序: ${exe}`);
  console.log(`  体积: 约 ${mb} MB`);
  console.log('\n双击 exe 即可运行：它会同时启动歌词扩展（连接 Roon）和歌词窗口。');
})().catch((err) => {
  console.error('\n打包失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
