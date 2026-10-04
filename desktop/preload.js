'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('overlay', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getShortcuts: () => ipcRenderer.invoke('shortcuts:get'),

  onSettings: (cb) => subscribe('settings:changed', cb),
  onShortcuts: (cb) => subscribe('shortcuts:changed', cb),
  onCommand: (cb) => subscribe('app:command', cb),

  hide: () => ipcRenderer.send('window:hide'),
  show: () => ipcRenderer.send('window:show'),
  dragStart: () => ipcRenderer.send('window:drag-start'),
  dragBy: (dx, dy) => ipcRenderer.send('window:drag-by', dx, dy),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  setClickThrough: (enabled) => ipcRenderer.send('window:set-click-through', enabled),
  setIgnoringMouse: (ignoring) => ipcRenderer.send('window:ignoring-mouse', Boolean(ignoring)),
  setCapture: (capturing) => ipcRenderer.send('shortcuts:capture', Boolean(capturing)),
  reload: () => ipcRenderer.send('app:reload'),
  quit: () => ipcRenderer.send('app:quit'),
});
