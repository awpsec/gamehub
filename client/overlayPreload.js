// Bridge for the in-game overlay window — session state, capture, close,
// exit-game, external links, and the persistent overlay-browser profile
// (bookmarks / omnibox history). The <webview> guest keeps its own cookies
// via partition="persist:gamehub-overlay".
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getState: () => ipcRenderer.invoke('overlay:state'),
  close: () => ipcRenderer.invoke('overlay:close'),
  capture: () => ipcRenderer.invoke('overlay:capture'),
  deleteShot: (file) => ipcRenderer.invoke('overlay:deleteShot', file),
  exitGame: () => ipcRenderer.invoke('overlay:exitGame'),
  openExternal: (url) => ipcRenderer.invoke('overlay:openExternal', url),
  onShot: (cb) => ipcRenderer.on('overlay:shot', (e, entry) => cb(entry)),

  browserProfile: () => ipcRenderer.invoke('overlay:browserProfile'),
  resolveOmnibox: (input) => ipcRenderer.invoke('overlay:resolveOmnibox', input),
  suggest: (query) => ipcRenderer.invoke('overlay:suggest', query),
  recordVisit: (payload) => ipcRenderer.invoke('overlay:recordVisit', payload),
  recordSearch: (query) => ipcRenderer.invoke('overlay:recordSearch', query),
  bookmarks: () => ipcRenderer.invoke('overlay:bookmarks'),
  addBookmark: (payload) => ipcRenderer.invoke('overlay:addBookmark', payload),
  removeBookmark: (idOrUrl) => ipcRenderer.invoke('overlay:removeBookmark', idOrUrl),
  isBookmarked: (url) => ipcRenderer.invoke('overlay:isBookmarked', url),
  saveLayout: (payload) => ipcRenderer.invoke('overlay:saveLayout', payload),
  browserUa: () => ipcRenderer.invoke('overlay:browserUa'),
  onShown: (cb) => ipcRenderer.on('overlay:shown', (e, payload) => cb(payload)),
  onHiding: (cb) => ipcRenderer.on('overlay:hiding', () => cb()),
});
