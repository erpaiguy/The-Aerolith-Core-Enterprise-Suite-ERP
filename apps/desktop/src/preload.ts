// Runs in the sandboxed renderer before the UI. Exposes a narrow, typed bridge (window.aerolithDesktop) and nothing
// else: no Node APIs reach the page (docs/09-security.md §3.8).
import { contextBridge, ipcRenderer } from 'electron';

const arg = (name: string): string =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? '';

contextBridge.exposeInMainWorld('aerolithDesktop', {
  apiBaseUrl: arg('aerolith-api'),
  platform: arg('aerolith-platform'),
  appVersion: arg('aerolith-version'),
  deviceId: (): Promise<string> => ipcRenderer.invoke('aerolith:device-id'),
  getRefreshToken: (): Promise<string | null> => ipcRenderer.invoke('aerolith:refresh-token:get'),
  setRefreshToken: (token: string | null): Promise<void> =>
    ipcRenderer.invoke('aerolith:refresh-token:set', token),
  /** While on, closing the window asks the UI first (step 9a.4). */
  setCloseGuard: (on: boolean): Promise<void> => ipcRenderer.invoke('aerolith:close-guard', on),
  /** Called when the window is asked to close; answer with answerClose. Returns a function that stops listening. */
  onCloseRequested: (f: () => void): (() => void) => {
    const listener = () => f();
    ipcRenderer.on('aerolith:close-requested', listener);
    return () => ipcRenderer.removeListener('aerolith:close-requested', listener);
  },
  answerClose: (close: boolean): Promise<void> =>
    ipcRenderer.invoke('aerolith:close-answer', close),
});
