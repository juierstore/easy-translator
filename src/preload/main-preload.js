'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, cb) => {
  const h = (_e, d) => cb(d);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};

contextBridge.exposeInMainWorld('et', {
  meta: {
    langs: () => ipcRenderer.invoke('meta:langs'),
    info: () => ipcRenderer.invoke('meta:app'),
    openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    quit: () => ipcRenderer.invoke('app:quit')
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMax: () => ipcRenderer.invoke('win:isMax')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (p) => ipcRenderer.invoke('settings:patch', p),
    setKey: (k) => ipcRenderer.invoke('settings:setKey', k),
    testKey: () => ipcRenderer.invoke('settings:testKey')
  },
  history: {
    list: (q) => ipcRenderer.invoke('history:list', q),
    get: (id) => ipcRenderer.invoke('history:get', id),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    clear: () => ipcRenderer.invoke('history:clear'),
    reveal: (id) => ipcRenderer.invoke('history:reveal', id)
  },
  translate: {
    text: (payload) => ipcRenderer.invoke('translate:text', payload),
    onDelta: (cb) => listen('translate:delta', cb)
  },
  capture: {
    start: () => ipcRenderer.invoke('capture:start')
  },
  on: {
    navigate: (cb) => listen('app:navigate', cb),
    toast: (cb) => listen('app:toast', cb),
    historyAdded: (cb) => listen('history:added', cb)
  }
});
