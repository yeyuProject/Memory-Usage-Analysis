import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getProcesses: () => ipcRenderer.invoke('get-processes'),
  getProcessMemory: (pid: number) => ipcRenderer.invoke('get-process-memory', pid),
  getSystemMemory: () => ipcRenderer.invoke('get-system-memory'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onMemoryData: (callback: (data: any) => void) => {
    ipcRenderer.on('memory-data', (_event, data) => callback(data));
    return () => {
      ipcRenderer.removeAllListeners('memory-data');
    };
  },
});
