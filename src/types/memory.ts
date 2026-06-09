export interface ProcessMemoryInfo {
  processId: number;
  processName: string;
  workingSetSize: number;
  privateWorkingSetSize: number;
  commitSize: number;
  timestamp: number;
}

export interface SystemMemoryInfo {
  totalPhysicalMemory: number;
  availablePhysicalMemory: number;
  totalVirtualMemory: number;
  availableVirtualMemory: number;
  memoryLoad: number;
  timestamp: number;
}

export interface MemoryThreshold {
  workingSetSize?: number;
  privateWorkingSetSize?: number;
  commitSize?: number;
}

export type MemoryMetricType = 'workingSetSize' | 'privateWorkingSetSize' | 'commitSize';

export interface RecordingConfig {
  processId: number;
  interval: number; // milliseconds
  duration: number; // milliseconds
  metrics: MemoryMetricType[];
}

export interface RecordingSession {
  id: string;
  config: RecordingConfig;
  startTime: number;
  endTime?: number;
  data: ProcessMemoryInfo[];
  status: 'recording' | 'completed' | 'stopped';
}
