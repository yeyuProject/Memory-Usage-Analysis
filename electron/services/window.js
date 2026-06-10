// Window lifecycle.
//
// Creates and tracks the single BrowserWindow instance. Exposes a getter
// so IPC handlers (e.g., recording CSV export, snapshot export) can use it
// as the parent for native dialogs.

const path = require('path');
const { BrowserWindow } = require('electron');

// Background color of the window before src/index.html finishes loading.
// MUST match the body background rule in src/styles.css (#f0f2f5) to
// avoid a flash of the wrong color on cold start.
const WINDOW_BG = '#f0f2f5';

let mainWindow = null;

/**
 * Create the main BrowserWindow and load src/index.html.
 * Stores the instance so get() can return it later for dialog parenting.
 * Called once from main.cjs when app is ready.
 * @returns {BrowserWindow} the newly created window
 */
function create() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Memory Usage Analysis',
    backgroundColor: WINDOW_BG,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

/**
 * Get the current main BrowserWindow, or null if it has been closed.
 * Used by IPC handlers that need a parent for native dialogs (save dialog,
 * showItemInFolder, etc).
 * @returns {BrowserWindow|null}
 */
function get() {
  return mainWindow;
}

module.exports = { create, get };