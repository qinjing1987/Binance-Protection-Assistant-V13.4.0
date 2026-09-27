// Electron 主进程：只负责窗口生命周期、安全凭据存储，以及启动本地后端。
// 注意：真正的交易逻辑全部放在 server/，前端不直接接触 API Secret。
const { app, BrowserWindow, safeStorage, shell } = require('electron');
const path = require('path');
const { createApplicationServer } = require('../server/app');
const CredentialStore = require('../server/CredentialStore');
const ConfigStore = require('../server/ConfigStore');
const { readVersion } = require('../server/core/version');

let mainWindow = null;
let runtime = null;

async function createWindow() {
  const userDataDir = app.getPath('userData');
  const credentials = new CredentialStore(userDataDir, safeStorage);
  const configStore = new ConfigStore(userDataDir);
  runtime = await createApplicationServer({ userDataDir, credentials, configStore });

  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    title: `币安合约保护助手 V${readVersion()}`,
    backgroundColor: '#0b0f14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${runtime.port}`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow().catch(console.error); });
});

app.on('before-quit', async () => {
  try { await runtime?.shutdown(); } catch (e) { console.error(e); }
});
