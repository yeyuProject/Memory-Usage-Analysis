import { memoryService } from '../services/memory';

describe('MemoryService', () => {
  describe('getProcessList', () => {
    it('should return a list of processes', async () => {
      const processes = await memoryService.getProcessList();
      expect(Array.isArray(processes)).toBe(true);
      expect(processes.length).toBeGreaterThan(0);
      expect(processes[0]).toHaveProperty('pid');
      expect(processes[0]).toHaveProperty('name');
    });
  });

  describe('getProcessMemoryInfo', () => {
    it('should return memory info for a valid process', async () => {
      const processes = await memoryService.getProcessList();
      const validPid = processes[0].pid;
      const memoryInfo = await memoryService.getProcessMemoryInfo(validPid);

      expect(memoryInfo).toHaveProperty('processId', validPid);
      expect(memoryInfo).toHaveProperty('processName');
      expect(memoryInfo).toHaveProperty('workingSetSize');
      expect(memoryInfo).toHaveProperty('privateWorkingSetSize');
      expect(memoryInfo).toHaveProperty('commitSize');
      expect(memoryInfo).toHaveProperty('timestamp');
      expect(memoryInfo.workingSetSize).toBeGreaterThan(0);
    });

    it('should throw error for invalid process', async () => {
      await expect(memoryService.getProcessMemoryInfo(99999)).rejects.toThrow();
    });
  });

  describe('getSystemMemoryInfo', () => {
    it('should return system memory info', async () => {
      const systemInfo = await memoryService.getSystemMemoryInfo();

      expect(systemInfo).toHaveProperty('totalPhysicalMemory');
      expect(systemInfo).toHaveProperty('availablePhysicalMemory');
      expect(systemInfo).toHaveProperty('totalVirtualMemory');
      expect(systemInfo).toHaveProperty('availableVirtualMemory');
      expect(systemInfo).toHaveProperty('memoryLoad');
      expect(systemInfo).toHaveProperty('timestamp');
      expect(systemInfo.totalPhysicalMemory).toBeGreaterThan(0);
      expect(systemInfo.memoryLoad).toBeGreaterThanOrEqual(0);
      expect(systemInfo.memoryLoad).toBeLessThanOrEqual(100);
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(memoryService.formatBytes(0)).toBe('0 Bytes');
      expect(memoryService.formatBytes(1024)).toBe('1 KB');
      expect(memoryService.formatBytes(1024 * 1024)).toBe('1 MB');
      expect(memoryService.formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });
  });

  describe('getMetricName', () => {
    it('should return correct metric names', () => {
      expect(memoryService.getMetricName('workingSetSize')).toBe('工作集');
      expect(memoryService.getMetricName('privateWorkingSetSize')).toBe('私有工作集');
      expect(memoryService.getMetricName('commitSize')).toBe('提交大小');
    });
  });

  describe('getMetricColor', () => {
    it('should return correct metric colors', () => {
      expect(memoryService.getMetricColor('workingSetSize')).toBe('#1890ff');
      expect(memoryService.getMetricColor('privateWorkingSetSize')).toBe('#52c41a');
      expect(memoryService.getMetricColor('commitSize')).toBe('#faad14');
    });
  });

  describe('Recording', () => {
    it('should start and stop recording', async () => {
      const processes = await memoryService.getProcessList();
      const validPid = processes[0].pid;

      const sessionId = await memoryService.startRecording({
        processId: validPid,
        interval: 100,
        duration: 1000,
        metrics: ['workingSetSize'],
      });

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');

      const session = await memoryService.getRecordingSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.status).toBe('recording');

      await memoryService.stopRecording(sessionId);

      const stoppedSession = await memoryService.getRecordingSession(sessionId);
      expect(stoppedSession?.status).toBe('stopped');
    });

    it('should get all recording sessions', async () => {
      const sessions = await memoryService.getAllRecordingSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('should delete recording session', async () => {
      const processes = await memoryService.getProcessList();
      const validPid = processes[0].pid;

      const sessionId = await memoryService.startRecording({
        processId: validPid,
        interval: 100,
        duration: 1000,
        metrics: ['workingSetSize'],
      });

      await memoryService.stopRecording(sessionId);
      await memoryService.deleteRecordingSession(sessionId);

      const session = await memoryService.getRecordingSession(sessionId);
      expect(session).toBeUndefined();
    });
  });
});
