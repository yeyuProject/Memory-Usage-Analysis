import { storageService } from '../services/storage';

describe('StorageService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('Settings', () => {
    it('should save and load settings', async () => {
      const settings = {
        language: 'en' as const,
        theme: 'dark' as const,
        defaultInterval: 2000,
        autoSave: false,
        maxHistoryDays: 7,
      };

      await storageService.saveSettings(settings);
      const loaded = await storageService.loadSettings();

      expect(loaded.language).toBe('en');
      expect(loaded.theme).toBe('dark');
      expect(loaded.defaultInterval).toBe(2000);
      expect(loaded.autoSave).toBe(false);
      expect(loaded.maxHistoryDays).toBe(7);
    });

    it('should return default settings when none saved', async () => {
      const settings = await storageService.loadSettings();

      expect(settings.language).toBe('zh');
      expect(settings.theme).toBe('light');
      expect(settings.defaultInterval).toBe(1000);
      expect(settings.autoSave).toBe(true);
      expect(settings.maxHistoryDays).toBe(30);
    });
  });

  describe('Recordings', () => {
    it('should save and load recordings', async () => {
      const recordings = [
        {
          id: 'test-1',
          config: {
            processId: 123,
            interval: 1000,
            duration: 60000,
            metrics: ['workingSetSize' as const],
          },
          startTime: Date.now(),
          data: [],
          status: 'completed' as const,
        },
      ];

      await storageService.saveRecordings(recordings);
      const loaded = await storageService.loadRecordings();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('test-1');
      expect(loaded[0].config.processId).toBe(123);
    });

    it('should return empty array when no recordings saved', async () => {
      const recordings = await storageService.loadRecordings();
      expect(recordings).toEqual([]);
    });

    it('should delete recording', async () => {
      const recordings = [
        {
          id: 'test-1',
          config: {
            processId: 123,
            interval: 1000,
            duration: 60000,
            metrics: ['workingSetSize' as const],
          },
          startTime: Date.now(),
          data: [],
          status: 'completed' as const,
        },
        {
          id: 'test-2',
          config: {
            processId: 456,
            interval: 2000,
            duration: 120000,
            metrics: ['commitSize' as const],
          },
          startTime: Date.now(),
          data: [],
          status: 'completed' as const,
        },
      ];

      await storageService.saveRecordings(recordings);
      await storageService.deleteRecording('test-1');
      const loaded = await storageService.loadRecordings();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('test-2');
    });
  });

  describe('Export/Import', () => {
    it('should export all data', async () => {
      const settings = {
        language: 'en' as const,
        theme: 'dark' as const,
        defaultInterval: 2000,
        autoSave: false,
        maxHistoryDays: 7,
      };

      await storageService.saveSettings(settings);
      const exported = await storageService.exportAllData();
      const parsed = JSON.parse(exported);

      expect(parsed).toHaveProperty('version');
      expect(parsed).toHaveProperty('exportedAt');
      expect(parsed).toHaveProperty('recordings');
      expect(parsed).toHaveProperty('settings');
      expect(parsed.settings.language).toBe('en');
    });

    it('should import data', async () => {
      const importData = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        recordings: [
          {
            id: 'imported-1',
            config: {
              processId: 789,
              interval: 1000,
              duration: 60000,
              metrics: ['workingSetSize'],
            },
            startTime: Date.now(),
            data: [],
            status: 'completed',
          },
        ],
        settings: {
          language: 'en',
          theme: 'dark',
          defaultInterval: 3000,
          autoSave: true,
          maxHistoryDays: 14,
        },
      };

      const result = await storageService.importData(JSON.stringify(importData));

      expect(result.recordings).toBe(1);
      expect(result.settings).toBe(true);

      const recordings = await storageService.loadRecordings();
      expect(recordings).toHaveLength(1);
      expect(recordings[0].id).toBe('imported-1');

      const settings = await storageService.loadSettings();
      expect(settings.language).toBe('en');
    });

    it('should throw error for invalid import data', async () => {
      await expect(storageService.importData('invalid')).rejects.toThrow();
    });
  });

  describe('Clear Data', () => {
    it('should clear all data', async () => {
      await storageService.saveSettings({
        language: 'en',
        theme: 'dark',
        defaultInterval: 2000,
        autoSave: false,
        maxHistoryDays: 7,
      });

      await storageService.clearAllData();

      const settings = await storageService.loadSettings();
      expect(settings.language).toBe('zh');
    });
  });

  describe('Storage Usage', () => {
    it('should get storage usage', async () => {
      await storageService.saveSettings({
        language: 'en',
        theme: 'dark',
        defaultInterval: 2000,
        autoSave: false,
        maxHistoryDays: 7,
      });

      const usage = await storageService.getStorageUsage();

      expect(usage).toHaveProperty('used');
      expect(usage).toHaveProperty('total');
      expect(usage.used).toBeGreaterThan(0);
      expect(usage.total).toBe(5 * 1024 * 1024);
    });
  });

  describe('formatStorageSize', () => {
    it('should format storage size correctly', () => {
      expect(storageService.formatStorageSize(0)).toBe('0 B');
      expect(storageService.formatStorageSize(1024)).toBe('1 KB');
      expect(storageService.formatStorageSize(1024 * 1024)).toBe('1 MB');
    });
  });
});
