'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('etOverlay', {
  init: () => ipcRenderer.invoke('overlay:init'),
  onData: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('overlay:data', h);
    return () => ipcRenderer.off('overlay:data', h);
  },
  select: (payload) => ipcRenderer.invoke('overlay:select', payload),
  cancel: () => ipcRenderer.invoke('overlay:cancel'),
  ready: () => ipcRenderer.send('overlay:ready')
});
