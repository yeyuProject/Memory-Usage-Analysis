/**
 * Memory Usage Analysis - Main Process
 *
 * Thin orchestrator: bootstraps services, registers IPC handlers, manages
 * app lifecycle. All real logic lives in electron/services/.
 */

const { app, ipcMain, clipboard } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

// Services
const configService = require('./services/config');
const recordingService = require('./services/recording');
const psSession = require('./services/ps-session');
const windowService = require('./services/window');
const { csvEscape } = require('./services/csv');

// ===== Module-level state owned by the orchestrator =====
// These are the "live caches" that IPC handlers return. They are populated
// by collectData() each tick and read by renderer.
let processCache = [];
let systemCache = null;
let processHistory = new Map();   // pid -> { baseline, peak, peakTime, samples[] }
let refreshInterval = null;
let isCollecting = false;

const MAX_SAMPLES = 60;            // history window length (samples)
const COLLECT_INTERVAL_MS = 2000;  // collector tick interval; matches renderer REFRESH_INTERVAL_MS
const HISTORY_WINDOW_MS = MAX_SAMPLES * COLLECT_INTERVAL_MS;
const USER_CANCELED = '用户取消';

// ===== Memory estimation ratios (must match renderer constants) =====
const MEM_RATIOS = {
  PRIVATE_RATIO: 0.7,
  COMMIT_RATIO: 1.3,
};

/**
 * Compute a process's leak percentage via least-squares linear regression.
 * The slope (bytes/sample) is normalized by the mean to get a unitless
 * fraction, then multiplied by 60 to approximate "percent growth per
 * full window" rather than per single sample step. Identical to the
 * renderer-side algorithm in src/modules/process-table.js (kept here so
 * the history snapshot IPC handler can run without depending on the
 * renderer's modules).
 *
 * @param {number[]} samples - memory samples in chronological order
 * @returns {number} percentage (positive = growing, 0 = flat/unknown)
 */
