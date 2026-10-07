// Where the UI runs. The same bundle serves the browser and the Electron desktop app; the desktop preload script
// exposes `window.aerolithDesktop` (apps/desktop/src/preload.ts).

export interface DesktopBridge {
  apiBaseUrl: string;
  platform: 'windows' | 'macos' | 'linux';
  appVersion: string;
  deviceId(): Promise<string>;
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string | null): Promise<void>;
}

declare global {
  interface Window {
    aerolithDesktop?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.aerolithDesktop;
export const isDesktop = (): boolean => desktop() !== undefined;
export const clientKind = (): 'browser' | 'desktop' => (isDesktop() ? 'desktop' : 'browser');
/** Browser: same origin as the page (the server or Vite proxies /api). Desktop: the configured API URL. */
export const apiBase = (): string => desktop()?.apiBaseUrl ?? '';
