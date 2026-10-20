// Releases and updates (docs/wave9-plan.md step 9b.4). A release is described by a manifest the publisher signs with
// an Ed25519 key (tools/release/sign-manifest.mjs); installations check it against the matching public key given to
// them at build or deploy time, so an update can come from any plain file host without a paid update service, and a
// manifest that was tampered with on the way is refused.

export interface ReleaseFile {
  url: string;
  /** Hex SHA-256 of the file; the desktop app installs nothing that does not match. */
  sha256: string;
  bytes: number;
}

export interface ReleaseManifest {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** What changed, a line each, in the person's words. */
  notes: string[];
  /** Installations older than this must update (a security fix): the notice says so plainly. */
  minimumVersion?: string;
  desktop?: Partial<Record<'windows' | 'macos' | 'linux', ReleaseFile>>;
  /** The server images' tag, for `docker compose pull`. */
  serverImageTag?: string;
}

export interface SignedManifest {
  manifest: ReleaseManifest;
  /** Base64 Ed25519 signature of canonicalJson(manifest). */
  signature: string;
}

/** JSON with object keys in sorted order at every depth, so signer and checker hash the same bytes. */
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

/** Compares dotted versions (1.10.0 > 1.9.2); a pre-release (1.0.0-rc.1) is older than its release. */
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

/** What an installation tells people about updates. */
export interface UpdateStatus {
  current: string;
  /** False when this installation was given no public key or update address: updating is by hand. */
  configured: boolean;
  checkedAt: string | null;
  latest: ReleaseManifest | null;
  available: boolean;
  /** This version is below the release's minimum: update now. */
  required: boolean;
  /** Why the last check failed, if it did. */
  problem: string | null;
}
