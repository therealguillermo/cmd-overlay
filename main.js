const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const ptys = new Map();
let tabCounter = 0;
let mainWindow;

function getAvailableShells() {
  const shells = [
    { id: 'powershell', label: 'PowerShell', file: 'powershell.exe', args: [] },
    { id: 'cmd',        label: 'CMD',         file: 'cmd.exe',         args: [] },
    { id: 'wsl',        label: 'WSL',          file: 'wsl.exe',         args: [] },
  ];

  const gitBashPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of gitBashPaths) {
    try {
      require('fs').accessSync(p);
      shells.splice(1, 0, { id: 'git-bash', label: 'Git Bash', file: p, args: ['--login', '-i'] });
      break;
    } catch (_) {}
  }

  return shells;
}

function createWindow() {
  const { height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 480,
    height: 480,
    x: 0,
    y: height - 480,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  // Ctrl+` toggles show/focus/hide
  globalShortcut.register('Control+`', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.focus();
      }
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

// ── PTY handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('pty:shells', () => getAvailableShells());

ipcMain.handle('pty:create', (event, { shellId, cols, rows }) => {
  const shells = getAvailableShells();
  const shell = shells.find(s => s.id === shellId) || shells[0];
  const tabId = ++tabCounter;

  const ptyProcess = pty.spawn(shell.file, shell.args, {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: process.env,
  });

  ptyProcess.onData(data => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:output', { tabId, data });
    }
  });

  ptyProcess.onExit(() => {
    ptys.delete(tabId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { tabId });
    }
  });

  ptys.set(tabId, ptyProcess);
  return tabId;
});

ipcMain.on('pty:input', (event, { tabId, data }) => {
  const p = ptys.get(tabId);
  if (p) p.write(data);
});

ipcMain.on('pty:resize', (event, { tabId, cols, rows }) => {
  const p = ptys.get(tabId);
  if (p) p.resize(cols, rows);
});

ipcMain.on('pty:kill', (event, { tabId }) => {
  const p = ptys.get(tabId);
  if (p) { p.kill(); ptys.delete(tabId); }
});

// ── Window controls ───────────────────────────────────────────────────────────

ipcMain.on('window:minimize',   () => mainWindow.minimize());
ipcMain.on('window:hide',       () => mainWindow.hide());
ipcMain.on('window:close',      () => app.quit());
ipcMain.on('window:setOpacity', (event, v) => mainWindow.setOpacity(Math.max(0.1, Math.min(1, v))));

// Keep app alive when all windows are closed (hide instead of quit)
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ptys.forEach(p => { try { p.kill(); } catch (_) {} });
});

// ── Auto-start helper ─────────────────────────────────────────────────────────

ipcMain.handle('autostart:get', () =>
  app.getLoginItemSettings().openAtLogin
);

ipcMain.handle('autostart:set', (event, enable) => {
  app.setLoginItemSettings({ openAtLogin: enable });
  return enable;
});
