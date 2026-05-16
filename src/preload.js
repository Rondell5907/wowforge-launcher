const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize:      ()              => ipcRenderer.invoke('app:minimize'),
  close:         ()              => ipcRenderer.invoke('app:close'),
  readConfig:    ()              => ipcRenderer.invoke('config:read'),
  openConfigDir: ()              => ipcRenderer.invoke('config:openDir'),
  readSession:   ()              => ipcRenderer.invoke('session:read'),
  clearSession:  ()              => ipcRenderer.invoke('session:clear'),
  dbConnect:     ()              => ipcRenderer.invoke('db:connect'),
  login:         (u, p, rem)    => ipcRenderer.invoke('auth:login', { username: u, password: p, rememberMe: rem }),
  fetchChars:    (accountId)    => ipcRenderer.invoke('chars:fetch', { accountId }),
  fetchArticles: ()              => ipcRenderer.invoke('articles:fetch'),
  launchWow:     ()              => ipcRenderer.invoke('wow:launch'),
});
