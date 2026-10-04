'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { createIcon } = require('./icon');
const extension = require('./extension-process');

// 用户数据目录（%APPDATA%\<应用名>）跟着这个名字走，固定成纯 ASCII：
// 之前用的是带中文的「Roon 网易云歌词」，换个环境或换台机器时中文路径容易出岔子。
// 必须在第一次 app.getPath('userData') 之前设置。
app.setName('RoonNeteaseLyrics');

const LYRIC_MODES = ['translation', 'romaji', 'original'];

const DEFAULT_SETTINGS = {
  wsUrl: 'ws://127.0.0.1:8687/ws',
  alwaysOnTop: true,
  locked: false, // 鼠标穿透
  pureMode: false, // 纯享模式：完全透明，只显示歌词
  lyricMode: 'translation', // translation | romaji | original
  fontSize: 34,
  opacity: 1,
  showCover: true,
  showTitle: true,
  showProgress: true,
  bounds: null, // { x, y, width, height }
  // 全局快捷键。留空字符串表示不注册（避免和别的软件冲突）
  shortcuts: {
    lock: 'Alt+Shift+L',
    toggle: 'Alt+Shift+H',
    fontUp: 'Alt+Shift+Up',
    fontDown: 'Alt+Shift+Down',
    settings: 'Alt+Shift+S',
    search: 'Alt+Shift+F',
    refresh: 'Alt+Shift+R',
  },
};

const SHORTCUT_ACTIONS = {
  lock: { label: '锁定 / 解锁（鼠标穿透）', run: () => patchSettings({ locked: !settings.locked }) },
  toggle: { label: '显示 / 隐藏窗口', run: () => toggleWindow() },
  fontUp: { label: '放大字号', run: () => bumpFont(4) },
  fontDown: { label: '缩小字号', run: () => bumpFont(-4) },
  settings: { label: '打开设置面板', run: () => openPanel('settings') },
  search: { label: '打开搜索面板', run: () => openPanel('search') },
  refresh: { label: '重新匹配当前曲目歌词', run: () => sendCommand('refresh') },
};

let win = null;
let tray = null;
let settings = Object.assign({}, DEFAULT_SETTINGS);
let settingsFile = null;
let quitting = false;
let saveBoundsTimer = null;
let shortcutStatus = {}; // action -> { accelerator, ok, reason }

// ------------------------------------------------------------ 配置读写

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    settings.shortcuts = Object.assign({}, DEFAULT_SETTINGS.shortcuts, (raw && raw.shortcuts) || {});
    if (raw && raw.bounds) settings.bounds = raw.bounds;

    // 旧版本的 showTranslation 开关迁移到 lyricMode
    if (!raw || raw.lyricMode === undefined) {
      settings.lyricMode = raw && raw.showTranslation === false ? 'original' : DEFAULT_SETTINGS.lyricMode;
    }
    if (!LYRIC_MODES.includes(settings.lyricMode)) settings.lyricMode = DEFAULT_SETTINGS.lyricMode;
    delete settings.showTranslation;
  } catch (err) {
    settings = Object.assign({}, DEFAULT_SETTINGS);
  }
}

function persist() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    /* ignore */
  }
}

/**
 * 应用名从「Roon 网易云歌词」改成 RoonNeteaseLyrics 后，用户数据目录也变了。
 * 老目录还在的话，首次运行时把窗口设置（位置、配色、快捷键…）搬过来。
 *
 * 只搬 settings.json：扩展那份配置由随包携带的 config.json 提供，
 * 不搬旧目录里的（那份可能还留着早先绑定的播放区，搬过来等于把问题一起带过去）。
 */
function migrateLegacyUserData() {
  const target = app.getPath('userData');
  const legacy = path.join(path.dirname(target), 'Roon 网易云歌词');

  if (path.resolve(legacy) === path.resolve(target)) return;

  const from = path.join(legacy, 'settings.json');
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(path.join(target, 'settings.json'))) return;

  try {
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(from, path.join(target, 'settings.json'));
    console.log(`[迁移] 已把旧目录的窗口设置搬到 ${target}`);
  } catch (err) {
    console.warn('[迁移] 旧目录搬运失败，将使用默认设置:', err.message);
  }
}

function patchSettings(patch) {
  settings = Object.assign({}, settings, patch || {});
  applySettings();
  persist();
  return settings;
}

// ------------------------------------------------------------ 窗口

function computeDefaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(960, Math.round(workArea.width * 0.7));
  const height = 260;
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 80),
  };
}

function createWindow() {
  const bounds = Object.assign(computeDefaultBounds(), settings.bounds || {});

  win = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    title: 'Roon 网易云歌词',
    icon: nativeImage.createFromBuffer(createIcon(256)),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    applySettings();
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    updateTrayMenu();
  });

  const onBoundsChanged = () => {
    if (!win || win.isDestroyed()) return;
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      settings.bounds = win.getBounds();
      persist();
    }, 600);
  };
  win.on('moved', onBoundsChanged);
  win.on('resized', onBoundsChanged);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function setClickThrough(enabled) {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
  win.setFocusable(!enabled);
}

