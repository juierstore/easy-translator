'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('etToolbar', {
  init: () => ipcRenderer.invoke('toolbar:init'),
  onData: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('toolbar:data', h);
    return () => ipcRenderer.off('toolbar:data', h);
  },
  action: (name, arg) => ipcRenderer.invoke('toolbar:action', { name, arg }),
  resize: (h) => ipcRenderer.invoke('toolbar:action', { name: 'resizeToolbar', arg: h })
});
