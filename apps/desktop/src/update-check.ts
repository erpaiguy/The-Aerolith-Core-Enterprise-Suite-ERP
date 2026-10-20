// What the desktop app decides about an update (docs/wave9-plan.md step 9b.4), kept apart from Electron so it can be
// tested: the manifest the server passes on must carry the publisher's signature, checked here with the key built
// into this app; the installer for this platform must be newer than this version; the downloaded file must match the
// manifest's SHA-256. Nothing else is ever run.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';

export type Platform = 'windows' | 'macos' | 'linux';

export interface InstallerRef {
  url: string;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  version: string;
  date: string;
  notes: string[];
  minimumVersion?: string;
  desktop?: Partial<Record<Platform, InstallerRef>>;
}

/** Same as canonicalJson in packages/shared/src/release.ts: the bytes the publisher signed. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Same as compareVersions in packages/shared/src/release.ts. */
export function compareVersions(a: string, b: string): number {
  const [ma, pa] = a.split('-', 2) as [string, string | undefined];
  const [mb, pb] = b.split('-', 2) as [string, string | undefined];
  const na = ma.split('.').map(Number);
  const nb = mb.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

export function signedBy(manifest: Manifest, signature: string, publicKey: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(canonicalJson(manifest)),
      key,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export type Decision =
  | { kind: 'none'; reason: string }
  | {
      kind: 'update';
      version: string;
      notes: string[];
      required: boolean;
      installer: InstallerRef;
    };

/** Whether to fetch an update for this app, from what the server says (GET /api/updates). */
export function decide(
  status: { latest: Manifest | null; signature: string | null } | null,
  opts: { platform: Platform; current: string; publicKey: string | null },
): Decision {
  if (!opts.publicKey)
    return { kind: 'none', reason: 'This build has no release key: update by hand.' };
  const m = status?.latest;
  if (!m || !status.signature) return { kind: 'none', reason: 'No release is known yet.' };
  if (!signedBy(m, status.signature, opts.publicKey))
    return { kind: 'none', reason: 'The release is not signed with this app’s key; ignored.' };
  if (compareVersions(m.version, opts.current) <= 0)
    return { kind: 'none', reason: 'This is the latest version.' };
  const installer = m.desktop?.[opts.platform];
  if (!installer || !/^https:\/\//.test(installer.url) || !/^[0-9a-f]{64}$/.test(installer.sha256))
    return { kind: 'none', reason: `Version ${m.version} has no installer for this computer yet.` };
  return {
    kind: 'update',
    version: m.version,
    notes: m.notes,
    required: !!m.minimumVersion && compareVersions(opts.current, m.minimumVersion) < 0,
    installer,
  };
}

export function sha256Of(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', fail)
      .on('end', () => ok(h.digest('hex')));
  });
}
