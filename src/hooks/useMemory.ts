import { useState, useEffect, useCallback, useRef } from 'react';
import { memoryService } from '../services/memory';
import {
  ProcessMemoryInfo,
  SystemMemoryInfo,
  RecordingConfig,
  RecordingSession,
} from '../types/memory';

export function useProcessList() {
  const [processes, setProcesses] = useState<{ pid: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProcesses = useCallback(async () => {
    try {
      setLoading(true);
      const data = await memoryService.getProcessList();
      setProcesses(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch processes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProcesses();
  }, [fetchProcesses]);

  return { processes, loading, error, refresh: fetchProcesses };
}

export function useProcessMemory(processId: number | null, interval: number = 1000) {
  const [memoryInfo, setMemoryInfo] = useState<ProcessMemoryInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMemoryInfo = useCallback(async () => {
    if (!processId) return;

    try {
      setLoading(true);
      const data = await memoryService.getProcessMemoryInfo(processId);
      setMemoryInfo(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch memory info');
    } finally {
      setLoading(false);
    }
  }, [processId]);

  useEffect(() => {
    if (!processId) {
      setMemoryInfo(null);
      return;
    }

    fetchMemoryInfo();

    timerRef.current = setInterval(fetchMemoryInfo, interval);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [processId, interval, fetchMemoryInfo]);

  return { memoryInfo, loading, error, refresh: fetchMemoryInfo };
}

export function useSystemMemory(interval: number = 2000) {
  const [systemInfo, setSystemInfo] = useState<SystemMemoryInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSystemInfo = useCallback(async () => {
    try {
      setLoading(true);
      const data = await memoryService.getSystemMemoryInfo();
      setSystemInfo(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch system info');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSystemInfo();

    timerRef.current = setInterval(fetchSystemInfo, interval);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [interval, fetchSystemInfo]);

  return { systemInfo, loading, error, refresh: fetchSystemInfo };
}

export function useRecording() {
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [currentSession, setCurrentSession] = useState<RecordingSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await memoryService.getAllRecordingSessions();
      setSessions(data);
    } catch (err) {
      console.error('Failed to fetch recording sessions:', err);
    }
  }, []);

  const fetchCurrentSession = useCallback(async (sessionId: string) => {
    try {
      const session = await memoryService.getRecordingSession(sessionId);
      setCurrentSession(session || null);
    } catch (err) {
      console.error('Failed to fetch current session:', err);
    }
  }, []);

  const startRecording = useCallback(
    async (config: RecordingConfig) => {
      try {
        setLoading(true);
        setError(null);
        const sessionId = await memoryService.startRecording(config);

        timerRef.current = setInterval(() => {
          fetchCurrentSession(sessionId);
          fetchSessions();
        }, 1000);

        await fetchCurrentSession(sessionId);
        return sessionId;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start recording');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [fetchCurrentSession, fetchSessions]
  );

  const stopRecording = useCallback(
    async (sessionId: string) => {
      try {
        await memoryService.stopRecording(sessionId);

        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }

        await fetchCurrentSession(sessionId);
        await fetchSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to stop recording');
      }
    },
    [fetchCurrentSession, fetchSessions]
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await memoryService.deleteRecordingSession(sessionId);
        await fetchSessions();
        if (currentSession?.id === sessionId) {
          setCurrentSession(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete session');
      }
    },
    [fetchSessions, currentSession]
  );

  useEffect(() => {
    fetchSessions();

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [fetchSessions]);

  return {
    sessions,
    currentSession,
    loading,
    error,
    startRecording,
    stopRecording,
    deleteSession,
    refresh: fetchSessions,
  };
}

export function useMemoryHistory(
  processId: number | null,
  startTime: number | null,
  endTime: number | null
) {
  const [history, setHistory] = useState<ProcessMemoryInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!processId || !startTime || !endTime) return;

    try {
      setLoading(true);
      const data = await memoryService.getMemoryHistory(processId, startTime, endTime);
      setHistory(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch history');
    } finally {
      setLoading(false);
    }
  }, [processId, startTime, endTime]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { history, loading, error, refresh: fetchHistory };
}