function computeLeakPercent(samples) {
  if (!samples || samples.length < 5) return 0;
  const n = samples.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += samples[i];
    sumXY += i * samples[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const mean = sumY / n;
  if (mean === 0) return 0;
  return Math.round((slope / mean) * 60 * 100);
}

/**
 * Periodic collector tick. Fetches one data sample from the PowerShell
 * REPL, updates the in-memory caches (processCache, systemCache,
 * processHistory), and appends a sample to the active recording if any.
 *
 * Reentrancy-guarded by isCollecting — a slow tick won't trigger a
 * second concurrent call.
 *
 * @returns {Promise<void>}
 */
async function collectData() {
  if (isCollecting) return;
  isCollecting = true;
  try {
    const data = await psSession.collect();
    if (!data) return;

    if (data.processes) {
      processCache = data.processes
        .map(p => ({ pid: p.pid, name: p.name, memoryUsage: p.memory || 0 }))
        .sort((a, b) => b.memoryUsage - a.memoryUsage);

      // Update per-process history for spike detection.
      const now = Date.now();
      const currentPids = new Set(processCache.map(p => p.pid));
      processCache.forEach(p => {
        let h = processHistory.get(p.pid);
        if (!h) {
          h = { baseline: p.memoryUsage, peak: p.memoryUsage, peakTime: now, samples: [] };
          processHistory.set(p.pid, h);
        }
        h.samples.push(p.memoryUsage);
        if (h.samples.length > MAX_SAMPLES) h.samples.shift();
        if (h.samples.length <= 5) h.baseline = Math.min(...h.samples);
        if (p.memoryUsage > h.peak) { h.peak = p.memoryUsage; h.peakTime = now; }
      });
      for (const pid of processHistory.keys()) {
        if (!currentPids.has(pid)) processHistory.delete(pid);
      }
    }
    if (data.system) {
      systemCache = {
        totalPhysicalMemory: data.system.total,
        availablePhysicalMemory: data.system.free,
        memoryLoad: Math.round(((data.system.total - data.system.free) / data.system.total) * 100),
        timestamp: Date.now(),
      };
    }

    // Append to active recording (if any).
    if (recordingService.getStatus().active && processCache.length > 0 && systemCache) {
      recordingService.appendSample(Date.now(), processCache, {
        totalMemory: systemCache.totalPhysicalMemory,
        usedMemory: systemCache.totalPhysicalMemory - systemCache.availablePhysicalMemory,
        freeMemory: systemCache.availablePhysicalMemory,
      });
    }
  } catch (err) {
    console.error('[collectData] error:', err.message);
    // Mark session dead so next tick restarts it.
    psSession.stop();
  } finally {
    isCollecting = false;
  }
}

/**
 * Start the periodic collector. Fires one immediate collect() then
 * schedules collectData() every COLLECT_INTERVAL_MS. Idempotent.
 */
function startCollector() {
  collectData();
  refreshInterval = setInterval(collectData, COLLECT_INTERVAL_MS);
}

/**
 * Stop the periodic collector. Idempotent — safe to call multiple times.
 */
function stopCollector() {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}

// ===== IPC handlers =====

// Read-only cache access
ipcMain.handle('get-processes', () => processCache);
ipcMain.handle('get-system-info', () => systemCache);

// Per-process history with spike + leak analysis
ipcMain.handle('get-process-history', () => {
  const result = {};
  for (const [pid, h] of processHistory) {
    const p = processCache.find(x => x.pid === pid);
    const current = p ? p.memoryUsage : 0;
    const spikePct = h.baseline > 0
      ? Math.round(((current - h.baseline) / h.baseline) * 100)
      : 0;
    result[pid] = {
      baseline: h.baseline,
      peak: h.peak,
      peakTime: h.peakTime,
      current,
      spikePercent: spikePct,
      leakPercent: computeLeakPercent(h.samples),
      sampleCount: h.samples.length,
    };
  }
  return result;
});

// Per-PID detailed lookup (used by chart page)
ipcMain.handle('get-process-memory', (_e, pid) => {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return null;
  const p = processCache.find(x => x.pid === pid);
  if (!p) return null;
  const h = processHistory.get(pid) || {};
  return {
    pid: p.pid,
    name: p.name,
    memoryUsage: p.memoryUsage,
    privateWorkingSetSize: Math.floor(p.memoryUsage * MEM_RATIOS.PRIVATE_RATIO),
    commitSize: Math.floor(p.memoryUsage * MEM_RATIOS.COMMIT_RATIO),
  };
});

// Manual refresh trigger
ipcMain.handle('refresh-now', async () => {
  if (!isCollecting) await collectData();
  return { ok: true };
});

ipcMain.handle('get-app-version', () => app.getVersion());

// Process control
ipcMain.handle('kill-process', async (_e, pid) => {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return { ok: false, error: '无效的 PID' };
  }
  try {
    await execAsync(`taskkill /PID ${pid} /F`, { windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-file-location', async (_e, processName) => {
  if (typeof processName !== 'string' || !processName) {
    return { ok: false, error: '无效的进程名' };
  }
  try {
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -Command "(Get-Process -Name '${processName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 1).Path"`,
      { encoding: 'utf-8', windowsHide: true, timeout: 5000 }
    );
    const exePath = stdout.trim();
    if (!exePath) return { ok: false, error: '找不到进程可执行文件' };
    const { shell } = require('electron');
    shell.showItemInFolder(exePath);
    return { ok: true, path: exePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Clipboard
ipcMain.handle('write-clipboard', (_e, text) => {
  if (typeof text === 'string') {
    clipboard.writeText(text);
    return { success: true };
  }
  return { success: false, error: '无效的内容' };
});

// Recording (delegates to service)
ipcMain.handle('start-recording', (_e, opts) => recordingService.startRecording(opts || {}));
ipcMain.handle('stop-recording', async () => await recordingService.stopRecording());
ipcMain.handle('get-recording-status', () => recordingService.getStatus());
ipcMain.handle('list-recordings', () => recordingService.listRecordings());
ipcMain.handle('delete-recording', (_e, id) => recordingService.deleteRecording(id));
ipcMain.handle('export-recording-csv', async (_e, id) => {
  return await recordingService.exportCsv(id, windowService.get());
});

// Config (delegates to service)
ipcMain.handle('get-config', () => configService.loadConfig());
ipcMain.handle('set-config', (_e, patch) => configService.saveConfig(patch));
ipcMain.handle('reset-config', () => configService.resetConfig());

// History snapshot export — captures full current state for offline analysis.
ipcMain.handle('export-history-snapshot', async (_e, opts) => {
  const format = (opts && opts.format) || 'csv';
  const includeAll = !opts || opts.includeAll !== false;
  const cfg = configService.loadConfig();
  const thresholds = { ...configService.DEFAULT_CONFIG, ...cfg };
  const { dialog } = require('electron');
  const defaultName = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const filters = format === 'json'
    ? [{ name: 'JSON', extensions: ['json'] }]
    : [{ name: 'CSV', extensions: ['csv'] }];
  const { filePath, canceled } = await dialog.showSaveDialog(windowService.get(), {
    title: '导出历史快照',
    defaultPath: defaultName + '.' + format,
    filters,
  });
  if (canceled || !filePath) return { ok: false, error: USER_CANCELED };

  const rows = [];
  for (const p of processCache) {
    if (!includeAll && p.memoryUsage < 1024 * 1024) continue;
    const h = processHistory.get(p.pid) || {};
    const baseline = h.baseline || p.memoryUsage;
    const peak = h.peak || p.memoryUsage;
    const spikePercent = baseline > 0
      ? Math.round(((p.memoryUsage - baseline) / baseline) * 100)
      : 0;
    rows.push({
      pid: p.pid,
      name: p.name,
      memoryUsage: p.memoryUsage,
      baseline,
      peak,
      spikePercent,
      leakPercent: computeLeakPercent(h.samples || []),
      sampleCount: (h.samples || []).length,
    });
  }
  rows.sort((a, b) => b.memoryUsage - a.memoryUsage);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    system: systemCache,
    thresholds,
    processCount: rows.length,
    processes: rows,
  };

  try {
    if (format === 'json') {
      fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    } else {
      const cols = ['pid', 'name', 'memoryUsage', 'baseline', 'peak', 'spikePercent', 'leakPercent', 'sampleCount'];
      const lines = [cols.join(',')];
      rows.forEach(r => {
        lines.push(cols.map(c => csvEscape(r[c])).join(','));
      });
      const meta = [
        `# Generated: ${snapshot.generatedAt}`,
        `# App version: ${snapshot.appVersion}`,
        `# Process count: ${snapshot.processCount}`,
        `# Thresholds: spike=${thresholds.spikeThreshold}% leak=${thresholds.leakThreshold}%`,
        `# System: totalMem=${snapshot.system ? snapshot.system.totalPhysicalMemory : 'n/a'}`,
      ].join('\n');
      fs.writeFileSync(filePath, meta + '\n' + lines.join('\n') + '\n', 'utf8');
    }
    return { ok: true, filePath, processCount: rows.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// PS session diagnostics
ipcMain.handle('get-collector-stats', () => psSession.getStats());

// ===== App lifecycle =====
app.whenReady().then(() => {
  windowService.create();
  startCollector();
});

// Ensure in-flight recording + PS session are flushed before exit.
let _flushed = false;
app.on('before-quit', () => {
  if (_flushed) return;
  _flushed = true;
  stopCollector();
  // Note: recording.stopRecording() returns a Promise but before-quit handlers
  // don't await. The write stream end() will flush in the background; the OS
  // will close the process once the event loop drains.
  if (recordingService.getStatus().active) {
    recordingService.stopRecording().catch(() => {});
  }
  psSession.stop();
});

app.on('window-all-closed', () => { stopCollector(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (require('electron').BrowserWindow.getAllWindows().length === 0) windowService.create(); });