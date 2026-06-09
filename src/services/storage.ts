import { RecordingSession } from '../types/memory';

const STORAGE_KEYS = {
  RECORDINGS: 'memory_analysis_recordings',
  SETTINGS: 'memory_analysis_settings',
  NOTIFICATION_RULES: 'memory_analysis_notification_rules',
} as const;

export interface AppSettings {
  language: 'zh' | 'en';
  theme: 'light' | 'dark';
  defaultInterval: number;
  autoSave: boolean;
  maxHistoryDays: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh',
  theme: 'light',
  defaultInterval: 1000,
  autoSave: true,
  maxHistoryDays: 30,
};

class StorageService {
  async saveRecordings(recordings: RecordingSession[]): Promise<void> {
    try {
      const data = JSON.stringify(recordings);
      localStorage.setItem(STORAGE_KEYS.RECORDINGS, data);
    } catch (error) {
      console.error('Failed to save recordings:', error);
      throw new Error('保存录制数据失败');
    }
  }

  async loadRecordings(): Promise<RecordingSession[]> {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.RECORDINGS);
      if (!data) return [];
      return JSON.parse(data);
    } catch (error) {
      console.error('Failed to load recordings:', error);
      return [];
    }
  }

  async deleteRecording(sessionId: string): Promise<void> {
    try {
      const recordings = await this.loadRecordings();
      const filtered = recordings.filter((r) => r.id !== sessionId);
      await this.saveRecordings(filtered);
    } catch (error) {
      console.error('Failed to delete recording:', error);
      throw new Error('删除录制数据失败');
    }
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    try {
      const data = JSON.stringify(settings);
      localStorage.setItem(STORAGE_KEYS.SETTINGS, data);
    } catch (error) {
      console.error('Failed to save settings:', error);
      throw new Error('保存设置失败');
    }
  }

  async loadSettings(): Promise<AppSettings> {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (!data) return DEFAULT_SETTINGS;
      return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    } catch (error) {
      console.error('Failed to load settings:', error);
      return DEFAULT_SETTINGS;
    }
  }

  async exportAllData(): Promise<string> {
    try {
      const recordings = await this.loadRecordings();
      const settings = await this.loadSettings();

      const exportData = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        recordings,
        settings,
      };

      return JSON.stringify(exportData, null, 2);
    } catch (error) {
      console.error('Failed to export data:', error);
      throw new Error('导出数据失败');
    }
  }

  async importData(jsonData: string): Promise<{ recordings: number; settings: boolean }> {
    try {
      const data = JSON.parse(jsonData);

      if (!data.version || !data.exportedAt) {
        throw new Error('无效的数据格式');
      }

      let recordingsCount = 0;
      if (data.recordings && Array.isArray(data.recordings)) {
        await this.saveRecordings(data.recordings);
        recordingsCount = data.recordings.length;
      }

      let settingsUpdated = false;
      if (data.settings) {
        await this.saveSettings(data.settings);
        settingsUpdated = true;
      }

      return { recordings: recordingsCount, settings: settingsUpdated };
    } catch (error) {
      console.error('Failed to import data:', error);
      throw new Error('导入数据失败');
    }
  }

  async clearAllData(): Promise<void> {
    try {
      localStorage.removeItem(STORAGE_KEYS.RECORDINGS);
      localStorage.removeItem(STORAGE_KEYS.SETTINGS);
      localStorage.removeItem(STORAGE_KEYS.NOTIFICATION_RULES);
    } catch (error) {
      console.error('Failed to clear data:', error);
      throw new Error('清除数据失败');
    }
  }

  async getStorageUsage(): Promise<{ used: number; total: number }> {
    let used = 0;
    for (const key of Object.values(STORAGE_KEYS)) {
      const data = localStorage.getItem(key);
      if (data) {
        used += data.length * 2;
      }
    }

    return {
      used,
      total: 5 * 1024 * 1024,
    };
  }

  formatStorageSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export const storageService = new StorageService();
