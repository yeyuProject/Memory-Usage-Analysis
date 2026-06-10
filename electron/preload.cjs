/**
 * Preload script - CommonJS module loaded in renderer process
 * Exposes safe IPC API to the renderer via contextBridge
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getProcesses: () => ipcRenderer.invoke('get-processes'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getProcessMemory: (pid) => ipcRenderer.invoke('get-process-memory', pid),
  getProcessHistory: () => ipcRenderer.invoke('get-process-history'),
  refreshNow: () => ipcRenderer.invoke('refresh-now'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  openFileLocation: (name) => ipcRenderer.invoke('open-file-location', name),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
  // Persistent recording API
  startRecording: (opts) => ipcRenderer.invoke('start-recording', opts),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  getRecordingStatus: () => ipcRenderer.invoke('get-recording-status'),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  deleteRecording: (id) => ipcRenderer.invoke('delete-recording', id),
  exportRecordingCsv: (id) => ipcRenderer.invoke('export-recording-csv', id),
});
