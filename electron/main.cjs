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
