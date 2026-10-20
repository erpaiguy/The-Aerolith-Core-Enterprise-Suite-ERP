// Updates (docs/wave9-plan.md step 9b.4): a manifest signed with the release key is believed; one tampered with or
// signed by anyone else is not, and the last good one stays; with nothing configured, updating is by hand.
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, type ReleaseManifest } from '@aerolith/shared';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/config.js';
import { UpdatesService } from '../src/updates/updates.service.js';

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey,
  };
};
const release = pair();
const stranger = pair();
const manifest: ReleaseManifest = {
  version: '99.0.0',
  date: '2026-11-01',
  notes: ['Charts show their figures as a table.'],
  minimumVersion: '0.1.0',
};
const signedBy = (k: typeof release, m = manifest) => ({
  manifest: m,
  signature: sign(null, Buffer.from(canonicalJson(m)), k.privateKey).toString('base64'),
});
const serving = (body: unknown) =>
  (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
const service = (publicKey: string | null = release.publicKey) =>
  new UpdatesService({
    updates: {
      manifestUrl: publicKey ? 'https://releases.example.in/m.json' : null,
      publicKey,
      worker: false,
    },
  } as AppConfig);

describe('update checks', () => {
  it('believes a manifest signed with the release key', async () => {
    const s = await service().check(serving(signedBy(release)));
    expect(s).toMatchObject({ configured: true, available: true, required: false, problem: null });
    expect(s.latest?.version).toBe('99.0.0');
  });

  it('refuses one signed by anyone else, or changed after signing, and keeps the last good one', async () => {
    const svc = service();
    await svc.check(serving(signedBy(release)));
    const forged = await svc.check(
      serving(signedBy(stranger, { ...manifest, version: '100.0.0' })),
    );
    expect(forged.problem).toMatch(/not signed with this installation/);
    expect(forged.latest?.version).toBe('99.0.0');
    const changed = signedBy(release);
    changed.manifest = { ...manifest, notes: ['Something else'] };
    expect((await svc.check(serving(changed))).problem).toMatch(/not signed/);
  });

  it('says when this version is below the release’s minimum', async () => {
    const s = await service().check(
      serving(signedBy(release, { ...manifest, minimumVersion: '98.0.0' })),
    );
    expect(s.required).toBe(true);
  });

  it('with no key or address, updating is by hand', async () => {
    expect(await service(null).check()).toMatchObject({ configured: false, available: false });
  });

  it('the publisher’s tools make keys and sign manifests the server believes', async () => {
    const root = join(__dirname, '..', '..', '..');
    const keys = Object.fromEntries(
      execFileSync('node', [join(root, 'tools/release/keygen.mjs')], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((l) => l.split('=', 2) as [string, string]),
    );
    const dir = mkdtempSync(join(tmpdir(), 'aerolith-release-'));
    writeFileSync(join(dir, 'setup.exe'), 'installer bytes');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        desktop: { windows: { url: 'https://releases.example.in/setup.exe', file: 'setup.exe' } },
      }),
    );
    const signed = JSON.parse(
      execFileSync(
        'node',
        [join(root, 'tools/release/sign-manifest.mjs'), join(dir, 'manifest.json')],
        {
          encoding: 'utf8',
          env: { ...process.env, RELEASE_SIGNING_KEY: keys.RELEASE_SIGNING_KEY },
        },
      ),
    ) as { manifest: ReleaseManifest };
    expect(signed.manifest.desktop?.windows).toEqual({
      url: 'https://releases.example.in/setup.exe',
      sha256: createHash('sha256').update('installer bytes').digest('hex'),
      bytes: 15,
    });
    expect((await service(keys.RELEASE_PUBLIC_KEY!).check(serving(signed))).problem).toBeNull();
  });
});
