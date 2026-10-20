// Updates (docs/wave9-plan.md step 9b.4). Once a day, and when an admin asks, the server reads the signed release
// manifest from UPDATE_MANIFEST_URL and checks its Ed25519 signature against RELEASE_PUBLIC_KEY; a manifest that does
// not check is ignored and the reason kept. What it found is told to the sign-in screen, the status bar and the
// desktop app (which downloads the installer and checks it against the manifest's SHA-256). With no address or key
// configured, updating is by hand and the app says so.
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createPublicKey, verify } from 'node:crypto';
import {
  canonicalJson,
  compareVersions,
  type ReleaseManifest,
  type SignedManifest,
  type UpdateStatus,
} from '@aerolith/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { API_VERSION } from '../version.js';

const DAY_MS = 24 * 3_600_000;
const MAX_BYTES = 256 * 1024;

/** True when `signed` was signed by the holder of the key whose SPKI DER, base64, is `publicKey`. */
export function manifestSignedBy(signed: SignedManifest, publicKey: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(canonicalJson(signed.manifest)),
      key,
      Buffer.from(signed.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** The shape a manifest must have before anything is shown from it. */
export function looksLikeManifest(m: unknown): m is ReleaseManifest {
  const r = m as ReleaseManifest;
  return (
    !!r &&
    typeof r.version === 'string' &&
    /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(r.version) &&
    typeof r.date === 'string' &&
    Array.isArray(r.notes) &&
    r.notes.every((n) => typeof n === 'string')
  );
}

@Injectable()
export class UpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(UpdatesService.name);
  private timer: NodeJS.Timeout | null = null;
  private latest: ReleaseManifest | null = null;
  private signature: string | null = null;
  private checkedAt: Date | null = null;
  private problem: string | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onModuleInit() {
    if (!this.config.updates.worker || !this.configured()) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), DAY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  configured() {
    return !!(this.config.updates.manifestUrl && this.config.updates.publicKey);
  }

  status(): UpdateStatus {
    const latest = this.latest;
    return {
      current: API_VERSION,
      configured: this.configured(),
      checkedAt: this.checkedAt?.toISOString() ?? null,
      latest,
      signature: this.signature,
      available: !!latest && compareVersions(latest.version, API_VERSION) > 0,
      required: !!latest?.minimumVersion && compareVersions(API_VERSION, latest.minimumVersion) < 0,
      problem: this.problem,
    };
  }

  /** Reads and checks the manifest; keeps the last good one when this attempt fails. */
  async check(fetchImpl: typeof fetch = fetch): Promise<UpdateStatus> {
    const { manifestUrl, publicKey } = this.config.updates;
    if (!manifestUrl || !publicKey) return this.status();
    try {
      const res = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`The release address answered ${res.status}.`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('The release manifest is too large.');
      const signed = JSON.parse(text) as SignedManifest;
      if (!looksLikeManifest(signed.manifest) || typeof signed.signature !== 'string')
        throw new Error('The release manifest is not in the expected form.');
      if (!manifestSignedBy(signed, publicKey))
        throw new Error('The release manifest is not signed with this installation’s release key.');
      this.latest = signed.manifest;
      this.signature = signed.signature;
      this.problem = null;
    } catch (err) {
      this.problem = (err as Error).message;
      this.log.warn(`Update check failed: ${this.problem}`);
    }
    this.checkedAt = new Date();
    return this.status();
  }
}
