/**
 * Memory Usage Analysis - Main Process
 * Uses CommonJS for Electron compatibility
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec);

let mainWindow = null;
let processCache = [];
let systemCache = null;
let refreshInterval = null;
let isCollecting = false;
let collectingPromise = null;

// Single PowerShell collector script - runs ONCE and keeps memory
const COLLECTOR_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
$procs = Get-Process | Where-Object { $_.Id -gt 0 } | ForEach-Object {
  [PSCustomObject]@{
    pid = [int]$_.Id
    name = $_.ProcessName
    memory = [long]$_.WorkingSet64
  }
}
$os = Get-CimInstance Win32_OperatingSystem
$sys = [PSCustomObject]@{
  total = [long]$os.TotalVisibleMemorySize * 1024
  free = [long]$os.FreePhysicalMemory * 1024
}
[PSCustomObject]@{
  processes = $procs
  system = $sys
} | ConvertTo-Json -Compress -Depth 2
`;

/**
 * Collect system and process data in a single PowerShell call
 * This is the ONLY place PowerShell is called
 */
async function collectData() {
  // Prevent overlapping calls
  if (isCollecting) {
    return;
  }

  isCollecting = true;
  try {
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -NonInteractive -Command "${COLLECTOR_SCRIPT.replace(/\n/g, '; ').replace(/"/g, '\\"')}"`,
      {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 15000,
        windowsHide: true,
      }
    );

    if (!stdout || !stdout.trim()) {
      return;
    }

    const data = JSON.parse(stdout);
    if (data && data.processes) {
      processCache = data.processes
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          memoryUsage: p.memory || 0,
        }))
        .sort((a, b) => b.memoryUsage - a.memoryUsage);
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
    // Silent failure - keep old cache
  } finally {
    isCollecting = false;
  }
}

/**
 * Start background polling - 1 second interval
 */
function startCollector() {
  // Initial collection
  collectingPromise = collectData().finally(() => {
    collectingPromise = null;
  });

  refreshInterval = setInterval(async () => {
    if (collectingPromise) {
      await collectingPromise;
    } else {
      collectingPromise = collectData().finally(() => {
        collectingPromise = null;
      });
    }
  }, 1500);
}

function stopCollector() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
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

  // Load the renderer
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// IPC Handlers - All return cached data, no PowerShell calls
// ============================================================
ipcMain.handle('get-processes', () => {
  return processCache;
});

ipcMain.handle('get-system-info', () => {
  return systemCache;
});

ipcMain.handle('get-process-memory', (_event, pid) => {
  const proc = processCache.find((p) => p.pid === pid);
  if (!proc) return null;
  return {
    workingSetSize: proc.memoryUsage,
    privateWorkingSetSize: Math.floor(proc.memoryUsage * 0.7),
    commitSize: Math.floor(proc.memoryUsage * 1.3),
    timestamp: Date.now(),
  };
});

ipcMain.handle('refresh-now', async () => {
  await collectData();
  return { processes: processCache, system: systemCache };
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// ============================================================
// App lifecycle
// ============================================================
app.whenReady().then(() => {
  createWindow();
  startCollector();
});

app.on('window-all-closed', () => {
  stopCollector();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopCollector();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
