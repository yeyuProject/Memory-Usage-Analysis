/**
 * Memory Usage Analysis - Main Process
 * Pure CommonJS for maximum stability
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

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

app.whenReady().then(() => {
  createWindow();
  startCollector();
});

app.on('window-all-closed', () => { stopCollector(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopCollector);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
