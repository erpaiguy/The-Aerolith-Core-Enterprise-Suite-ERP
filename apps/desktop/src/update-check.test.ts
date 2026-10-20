import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, decide, sha256Of, type Manifest } from './update-check';

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
};
const release = keys();
const other = keys();
const sha = 'a'.repeat(64);
const manifest: Manifest = {
  version: '1.2.0',
  date: '2026-11-01',
  notes: ['Faster grids.'],
  desktop: {
    windows: { url: 'https://releases.example.in/Aerolith-1.2.0.exe', sha256: sha, bytes: 9 },
  },
};
const signed = (m: Manifest, k = release) => ({
  latest: m,
  signature: sign(null, Buffer.from(canonicalJson(m)), k.privateKey).toString('base64'),
});
const opts = { platform: 'windows' as const, current: '1.1.0', publicKey: release.pub };

describe('desktop updates', () => {
  it('takes a newer, signed release with an installer for this computer', () => {
    expect(decide(signed(manifest), opts)).toMatchObject({
      kind: 'update',
      version: '1.2.0',
      required: false,
    });
  });

  it('ignores a release signed by anyone else, or changed after signing', () => {
    expect(decide(signed(manifest, other), opts)).toMatchObject({
      kind: 'none',
      reason: /not signed/,
    });
    const s = signed(manifest);
    s.latest = {
      ...manifest,
      desktop: { windows: { ...manifest.desktop!.windows!, url: 'https://evil.example/x.exe' } },
    };
    expect(decide(s, opts)).toMatchObject({ kind: 'none', reason: /not signed/ });
  });

  it('does nothing when already up to date, with no key, or with no installer here', () => {
    expect(decide(signed(manifest), { ...opts, current: '1.2.0' }).kind).toBe('none');
    expect(decide(signed(manifest), { ...opts, publicKey: null })).toMatchObject({
      reason: /by hand/,
    });
    expect(decide(signed(manifest), { ...opts, platform: 'linux' })).toMatchObject({
      reason: /no installer/,
    });
  });

  it('says when an update is required', () => {
    expect(decide(signed({ ...manifest, minimumVersion: '1.1.5' }), opts)).toMatchObject({
      required: true,
    });
  });

  it('hashes a downloaded file to check it', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'aerolith-upd-')), 'x');
    writeFileSync(f, 'abc');
    expect(await sha256Of(f)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
