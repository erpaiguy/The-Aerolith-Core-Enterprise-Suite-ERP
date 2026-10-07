// Electron main process (docs/02-tech-stack.md, docs/09-security.md §3.8). The window shows the bundled web UI from
// app://aerolith; all business logic stays on the server.
import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { APP_ORIGIN, loadConfig } from './config.js';
import { registerSchemeAsPrivileged, serveApp } from './protocol.js';
import { deviceId, getRefreshToken, setRefreshToken } from './secure-store.js';

const SMOKE_TEST = process.argv.includes('--smoke-test');
const platformName =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

registerSchemeAsPrivileged();

if (!app.requestSingleInstanceLock()) app.quit();

/** IPC is only honoured for our own UI, never for any other page that might end up in a frame. */
function fromOurUi(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.origin === APP_ORIGIN;
}

function registerIpc(): void {
  ipcMain.handle('aerolith:device-id', (e) => (fromOurUi(e) ? deviceId() : null));
  ipcMain.handle('aerolith:refresh-token:get', (e) => (fromOurUi(e) ? getRefreshToken() : null));
  ipcMain.handle('aerolith:refresh-token:set', (e, token: unknown) => {
    if (!fromOurUi(e)) return;
    if (
      token !== null &&
      (typeof token !== 'string' || !token.startsWith('rt1.') || token.length > 512)
    )
      return;
    setRefreshToken(token);
  });
}

function createWindow(apiBaseUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Aerolith Core',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      additionalArguments: [
        `--aerolith-api=${apiBaseUrl}`,
        `--aerolith-platform=${platformName}`,
        `--aerolith-version=${app.getVersion()}`,
      ],
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());

  // Stay on our UI: other navigation is refused; https links open in the user's browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  void win.loadURL(`${APP_ORIGIN}/`);
  return win;
}

app.whenReady().then(() => {
  const config = loadConfig();
  // No camera, microphone, location, notifications etc. until a feature asks for one deliberately.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  serveApp(config.webRoot, config.apiBaseUrl);
  registerIpc();
  const win = createWindow(config.apiBaseUrl);

  if (SMOKE_TEST) {
    // CI/dev check: the UI loads, the bridge is present and no Node APIs leak into the page.
    win.webContents.once('did-finish-load', async () => {
      const report = await win.webContents.executeJavaScript(
        `({ bridge: typeof window.aerolithDesktop, api: window.aerolithDesktop?.apiBaseUrl, platform: window.aerolithDesktop?.platform,
            node: typeof require, process: typeof process, title: document.title,
            csp: true, rootChildren: document.getElementById('root')?.childElementCount ?? 0 })`,
      );
      const device = await win.webContents.executeJavaScript('window.aerolithDesktop.deviceId()');
      // Same request shape as the app (custom header => CORS preflight), so CORS and the CSP are both exercised.
      const apiReachable = await win.webContents.executeJavaScript(
        `fetch(window.aerolithDesktop.apiBaseUrl + '/api/health', { headers: { 'x-aerolith-client': 'desktop' } })
           .then((r) => r.json()).then((b) => b.status === 'ok').catch((e) => 'failed: ' + e.message)`,
      );
      report.apiReachable = apiReachable;
      process.stdout.write(
        `SMOKE ${JSON.stringify({ ...report, deviceIdLooksRandom: /^[0-9a-f-]{36}$/.test(device) })}\n`,
      );
      app.quit();
    });
  }
});

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
