/**
 * Memory Usage Analysis - Main Process
 * Pure CommonJS for maximum stability
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

// Memory estimation ratios (must match renderer constants)
const MEM_RATIOS = {
  PRIVATE_RATIO: 0.7,
  COMMIT_RATIO: 1.3,
};

let mainWindow = null;
let processCache = [];
let systemCache = null;
let refreshInterval = null;
let isCollecting = false;
let processHistory = new Map();   // pid -> { baseline, peak, peakTime, samples[] }
const MAX_SAMPLES = 60;            // 2s interval × 60 = 2 minutes of history

// ============== Persistent recording state ==============
// Recordings are stored as JSONL (one JSON sample per line) in userData/recordings/.
// System-wide recording captures top-N processes + system totals at each tick.
// File format:
//   {"header":{...metadata...}}
//   {"t":1700000000000,"sys":{...},"top":[{"pid":1234,"name":"x","mem":12345678}, ...]}
let recordingState = null;        // { id, startTime, interval, filePath, stream, sampleCount }
const RECORDINGS_DIR = path.join(app.getPath('userData'), 'recordings');
const TOP_N_DEFAULT = 20;

function ensureRecordingsDir() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
}

// ============== User config persistence ==============
// Thresholds and recording defaults persist to userData/config.json.
// Schema is flat (one level deep) for readability and safe partial updates.
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  spikeThreshold: 50,        // % deviation from baseline that triggers spike card
  leakThreshold: 30,         // % slope-per-window that flags a leak
  recordingTopN: 20,         // default Top-N for new recordings
  recordingInterval: 2000,   // default sample interval in ms
  notificationCooldown: 60,  // seconds between repeated notifications for same process
};

// Validate a config patch: only accept known keys, clamp to safe ranges.
// Defensive against malformed renderer input.
function sanitizeConfig(patch) {
  const out = {};
  if (typeof patch.spikeThreshold === 'number' && Number.isFinite(patch.spikeThreshold)) {
    out.spikeThreshold = Math.min(500, Math.max(5, Math.round(patch.spikeThreshold)));
  }
  if (typeof patch.leakThreshold === 'number' && Number.isFinite(patch.leakThreshold)) {
    out.leakThreshold = Math.min(500, Math.max(1, Math.round(patch.leakThreshold)));
  }
  if (typeof patch.recordingTopN === 'number' && Number.isFinite(patch.recordingTopN)) {
    out.recordingTopN = Math.min(50, Math.max(5, Math.round(patch.recordingTopN)));
  }
  if (typeof patch.recordingInterval === 'number' && Number.isFinite(patch.recordingInterval)) {
    out.recordingInterval = Math.min(60000, Math.max(1000, Math.round(patch.recordingInterval)));
  }
  if (typeof patch.notificationCooldown === 'number' && Number.isFinite(patch.notificationCooldown)) {
    out.notificationCooldown = Math.min(3600, Math.max(0, Math.round(patch.notificationCooldown)));
  }
  return out;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge: defaults first, then saved values (only known keys survive via sanitizeConfig)
    const merged = { ...DEFAULT_CONFIG, ...sanitizeConfig(parsed) };
    return merged;
  } catch (e) {
    // Corrupt config: fall back to defaults, do not crash app
    console.error('[loadConfig] error:', e.message);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  const clean = sanitizeConfig(patch);
  if (Object.keys(clean).length === 0) {
    return { ok: false, error: '没有可保存的有效字段' };
  }
  const current = loadConfig();
  const next = { ...current, ...clean };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return { ok: true, config: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Append one sample to the active recording. Called from the periodic collector.
// Cheap: writes a single line (~1KB) every interval. fs.createWriteStream buffers.
function appendRecordingSample(timestamp, processes, systemInfo) {
  if (!recordingState || !recordingState.stream) return;
  try {
    const top = [...processes]
      .sort((a, b) => b.memoryUsage - a.memoryUsage)
      .slice(0, recordingState.topN)
      .map(p => ({ pid: p.pid, name: p.name, mem: p.memoryUsage }));
    const sample = {
      t: timestamp,
      sys: {
        totalMem: systemInfo.totalMemory,
        usedMem: systemInfo.usedMemory,
        freeMem: systemInfo.freeMemory,
      },
      top,
    };
    recordingState.stream.write(JSON.stringify(sample) + '\n');
    recordingState.sampleCount++;
  } catch (e) {
    console.error('recording write failed:', e.message);
  }
}

function startRecording({ interval = 2000, topN = TOP_N_DEFAULT } = {}) {
  if (recordingState) {
    return { ok: false, error: '已有录制在进行中' };
  }
  ensureRecordingsDir();
  const id = 'rec_' + Date.now();
  const filePath = path.join(RECORDINGS_DIR, id + '.jsonl');
  try {
    const stream = fs.createWriteStream(filePath, { flags: 'w' });
    // Write header line for self-describing file
    stream.write(JSON.stringify({
      header: {
        id,
        startTime: Date.now(),
        interval,
        topN,
        version: app.getVersion(),
      },
    }) + '\n');
    recordingState = { id, startTime: Date.now(), interval, topN, filePath, stream, sampleCount: 0 };
    return { ok: true, id, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function stopRecording() {
  if (!recordingState) return { ok: false, error: '当前未在录制' };
  const { id, filePath, sampleCount } = recordingState;
  return new Promise(resolve => {
    recordingState.stream.end(() => {
      recordingState = null;
      resolve({ ok: true, id, filePath, sampleCount });
    });
  });
}

// List all recordings on disk, sorted newest first. Reads only the header line.
function listRecordings() {
  ensureRecordingsDir();
  const files = fs.readdirSync(RECORDINGS_DIR).filter(f => f.endsWith('.jsonl'));
  const items = [];
  for (const f of files) {
    const filePath = path.join(RECORDINGS_DIR, f);
    try {
      const stat = fs.statSync(filePath);
      const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
      const header = JSON.parse(firstLine).header || {};
      // Read last line to get end time and final sample count
      const all = fs.readFileSync(filePath, 'utf8').trim().split('\n');
      let endTime = header.startTime;
      let sampleCount = 0;
      for (let i = 1; i < all.length; i++) {
        try {
          const s = JSON.parse(all[i]);
          endTime = s.t || endTime;
          sampleCount++;
        } catch {}
      }
      items.push({
        id: header.id || f.replace('.jsonl', ''),
        filePath,
        startTime: header.startTime || stat.birthtimeMs,
        endTime,
        interval: header.interval || 0,
        topN: header.topN || TOP_N_DEFAULT,
        sampleCount,
        sizeBytes: stat.size,
      });
    } catch (e) {
      items.push({ id: f, filePath, error: e.message, sizeBytes: 0 });
    }
  }
  items.sort((a, b) => b.startTime - a.startTime);
  return items;
}

function deleteRecording(id) {
  const filePath = path.join(RECORDINGS_DIR, id + '.jsonl');
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { ok: true };
    }
    return { ok: false, error: '文件不存在' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Convert a JSONL recording to a flat CSV. Streams row-by-row to avoid OOM on big files.
async function exportRecordingCsv(id) {
  const filePath = path.join(RECORDINGS_DIR, id + '.jsonl');
  if (!fs.existsSync(filePath)) return { ok: false, error: '录制不存在' };
  const { filePath: outPath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出为 CSV',
    defaultPath: id + '.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!outPath) return { ok: false, error: '用户取消' };
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const header = JSON.parse(lines[0]).header || {};
    const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
    // CSV header: timestamp, system_used, system_total, then one column per top-N rank
    // Since ranks differ per sample, we use a wide format: rank_pid_N, rank_name_N, rank_mem_N
    const N = header.topN || TOP_N_DEFAULT;
    const cols = ['timestamp', 'system_used', 'system_total', 'system_free'];
    for (let i = 0; i < N; i++) {
      cols.push(`r${i}_pid`, `r${i}_name`, `r${i}_mem`);
    }
    out.write(cols.join(',') + '\n');
    const csvEscape = v => {
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const s = JSON.parse(line);
      const row = [
        new Date(s.t).toISOString(),
        s.sys.usedMem || 0,
        s.sys.totalMem || 0,
        s.sys.freeMem || 0,
      ];
      for (let j = 0; j < N; j++) {
        const p = s.top[j];
        row.push(p ? p.pid : '', p ? p.name : '', p ? p.mem : 0);
      }
      out.write(row.map(csvEscape).join(',') + '\n');
    }
    await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
    return { ok: true, filePath: outPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const COLLECTOR_SCRIPT = `
$procs = Get-Process | Where-Object { $_.Id -gt 0 } | ForEach-Object {
  [PSCustomObject]@{ pid = [int]$_.Id; name = $_.ProcessName; memory = [long]$_.WorkingSet64 }
}
$os = Get-CimInstance Win32_OperatingSystem
[PSCustomObject]@{
  processes = $procs
  system = @{ total = [long]$os.TotalVisibleMemorySize * 1024; free = [long]$os.FreePhysicalMemory * 1024 }
} | ConvertTo-Json -Compress -Depth 3
`;

async function collectData() {
  if (isCollecting) return;
  isCollecting = true;
  try {
    const scriptPath = path.join(app.getPath('temp'), 'mua-collect.ps1');
    require('fs').writeFileSync(scriptPath, COLLECTOR_SCRIPT, 'utf8');
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, timeout: 15000, windowsHide: true }
    );
    if (!stdout || !stdout.trim()) return;
    const data = JSON.parse(stdout);
    if (data && data.processes) {
      processCache = data.processes
        .map(p => ({ pid: p.pid, name: p.name, memoryUsage: p.memory || 0 }))
        .sort((a, b) => b.memoryUsage - a.memoryUsage);

      // Update per-process history for spike detection.
      // History only tracks the most recent MAX_SAMPLES samples (~2 min @ 2s interval).
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
        // Baseline: min of first 5 samples (initialization phase)
        if (h.samples.length <= 5) h.baseline = Math.min(...h.samples);
        // Peak tracking
        if (p.memoryUsage > h.peak) { h.peak = p.memoryUsage; h.peakTime = now; }
      });
      // Evict history for processes that have exited to bound memory
      for (const pid of processHistory.keys()) {
        if (!currentPids.has(pid)) processHistory.delete(pid);
      }
    }
    if (data && data.system) {
      systemCache = {
        totalPhysicalMemory: data.system.total,
        availablePhysicalMemory: data.system.free,
        memoryLoad: Math.round(((data.system.total - data.system.free) / data.system.total) * 100),
        timestamp: Date.now(),
      };
    }

    // Append to active recording (if any). Cheap: one JSONL line.
    if (recordingState && processCache.length > 0 && systemCache) {
      appendRecordingSample(
        Date.now(),
        processCache,
        {
          totalMemory: systemCache.totalPhysicalMemory,
          usedMemory: systemCache.totalPhysicalMemory - systemCache.availablePhysicalMemory,
          freeMemory: systemCache.availablePhysicalMemory,
        }
      );
    }
  } catch (err) {
    console.error('[collectData] error:', err.message);
  } finally {
    isCollecting = false;
  }
}

function startCollector() {
  collectData();
  // 2s collection interval matches renderer's 2s refresh
  refreshInterval = setInterval(collectData, 2000);
}

function stopCollector() {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Memory Usage Analysis',
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('get-processes', () => processCache);
ipcMain.handle('get-system-info', () => systemCache);

// Returns spike + leak analysis for each cached process:
// { baseline, peak, peakTime, spikePercent, leakPercent, trend, sampleCount }
// spikePercent = ((current - baseline) / baseline) * 100, or 0 if baseline is 0
// leakPercent = normalized linear-regression slope (per sample).
//   +50% means memory is rising 50% of baseline per sample window (~2 min).
//   Stable processes oscillate around 0%; a consistently positive slope = leak.
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

// Leak detection: simple least-squares slope normalized by mean.
// Returns a percentage where 0 = stable, positive = trending up, negative = trending down.
// Requires at least 5 samples to be meaningful; returns 0 if fewer.
function computeLeakPercent(samples) {
  if (!samples || samples.length < 5) return 0;
  const n = samples.length;
  // Index = 0,1,2,...,n-1. Treat time as evenly spaced.
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += samples[i];
    sumXY += i * samples[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom; // bytes per sample
  const mean = sumY / n;
  if (mean === 0) return 0;
  // Slope per sample as a percentage of mean. Multiply by 60 to approximate
  // "percent growth per full window" rather than per single sample step.
  return Math.round((slope / mean) * 60 * 100);
}
ipcMain.handle('get-process-memory', (_e, pid) => {
  // Defensive: reject invalid pids before they cause a crash
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  const p = processCache.find(x => x.pid === pid);
  if (!p) return null;
  return {
    workingSetSize: p.memoryUsage,
    privateWorkingSetSize: Math.floor(p.memoryUsage * MEM_RATIOS.PRIVATE_RATIO),
    commitSize: Math.floor(p.memoryUsage * MEM_RATIOS.COMMIT_RATIO),
    timestamp: Date.now(),
  };
});
ipcMain.handle('refresh-now', async () => {
  await collectData();
  return { processes: processCache, system: systemCache };
});
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('kill-process', async (_e, pid) => {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return { success: false, error: '无效的PID' };
  }
  try {
    await execAsync(`taskkill /PID ${pid} /F`, { windowsHide: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-file-location', async (_e, processName) => {
  if (typeof processName !== 'string' || !processName.trim()) {
    return { success: false, error: '无效的进程名' };
  }
  try {
    // Find the executable path via WMI
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -Command "(Get-Process -Name '${processName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 1).Path"`,
      { encoding: 'utf-8', windowsHide: true, timeout: 5000 }
    );
    const exePath = stdout.trim();
    if (!exePath) {
      return { success: false, error: '找不到进程路径' };
    }
    const { shell } = require('electron');
    shell.showItemInFolder(exePath);
    return { success: true, path: exePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-clipboard', (_e, text) => {
  const { clipboard } = require('electron');
  if (typeof text === 'string') {
    clipboard.writeText(text);
    return { success: true };
  }
  return { success: false, error: '无效的内容' };
});

// ============== Persistent recording IPC ==============
// Recording is owned by the main process so it survives renderer reloads and
// can capture data even while the user is on another tab.
ipcMain.handle('start-recording', (_e, opts) => {
  return startRecording(opts || {});
});
ipcMain.handle('stop-recording', async () => {
  return await stopRecording();
});
ipcMain.handle('get-recording-status', () => {
  if (!recordingState) return { active: false };
  return {
    active: true,
    id: recordingState.id,
    startTime: recordingState.startTime,
    interval: recordingState.interval,
    topN: recordingState.topN,
    sampleCount: recordingState.sampleCount,
    filePath: recordingState.filePath,
  };
});
ipcMain.handle('list-recordings', () => listRecordings());
ipcMain.handle('delete-recording', (_e, id) => deleteRecording(id));
ipcMain.handle('export-recording-csv', async (_e, id) => {
  return await exportRecordingCsv(id);
});

// ============== Config IPC ==============
// Renderer reads config on startup (so thresholds apply immediately) and writes
// when user changes a setting. saveConfig merges with existing values, so partial
// updates are safe.
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('set-config', (_e, patch) => saveConfig(patch));
ipcMain.handle('reset-config', () => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    return { ok: true, config: { ...DEFAULT_CONFIG } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Ensure an in-flight recording is flushed before app exit.
app.on('before-quit', () => {
  if (recordingState && recordingState.stream) {
    try { recordingState.stream.end(); } catch {}
  }
});

app.whenReady().then(() => {
  createWindow();
  startCollector();
});

app.on('window-all-closed', () => { stopCollector(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopCollector);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
