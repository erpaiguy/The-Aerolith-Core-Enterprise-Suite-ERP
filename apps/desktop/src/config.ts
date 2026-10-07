// Desktop configuration. The API address is baked in at build time (resources/app-config.json, written by the
// release pipeline) and can be overridden for development with AEROLITH_API_URL.
import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_ORIGIN = 'app://aerolith';

export interface DesktopConfig {
  apiBaseUrl: string;
  /** Directory holding the built web UI (apps/web/dist). */
  webRoot: string;
}

export function loadConfig(): DesktopConfig {
  const packaged = app.isPackaged;
  const resources = packaged ? process.resourcesPath : join(__dirname, '..', 'resources');
  const file = join(resources, 'app-config.json');
  const fromFile = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopConfig>)
    : {};
  const apiBaseUrl = process.env.AEROLITH_API_URL ?? fromFile.apiBaseUrl ?? 'http://127.0.0.1:3000';
  const url = new URL(apiBaseUrl);
  if (packaged && url.protocol !== 'https:')
    throw new Error('Packaged builds must use an https API URL');
  return {
    apiBaseUrl: url.origin,
    webRoot: packaged
      ? join(process.resourcesPath, 'web')
      : join(__dirname, '..', '..', 'web', 'dist'),
  };
}