function applySettings() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(Boolean(settings.alwaysOnTop), 'screen-saver');
  setClickThrough(settings.locked);
  win.webContents.send('settings:changed', settings);
  win.webContents.send('shortcuts:changed', shortcutStatus);
  updateTrayMenu();
}

// ------------------------------------------------------------ 托盘

function updateTrayMenu() {
  if (!tray) return;

  const template = [
    {
      label: win && win.isVisible() ? '隐藏窗口' : '显示窗口',
      click: () => toggleWindow(),
    },
    { type: 'separator' },
    {
      label: '锁定（鼠标穿透）',
      type: 'checkbox',
      checked: Boolean(settings.locked),
      click: (item) => patchSettings({ locked: item.checked }),
    },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: Boolean(settings.alwaysOnTop),
      click: (item) => patchSettings({ alwaysOnTop: item.checked }),
    },
    { type: 'separator' },
    {
      label: '显示封面背景',
      type: 'checkbox',
      checked: Boolean(settings.showCover),
      click: (item) => patchSettings({ showCover: item.checked }),
    },
    {
      label: '歌词显示',
      submenu: [
        {
          label: '原词 + 翻译',
          type: 'radio',
          checked: settings.lyricMode === 'translation',
          click: () => patchSettings({ lyricMode: 'translation' }),
        },
        {
          label: '原词 + 注音（日文罗马音）',
          type: 'radio',
          checked: settings.lyricMode === 'romaji',
          click: () => patchSettings({ lyricMode: 'romaji' }),
        },
        {
          label: '仅原词',
          type: 'radio',
          checked: settings.lyricMode === 'original',
          click: () => patchSettings({ lyricMode: 'original' }),
        },
      ],
    },
    {
      label: '纯享模式（完全透明）',
      type: 'checkbox',
      checked: Boolean(settings.pureMode),
      click: (item) => patchSettings({ pureMode: item.checked }),
    },
    {
      label: '显示曲目信息',
      type: 'checkbox',
      checked: Boolean(settings.showTitle),
      click: (item) => patchSettings({ showTitle: item.checked }),
    },
    {
      label: '显示进度条',
      type: 'checkbox',
      checked: Boolean(settings.showProgress),
      click: (item) => patchSettings({ showProgress: item.checked }),
    },
    { type: 'separator' },
    {
      label: '字号',
      submenu: [
        { label: '放大', accelerator: settings.shortcuts.fontUp || undefined, click: () => bumpFont(4) },
        { label: '缩小', accelerator: settings.shortcuts.fontDown || undefined, click: () => bumpFont(-4) },
        { label: '重置', click: () => patchSettings({ fontSize: DEFAULT_SETTINGS.fontSize }) },
      ],
    },
    {
      label: '控制面板',
      accelerator: settings.shortcuts.settings || undefined,
      click: () => openPanel('settings'),
    },
    {
      label: '搜索歌词',
      accelerator: settings.shortcuts.search || undefined,
      click: () => openPanel('search'),
    },
    {
      label: '重新匹配歌词',
      accelerator: settings.shortcuts.refresh || undefined,
      click: () => sendCommand('refresh'),
    },
    {
      label: '重新加载窗口',
      click: () => {
        if (win && !win.isDestroyed()) win.webContents.reload();
      },
    },
    { type: 'separator' },
    {
      label: extension.isRunning() ? '歌词扩展：运行中（点击停止）' : '歌词扩展：已停止（点击启动）',
      enabled: extension.available(),
      click: () => toggleExtension(),
    },
    { type: 'separator' },
    { label: '退出', click: () => quit() },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip('Roon 网易云歌词');
}

function bumpFont(delta) {
  const next = Math.min(72, Math.max(16, Number(settings.fontSize || 34) + delta));
  patchSettings({ fontSize: next });
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
  }
  updateTrayMenu();
}

function openPanel(panel) {
  if (!win || win.isDestroyed()) return;
  const wasLocked = settings.locked;
  if (wasLocked) patchSettings({ locked: false });
  win.show();
  win.focus();
  win.webContents.send('app:command', { type: 'open-panel', panel });
}

function sendCommand(type) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('app:command', { type });
}

function quit() {
  quitting = true;
  app.quit();
}

// ------------------------------------------------------------ 内置歌词扩展

function notify(text) {
  console.log(`[提示] ${text}`);
  if (!win || win.isDestroyed()) return;
  win.webContents.send('app:command', { type: 'toast', text });
}

function toggleExtension() {
  if (extension.isRunning()) {
    extension.stop();
    updateTrayMenu();
    return;
  }

  const result = extension.start();
  updateTrayMenu();
  if (!result.ok) notify(`无法启动歌词扩展：${result.reason}`);
}

