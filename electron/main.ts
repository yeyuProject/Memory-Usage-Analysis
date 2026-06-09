import { app, BrowserWindow, ipcMain } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';

const execAsync = promisify(exec);
const __dirname = import.meta.dirname;

let mainWindow: BrowserWindow | null = null;

async function getWindowsProcesses(): Promise<{ pid: number; name: string; memoryUsage: number }[]> {
  try {
    const { stdout } = await execAsync(
      'powershell -Command "Get-Process | Select-Object Id, ProcessName, WorkingSet64 | ConvertTo-Json"',
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );

    let data = JSON.parse(stdout);
    if (!Array.isArray(data)) data = [data];

    return data
      .filter((p: any) => p.Id > 0)
      .map((p: any) => ({
        pid: p.Id,
        name: p.ProcessName,
        memoryUsage: p.WorkingSet64 || 0,
      }))
      .sort((a: any, b: any) => b.memoryUsage - a.memoryUsage);
  } catch (error) {
    console.error('Failed to get processes:', error);
    return [];
  }
}

async function getProcessMemoryInfo(processId: number) {
  try {
    const { stdout } = await execAsync(
      `powershell -Command "Get-Process -Id ${processId} | Select-Object WorkingSet64, PrivateMemorySize64, PageFileUsage64 | ConvertTo-Json"`,
      { encoding: 'utf-8' }
    );

    const data = JSON.parse(stdout);
    return {
      workingSetSize: data.WorkingSet64 || 0,
      privateWorkingSetSize: data.PrivateMemorySize64 || 0,
      commitSize: (data.PageFileUsage64 || 0) * 1024,
    };
  } catch (error) {
    console.error('Failed to get process memory:', error);
    return null;
  }
}

async function getSystemMemoryInfo() {
  try {
    const { stdout } = await execAsync(
      'powershell -Command "$os = Get-CimInstance Win32_OperatingSystem; @{Total=[long]$os.TotalVisibleMemorySize*1024; Free=[long]$os.FreePhysicalMemory*1024} | ConvertTo-Json"',
      { encoding: 'utf-8' }
    );

    const data = JSON.parse(stdout);
    const total = data.Total;
    const free = data.Free;
    return {
      totalPhysicalMemory: total,
      availablePhysicalMemory: free,
      memoryLoad: Math.round(((total - free) / total) * 100),
    };
  } catch (error) {
    console.error('Failed to get system memory:', error);
    return null;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Memory Usage Analysis',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
    autoHideMenuBar: true,
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('get-processes', async () => {
    return await getWindowsProcesses();
  });

  ipcMain.handle('get-process-memory', async (_, pid: number) => {
    return await getProcessMemoryInfo(pid);
  });

  ipcMain.handle('get-system-memory', async () => {
    return await getSystemMemoryInfo();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
