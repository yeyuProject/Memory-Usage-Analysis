export interface ElectronAPI {
  getProcesses: () => Promise<{ pid: number; name: string; memoryUsage: number }[]>;
  getProcessMemory: (pid: number) => Promise<{
    workingSetSize: number;
    privateWorkingSetSize: number;
    commitSize: number;
  } | null>;
  getSystemMemory: () => Promise<{
    totalPhysicalMemory: number;
    availablePhysicalMemory: number;
    memoryLoad: number;
  } | null>;
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