// ------------------------------------------------------------ 启动

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    migrateLegacyUserData();
    loadSettings();
    createWindow();

    const icon = nativeImage.createFromBuffer(createIcon(32));
    tray = new Tray(icon);
    updateTrayMenu();
    tray.on('click', () => toggleWindow());
    tray.on('double-click', () => toggleWindow());

    registerShortcuts();

    // 打包成 exe 后扩展随程序一起启动（用 Electron 自带的 Node 跑），
    // 用户不需要另外装 Node、也不用手动开第二个窗口。
    // 开发模式下不自动启动，方便和 start-all.bat 的流程并存。
    if (app.isPackaged) {
      const result = extension.start();
      if (!result.ok) notify(`歌词扩展未能启动：${result.reason}`);
    }

    extension.onStatus((status) => {
      updateTrayMenu();

      const exit = status.lastExit;
      if (!exit || exit.expected || !exit.at) return;
      const reason = extension.explain(exit);
      if (reason) notify(`歌词扩展已退出：${reason}`);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // 有托盘常驻，不退出
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    extension.stop();
  });
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutStatus = {};

  const shortcuts = settings.shortcuts || {};

  for (const [action, meta] of Object.entries(SHORTCUT_ACTIONS)) {
    const accelerator = String(shortcuts[action] || '').trim();
    const record = { accelerator, label: meta.label, ok: false, reason: '' };

    if (!accelerator) {
      record.reason = '未设置';
      shortcutStatus[action] = record;
      continue;
    }

    try {
      record.ok = globalShortcut.register(accelerator, meta.run);
      if (!record.ok) record.reason = '被其它程序占用或系统保留';
    } catch (err) {
      record.ok = false;
      record.reason = err.message;
    }

    if (!record.ok) {
      console.warn(`[shortcut] ${accelerator} 注册失败（${record.reason}）—— 功能「${meta.label}」仍可通过托盘菜单或窗口内按键使用`);
    }

    shortcutStatus[action] = record;
  }

  if (win && !win.isDestroyed()) {
    win.webContents.send('shortcuts:changed', shortcutStatus);
  }
}

// ------------------------------------------------------------ IPC

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (event, patch) => {
  const changedShortcuts = Boolean(patch && patch.shortcuts);
  const next = patchSettings(patch);
  if (changedShortcuts) registerShortcuts();
  return next;
});
ipcMain.handle('shortcuts:get', () => shortcutStatus);
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  settingsFile,
}));

// 窗口拖动改由渲染进程按鼠标位移驱动（不能再用 -webkit-app-region: drag，
// 否则拖拽区域不会触发 hover，纯享模式的悬停还原会失效）
//
// 关键：拖动期间写回的尺寸必须是「拖动开始时记下的那一个」。
// Windows 上无边框窗口的隐形边框会被 getBounds() 算进去（800 报成 802），
// 如果把它当作 width/height 再写回 setBounds，每移动一次就多算 1px，
// 结果就是拖一次窗口大一圈。实测 40 次移动会让窗口从 802x260 涨到 842x300。
let dragSession = null;

ipcMain.on('window:drag-start', () => {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  dragSession = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
});

ipcMain.on('window:drag-end', () => {
  dragSession = null;
});

ipcMain.on('window:drag-by', (event, dx, dy) => {
  if (!win || win.isDestroyed() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (dx === 0 && dy === 0) return;

  if (!dragSession) {
    const bounds = win.getBounds();
    dragSession = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  dragSession.x += dx;
  dragSession.y += dy;

  win.setBounds({
    x: Math.round(dragSession.x),
    y: Math.round(dragSession.y),
    width: dragSession.width,
    height: dragSession.height,
  });
});

ipcMain.on('window:hide', () => {
  if (win && !win.isDestroyed()) {
    win.hide();
    updateTrayMenu();
  }
});
ipcMain.on('window:show', () => {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
});
ipcMain.on('window:set-click-through', (event, enabled) => {
  patchSettings({ locked: Boolean(enabled) });
});
// 录制快捷键时先注销全部全局快捷键，否则按下的组合会被自己触发
ipcMain.on('shortcuts:capture', (event, capturing) => {
  if (capturing) globalShortcut.unregisterAll();
  else registerShortcuts();
});
// 锁定状态下让鼠标临时「不穿透」，用于点击锁按钮解锁。
// 只改本次交互状态，不动 locked 设置本身。
ipcMain.on('window:ignoring-mouse', (event, ignoring) => {
  if (!win || win.isDestroyed() || !settings.locked) return;
  const ignore = Boolean(ignoring);
  win.setIgnoreMouseEvents(ignore, { forward: true });
  win.setFocusable(!ignore);
});
ipcMain.on('app:quit', () => quit());
ipcMain.on('app:reload', () => {
  if (win && !win.isDestroyed()) win.webContents.reload();
});
