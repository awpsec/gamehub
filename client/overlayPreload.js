// Bridge for the in-game overlay window — deliberately tiny: session state,
// capture, close, exit-game, and safe external links. The embedded browser is
// a <webview>, so no navigation IPC is needed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getState: () => ipcRenderer.invoke('overlay:state'),
  close: () => ipcRenderer.invoke('overlay:close'),
  capture: () => ipcRenderer.invoke('overlay:capture'),
  deleteShot: (file) => ipcRenderer.invoke('overlay:deleteShot', file),
  exitGame: () => ipcRenderer.invoke('overlay:exitGame'),
  openExternal: (url) => ipcRenderer.invoke('overlay:openExternal', url),
  onShot: (cb) => ipcRenderer.on('overlay:shot', (e, entry) => cb(entry)),
});
