import {
  ProcessMemoryInfo,
  SystemMemoryInfo,
  RecordingConfig,
  RecordingSession,
  MemoryMetricType,
} from '../types/memory';

class MemoryService {
  private recordingSessions: Map<string, RecordingSession> = new Map();
  private recordingTimers: Map<string, NodeJS.Timeout> = new Map();

  async getProcessList(): Promise<{ pid: number; name: string }[]> {
    // Simulated process list - in real implementation, this would use Windows API
    return [
      { pid: 100, name: 'chrome.exe' },
      { pid: 200, name: 'firefox.exe' },
      { pid: 300, name: 'notepad.exe' },
      { pid: 400, name: 'code.exe' },
      { pid: 500, name: 'explorer.exe' },
      { pid: 600, name: 'svchost.exe' },
      { pid: 700, name: 'node.exe' },
      { pid: 800, name: 'python.exe' },
    ];
  }

  async getProcessMemoryInfo(processId: number): Promise<ProcessMemoryInfo> {
    // Simulated memory info - in real implementation, this would use Windows API
    const processList = await this.getProcessList();
    const process = processList.find((p) => p.pid === processId);

    if (!process) {
      throw new Error(`Process with PID ${processId} not found`);
    }

    const baseMemory = 100 * 1024 * 1024; // 100MB base
    const randomFactor = Math.random() * 0.5 + 0.75; // 75% to 125%

    return {
      processId,
      processName: process.name,
      workingSetSize: Math.floor(baseMemory * randomFactor * 1.5),
      privateWorkingSetSize: Math.floor(baseMemory * randomFactor),
      commitSize: Math.floor(baseMemory * randomFactor * 2),
      timestamp: Date.now(),
    };
  }

  async getSystemMemoryInfo(): Promise<SystemMemoryInfo> {
    // Simulated system memory info
    const totalPhysical = 16 * 1024 * 1024 * 1024; // 16GB
    const usedPercent = Math.random() * 0.4 + 0.3; // 30% to 70%
    const availablePhysical = totalPhysical * (1 - usedPercent);

    return {
      totalPhysicalMemory: totalPhysical,
      availablePhysicalMemory: Math.floor(availablePhysical),
      totalVirtualMemory: totalPhysical * 2,
      availableVirtualMemory: Math.floor(totalPhysical * 2 * (1 - usedPercent * 0.8)),
      memoryLoad: Math.floor(usedPercent * 100),
      timestamp: Date.now(),
    };
  }

  async startRecording(config: RecordingConfig): Promise<string> {
    const sessionId = `recording_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const session: RecordingSession = {
      id: sessionId,
      config,
      startTime: Date.now(),
      data: [],
      status: 'recording',
    };

    this.recordingSessions.set(sessionId, session);

    const timer = setInterval(async () => {
      const currentSession = this.recordingSessions.get(sessionId);
      if (!currentSession || currentSession.status !== 'recording') {
        clearInterval(timer);
        return;
      }

      const elapsed = Date.now() - currentSession.startTime;
      if (elapsed >= config.duration) {
        currentSession.status = 'completed';
        currentSession.endTime = Date.now();
        clearInterval(timer);
        return;
      }

      try {
        const memoryInfo = await this.getProcessMemoryInfo(config.processId);
        currentSession.data.push(memoryInfo);
      } catch (error) {
        console.error('Error recording memory data:', error);
      }
    }, config.interval);

    this.recordingTimers.set(sessionId, timer);

    return sessionId;
  }

  async stopRecording(sessionId: string): Promise<void> {
    const session = this.recordingSessions.get(sessionId);
    if (session) {
      session.status = 'stopped';
      session.endTime = Date.now();
    }

    const timer = this.recordingTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.recordingTimers.delete(sessionId);
    }
  }

  async getRecordingSession(sessionId: string): Promise<RecordingSession | undefined> {
    return this.recordingSessions.get(sessionId);
  }

  async getAllRecordingSessions(): Promise<RecordingSession[]> {
    return Array.from(this.recordingSessions.values());
  }

  async deleteRecordingSession(sessionId: string): Promise<void> {
    await this.stopRecording(sessionId);
    this.recordingSessions.delete(sessionId);
  }

  async getMemoryHistory(
    processId: number,
    startTime: number,
    endTime: number
  ): Promise<ProcessMemoryInfo[]> {
    // Simulated history data
    const data: ProcessMemoryInfo[] = [];
    const interval = 5000; // 5 seconds
    let currentTime = startTime;

    while (currentTime <= endTime) {
      const baseMemory = 100 * 1024 * 1024;
      const timeFactor = (currentTime - startTime) / (endTime - startTime);
      const memoryTrend = baseMemory * (1 + timeFactor * 0.5); // Gradual increase

      data.push({
        processId,
        processName: 'chrome.exe',
        workingSetSize: Math.floor(memoryTrend * 1.5 * (0.9 + Math.random() * 0.2)),
        privateWorkingSetSize: Math.floor(memoryTrend * (0.9 + Math.random() * 0.2)),
        commitSize: Math.floor(memoryTrend * 2 * (0.9 + Math.random() * 0.2)),
        timestamp: currentTime,
      });

      currentTime += interval;
    }

    return data;
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  getMetricName(metric: MemoryMetricType): string {
    const names: Record<MemoryMetricType, string> = {
      workingSetSize: '工作集',
      privateWorkingSetSize: '私有工作集',
      commitSize: '提交大小',
    };
    return names[metric];
  }

  getMetricColor(metric: MemoryMetricType): string {
    const colors: Record<MemoryMetricType, string> = {
      workingSetSize: '#1890ff',
      privateWorkingSetSize: '#52c41a',
      commitSize: '#faad14',
    };
    return colors[metric];
  }
}

export const memoryService = new MemoryService();
