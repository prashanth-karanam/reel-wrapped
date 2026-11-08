const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow = null;
let serverProc = null;

function startLocalServer() {
  return new Promise((resolve) => {
    serverProc = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'server.ts')], {
      env: { ...process.env, PORT: '3000', ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    });
    setTimeout(resolve, 1400);
  });
}

async function createWindow() {
  await startLocalServer();

  mainWindow = new BrowserWindow({
    width: 460,
    height: 880,
    minWidth: 380,
    minHeight: 680,
    title: "Reel Wrapped '25 • 100% Local Vault",
    backgroundColor: '#0F172A',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://localhost:3000').catch(() => {
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://github.com/')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (serverProc) {
    try {
      serverProc.kill();
    } catch (_) {}
  }
  if (process.platform !== 'darwin') app.quit();
});
