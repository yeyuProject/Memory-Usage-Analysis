import { app, BrowserWindow, ipcMain } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { is } from '@electron-toolkit/utils';

const execAsync = promisify(exec);

let mainWindow: BrowserWindow | null = null;

async function getWindowsProcesses(): Promise<{ pid: number; name: string; memoryUsage: number }[]> {
  try {
    const { stdout } = await execAsync(
      'wmic process get ProcessId,Name,WorkingSetSize /format:csv',
      { encoding: 'utf-8', maxBuffer: 1024 * 1024 }
    );

    const lines = stdout.trim().split('\n').filter(line => line.trim());
    const processes: { pid: number; name: string; memoryUsage: number }[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 4) {
        const pid = parseInt(parts[1]);
        const name = parts[2];
        const memory = parseInt(parts[3]) || 0;

        if (!isNaN(pid) && name) {
          processes.push({ pid, name: name.trim(), memoryUsage: memory });
        }
      }
    }

    return processes.sort((a, b) => b.memoryUsage - a.memoryUsage);
  } catch (error) {
    console.error('Failed to get processes:', error);
    return [];
  }
}

async function getProcessMemoryInfo(processId: number) {
  try {
    const { stdout } = await execAsync(
      `wmic process where ProcessId=${processId} get WorkingSetSize,PrivatePageCount,PageFileUsage /format:csv`,
      { encoding: 'utf-8' }
    );

    const lines = stdout.trim().split('\n').filter(line => line.trim());
    if (lines.length >= 2) {
      const parts = lines[1].split(',');
      if (parts.length >= 4) {
        return {
          workingSetSize: parseInt(parts[3]) || 0,
          privateWorkingSetSize: parseInt(parts[2]) || 0,
          commitSize: parseInt(parts[1]) || 0,
        };
      }
    }
    return null;
  } catch (error) {
    console.error('Failed to get process memory:', error);
    return null;
  }
}

async function getSystemMemoryInfo() {
  try {
    const { stdout } = await execAsync(
      'wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /format:csv',
      { encoding: 'utf-8' }
    );

    const lines = stdout.trim().split('\n').filter(line => line.trim());
    if (lines.length >= 2) {
      const parts = lines[1].split(',');
      if (parts.length >= 3) {
        const total = parseInt(parts[2]) * 1024;
        const free = parseInt(parts[1]) * 1024;
        return {
          totalPhysicalMemory: total,
          availablePhysicalMemory: free,
          memoryLoad: Math.round(((total - free) / total) * 100),
        };
      }
    }
    return null;
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
