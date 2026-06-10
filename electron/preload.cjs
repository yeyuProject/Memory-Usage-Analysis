/**
 * Preload script - CommonJS module loaded in renderer process
 * Exposes safe IPC API to the renderer via contextBridge
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getProcesses: () => ipcRenderer.invoke('get-processes'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getProcessMemory: (pid) => ipcRenderer.invoke('get-process-memory', pid),
  refreshNow: () => ipcRenderer.invoke('refresh-now'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  openFileLocation: (name) => ipcRenderer.invoke('open-file-location', name),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
});
