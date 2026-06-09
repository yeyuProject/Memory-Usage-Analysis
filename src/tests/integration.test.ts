import { memoryService } from '../services/memory';
import { storageService } from '../services/storage';

describe('Integration Tests', () => {
  describe('Memory Service + Recording Flow', () => {
    it('should complete full recording workflow', async () => {
      const processes = await memoryService.getProcessList();
      expect(processes.length).toBeGreaterThan(0);

      const targetProcess = processes[0];
      const memoryInfo = await memoryService.getProcessMemoryInfo(targetProcess.pid);
      expect(memoryInfo.processId).toBe(targetProcess.pid);

      const sessionId = await memoryService.startRecording({
        processId: targetProcess.pid,
        interval: 100,
        duration: 500,
        metrics: ['workingSetSize', 'privateWorkingSetSize', 'commitSize'],
      });

      expect(sessionId).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 600));

      const session = await memoryService.getRecordingSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.data.length).toBeGreaterThan(0);

      await memoryService.stopRecording(sessionId);

      const stoppedSession = await memoryService.getRecordingSession(sessionId);
      expect(stoppedSession?.status).toBe('stopped');
      expect(stoppedSession?.endTime).toBeDefined();

      await memoryService.deleteRecordingSession(sessionId);
      const deletedSession = await memoryService.getRecordingSession(sessionId);
      expect(deletedSession).toBeUndefined();
    }, 10000);
  });

  describe('Storage Service + Recording Persistence', () => {
    beforeEach(async () => {
      await storageService.clearAllData();
    });

    it('should persist recordings across operations', async () => {
      const processes = await memoryService.getProcessList();
      const targetProcess = processes[0];

      const sessionId = await memoryService.startRecording({
        processId: targetProcess.pid,
        interval: 100,
        duration: 300,
        metrics: ['workingSetSize'],
      });

      await new Promise((resolve) => setTimeout(resolve, 400));
      await memoryService.stopRecording(sessionId);

      const session = await memoryService.getRecordingSession(sessionId);
      expect(session).toBeDefined();

      if (session) {
        await storageService.saveRecordings([session]);
        const loadedRecordings = await storageService.loadRecordings();
        expect(loadedRecordings.length).toBe(1);
        expect(loadedRecordings[0].id).toBe(sessionId);
      }

      await memoryService.deleteRecordingSession(sessionId);
    }, 10000);

    it('should export and import data correctly', async () => {
      const settings = {
        language: 'en' as const,
        theme: 'dark' as const,
        defaultInterval: 2000,
        autoSave: false,
        maxHistoryDays: 7,
      };

      await storageService.saveSettings(settings);

      const exportedData = await storageService.exportAllData();
      expect(exportedData).toBeDefined();

      await storageService.clearAllData();
      const clearedSettings = await storageService.loadSettings();
      expect(clearedSettings.language).toBe('zh');

      const importResult = await storageService.importData(exportedData);
      expect(importResult.settings).toBe(true);

      const restoredSettings = await storageService.loadSettings();
      expect(restoredSettings.language).toBe('en');
      expect(restoredSettings.theme).toBe('dark');
    });
  });

  describe('System Memory Monitoring', () => {
    it('should get system memory info with valid values', async () => {
      const systemInfo = await memoryService.getSystemMemoryInfo();

      expect(systemInfo.totalPhysicalMemory).toBeGreaterThan(0);
      expect(systemInfo.availablePhysicalMemory).toBeGreaterThan(0);
      expect(systemInfo.availablePhysicalMemory).toBeLessThanOrEqual(
        systemInfo.totalPhysicalMemory
      );
      expect(systemInfo.memoryLoad).toBeGreaterThanOrEqual(0);
      expect(systemInfo.memoryLoad).toBeLessThanOrEqual(100);
      expect(systemInfo.timestamp).toBeGreaterThan(0);
    });

    it('should get memory history with correct structure', async () => {
      const startTime = Date.now() - 60000;
      const endTime = Date.now();

      const history = await memoryService.getMemoryHistory(100, startTime, endTime);

      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);

      history.forEach((item) => {
        expect(item.processId).toBe(100);
        expect(item.workingSetSize).toBeGreaterThan(0);
        expect(item.privateWorkingSetSize).toBeGreaterThan(0);
        expect(item.commitSize).toBeGreaterThan(0);
        expect(item.timestamp).toBeGreaterThanOrEqual(startTime);
        expect(item.timestamp).toBeLessThanOrEqual(endTime);
      });
    });
  });

  describe('Data Formatting', () => {
    it('should format bytes correctly for various sizes', () => {
      expect(memoryService.formatBytes(0)).toBe('0 Bytes');
      expect(memoryService.formatBytes(512)).toBe('512 Bytes');
      expect(memoryService.formatBytes(1024)).toBe('1 KB');
      expect(memoryService.formatBytes(1536)).toBe('1.5 KB');
      expect(memoryService.formatBytes(1048576)).toBe('1 MB');
      expect(memoryService.formatBytes(1073741824)).toBe('1 GB');
    });

    it('should get correct metric names', () => {
      const metrics = ['workingSetSize', 'privateWorkingSetSize', 'commitSize'] as const;

      metrics.forEach((metric) => {
        const name = memoryService.getMetricName(metric);
        expect(name).toBeDefined();
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
      });
    });

    it('should get correct metric colors', () => {
      const metrics = ['workingSetSize', 'privateWorkingSetSize', 'commitSize'] as const;

      metrics.forEach((metric) => {
        const color = memoryService.getMetricColor(metric);
        expect(color).toBeDefined();
        expect(color.startsWith('#')).toBe(true);
        expect(color.length).toBe(7);
      });
    });
  });

  describe('Storage Service Edge Cases', () => {
    it('should handle multiple save/load cycles', async () => {
      for (let i = 0; i < 5; i++) {
        await storageService.saveSettings({
          language: i % 2 === 0 ? 'zh' : 'en',
          theme: i % 2 === 0 ? 'light' : 'dark',
          defaultInterval: 1000 * (i + 1),
          autoSave: i % 2 === 0,
          maxHistoryDays: i + 1,
        });
      }

      const settings = await storageService.loadSettings();
      expect(settings.language).toBe('en');
      expect(settings.theme).toBe('dark');
      expect(settings.defaultInterval).toBe(5000);
    });

    it('should handle empty recordings array', async () => {
      await storageService.saveRecordings([]);
      const recordings = await storageService.loadRecordings();
      expect(recordings).toEqual([]);
    });

    it('should handle storage usage calculation', async () => {
      await storageService.saveSettings({
        language: 'zh',
        theme: 'light',
        defaultInterval: 1000,
        autoSave: true,
        maxHistoryDays: 30,
      });

      const usage = await storageService.getStorageUsage();
      expect(usage.used).toBeGreaterThan(0);
      expect(usage.total).toBe(5 * 1024 * 1024);
      expect(usage.used).toBeLessThan(usage.total);
    });
  });
});
