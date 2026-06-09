import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onMemoryData: (callback: (data: any) => void) => {
    ipcRenderer.on('memory-data', (_event, data) => callback(data));
    return () => {
      ipcRenderer.removeAllListeners('memory-data');
    };
  },
});
