// Desktop updates (docs/wave9-plan.md step 9b.4). Automatic (the default): a check a minute after starting and every
// six hours; a newer signed release is downloaded in the background, checked against the manifest's SHA-256, and
// installed when the app next closes (or now, if the person chooses to restart). Manual: nothing is fetched until the
// person asks. The choice is kept on this computer. Windows runs the signed NSIS installer silently; on Linux the
// AppImage is replaced; on macOS the downloaded disk image is opened for the person to drag in.
import { app, BrowserWindow, shell } from 'electron';
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  chmodSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decide, sha256Of, type Platform } from './update-check';

export type UpdateMode = 'auto' | 'manual';

export interface UpdateState {
  mode: UpdateMode;
  current: string;
  checking: boolean;
  checkedAt: string | null;
  /** Downloaded, checked, and waiting to be installed. */
  ready: { version: string; notes: string[]; required: boolean } | null;
  /** The reason nothing happened, in the person's words. */
  note: string | null;
}

const SIX_HOURS = 6 * 3_600_000;

export class Updater {
  private state: UpdateState;
  private file: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private installNow = false;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly publicKey: string | null,
    private readonly platform: Platform,
  ) {
    this.state = {
      mode: this.loadMode(),
      current: app.getVersion(),
      checking: false,
      checkedAt: null,
      ready: null,
      note: publicKey ? null : 'This build has no release key: update by hand.',
    };
  }

  private get dir() {
    return join(app.getPath('userData'), 'updates');
  }

  private loadMode(): UpdateMode {
    try {
      const v = JSON.parse(
        readFileSync(join(app.getPath('userData'), 'update-mode.json'), 'utf8'),
      ) as {
        mode?: string;
      };
      return v.mode === 'manual' ? 'manual' : 'auto';
    } catch {
      return 'auto';
    }
  }

  start() {
    if (this.state.mode === 'auto') this.schedule();
    app.on('will-quit', () => this.installIfReady());
  }

  private schedule() {
    if (this.timer) return;
    setTimeout(() => void this.check(), 60_000).unref();
    this.timer = setInterval(() => void this.check(), SIX_HOURS);
    this.timer.unref();
  }

  get(): UpdateState {
    return this.state;
  }

  setMode(mode: UpdateMode) {
    this.state = { ...this.state, mode };
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(join(app.getPath('userData'), 'update-mode.json'), JSON.stringify({ mode }));
    if (mode === 'auto') this.schedule();
    else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit();
  }

  private emit() {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('aerolith:update-state', this.state);
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /** Asks the server what the latest release is, and fetches it if it is newer and properly signed. */
  async check(): Promise<UpdateState> {
    if (this.state.checking || this.state.ready) return this.state;
    this.set({ checking: true });
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/updates`, {
        signal: AbortSignal.timeout(15_000),
      });
      const d = decide(res.ok ? ((await res.json()) as Parameters<typeof decide>[0]) : null, {
        platform: this.platform,
        current: this.state.current,
        publicKey: this.publicKey,
      });
      if (d.kind === 'none') {
        this.set({ checking: false, checkedAt: new Date().toISOString(), note: d.reason });
        return this.state;
      }
      mkdirSync(this.dir, { recursive: true });
      const name = basename(new URL(d.installer.url).pathname) || `aerolith-${d.version}`;
      const target = join(this.dir, name);
      const part = `${target}.part`;
      const dl = await fetch(d.installer.url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!dl.ok || !dl.body) throw new Error(`The download answered ${dl.status}.`);
      await pipeline(Readable.fromWeb(dl.body as never), createWriteStream(part));
      if ((await sha256Of(part)) !== d.installer.sha256) {
        rmSync(part, { force: true });
        throw new Error('The download did not match the release; it was thrown away.');
      }
      renameSync(part, target);
      this.file = target;
      this.set({
        checking: false,
        checkedAt: new Date().toISOString(),
        ready: { version: d.version, notes: d.notes, required: d.required },
        note: null,
      });
    } catch (err) {
      this.set({
        checking: false,
        checkedAt: new Date().toISOString(),
        note: `Could not check for updates: ${(err as Error).message}`,
      });
    }
    return this.state;
  }

  /** The person chose "Restart and update". */
  restartToUpdate() {
    if (!this.state.ready) return;
    this.installNow = true;
    app.quit();
  }

  private installIfReady() {
    const file = this.file;
    if (!file || !existsSync(file) || !this.state.ready) return;
    if (this.state.mode === 'manual' && !this.installNow) return;
    if (this.platform === 'windows') {
      spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    } else if (this.platform === 'linux' && process.env.APPIMAGE) {
      chmodSync(file, 0o755);
      renameSync(file, process.env.APPIMAGE);
      if (this.installNow) app.relaunch();
    } else {
      void shell.openPath(file);
    }
  }
}
