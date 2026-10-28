'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('etResult', {
  init: () => ipcRenderer.invoke('result:init'),
  onData: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('result:data', h);
    return () => ipcRenderer.off('result:data', h);
  },
  action: (name, arg) => ipcRenderer.invoke('result:action', { name, arg }),
  onExport: (cb) => {
    const h = () => cb();
    ipcRenderer.on('result:export', h);
    return () => ipcRenderer.off('result:export', h);
  },
  sendExport: (dataUrl) => ipcRenderer.send('result:export-reply', dataUrl),
  close: () => ipcRenderer.invoke('result:action', { name: 'close' })
});
