// Signs a release manifest (docs/release.md):
//   RELEASE_SIGNING_KEY=... node tools/release/sign-manifest.mjs release/manifest.json > release/manifest.signed.json
// The manifest's installers get their SHA-256 and size filled in from local files named in `file` (and `file` is
// dropped), so what is signed is exactly what was built.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const path = process.argv[2];
const key = process.env.RELEASE_SIGNING_KEY;
if (!path || !key) {
  process.stderr.write(
    'Usage: RELEASE_SIGNING_KEY=<base64 pkcs8> node tools/release/sign-manifest.mjs manifest.json\n',
  );
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(path, 'utf8'));
for (const [os, f] of Object.entries(manifest.desktop ?? {})) {
  if (!f.file) continue;
  const file = resolve(dirname(path), f.file);
  manifest.desktop[os] = {
    url: f.url,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    bytes: statSync(file).size,
  };
}

/** Same as canonicalJson in packages/shared/src/release.ts. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

const privateKey = createPrivateKey({
  key: Buffer.from(key, 'base64'),
  format: 'der',
  type: 'pkcs8',
});
const signature = sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64');
process.stdout.write(`${JSON.stringify({ manifest, signature }, null, 2)}\n`);
