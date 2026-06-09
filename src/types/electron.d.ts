export interface ElectronAPI {
  getAppVersion: () => Promise<string>;
  onMemoryData: (callback: (data: MemoryData) => void) => () => void;
}

export interface MemoryData {
  processId: number;
  processName: string;
  workingSetSize: number;
  privateWorkingSetSize: number;
  commitSize: number;
  timestamp: number;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
