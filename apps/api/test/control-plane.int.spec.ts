// End-to-end control plane tests against a real Postgres. Needs TEST_CONTROL_DATABASE_URL pointing at a throwaway
// database (the test drops and recreates the `core` schema). CI provides one; locally the suite is skipped without it.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { migrate } from '../src/db/migrate.js';

const url = process.env.TEST_CONTROL_DATABASE_URL;
if (process.env.CI && !url) throw new Error('TEST_CONTROL_DATABASE_URL is required in CI');

const OWNER = randomBytes(32).toString('base64url');
const owner = { authorization: `Bearer ${OWNER}` };
const DAY = 86_400_000;

describe.skipIf(!url)('control plane (integration)', () => {
  let app: NestFastifyApplication;
  let sql: Sql;

  const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api${path}`, payload: payload as object, headers });
  const createTrial = async (email: string) => {
    const res = await post('/owner/tenants', { email, tenantName: 'Sharma Builders' }, owner);
    expect(res.statusCode).toBe(201);
    return res.json<{ tenantId: string; licenceId: string; licenceKey: string; endsAt: string }>();
  };
  const activate = (key: string, deviceId = randomUUID()) =>
    post('/licences/activate', { key, deviceId, platform: 'windows', label: 'Site office PC' });

  beforeAll(async () => {
    sql = postgres(url!, { onnotice: () => {} });
    await sql`DROP SCHEMA IF EXISTS core CASCADE`;
    await sql`DROP SCHEMA IF EXISTS aerolith_meta CASCADE`;
    process.env.CONTROL_DATABASE_URL = url;
    process.env.OWNER_API_TOKEN = OWNER;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await migrate(sql);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it('migrations are idempotent and reject edited files', async () => {
    expect(await migrate(sql)).toEqual({
      applied: [],
      skipped: ['0001_core.sql', '0002_tenant_db.sql'],
    });
    await sql`UPDATE aerolith_meta.schema_migration SET checksum = 'x' WHERE name = '0001_core.sql'`;
    await expect(migrate(sql)).rejects.toThrow(/changed after it was applied/);
    await sql`DELETE FROM aerolith_meta.schema_migration`;
    await sql`DROP SCHEMA core CASCADE`;
    await migrate(sql);
  });

  it('owner routes require the owner token', async () => {
    expect((await post('/owner/tenants', { email: 'a@b.in', tenantName: 'X Co' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await post(
          '/owner/tenants',
          { email: 'a@b.in', tenantName: 'X Co' },
          { authorization: 'Bearer nope' },
        )
      ).statusCode,
    ).toBe(401);
  });

  it('creates a tenant with a 120-day, 3-seat trial and queues the key email without the key', async () => {
    const before = Date.now();
    const trial = await createTrial('owner1@sharma.in');
    expect(trial.licenceKey).toMatch(/^AERO-/);
    const ends = new Date(trial.endsAt).getTime();
    expect(ends - before).toBeGreaterThanOrEqual(120 * DAY - 5000);
    expect(ends - before).toBeLessThanOrEqual(120 * DAY + 5000);

    const [licence] = await sql`SELECT * FROM core.licence WHERE id = ${trial.licenceId}`;
    expect(licence).toMatchObject({ seat_cap: 3, max_devices: 6, kind: 'trial', status: 'active' });
    expect(JSON.stringify(licence)).not.toContain(trial.licenceKey.slice(5)); // only HMAC + ciphertext stored

    const outbox = await sql`SELECT template, data FROM core.email_outbox`;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ template: 'licence_key' });
    expect(JSON.stringify(outbox)).not.toContain(trial.licenceKey.slice(5));

    const reveal = await post(`/owner/licences/${trial.licenceId}/reveal-key`, {}, owner);
    expect(reveal.json()).toEqual({ licenceKey: trial.licenceKey });
  });

  it('allows one trial per email, case-insensitively', async () => {
    await createTrial('Repeat@Example.in');
    const again = await post(
      '/owner/tenants',
      { email: 'repeat@example.IN', tenantName: 'Again' },
      owner,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'trial_already_used' });
  });

  it('activates devices, tolerates sloppy typing, and enforces the device limit', async () => {
    const trial = await createTrial('devices@example.in');
    const deviceId = randomUUID();
    const first = await activate(trial.licenceKey.toLowerCase().replace(/-/g, ' '), deviceId);
    expect(first.statusCode).toBe(200);
    const body = first.json<{
      token: string;
      featuresUnlocked: boolean;
      entitlement: { state: string; seats: number };
    }>();
    expect(body.featuresUnlocked).toBe(true);
    expect(body.entitlement).toMatchObject({ state: 'active', seats: 3 });

    expect((await activate(trial.licenceKey, deviceId)).statusCode).toBe(200); // same device: no new activation
    for (let i = 0; i < 5; i++) expect((await activate(trial.licenceKey)).statusCode).toBe(200);
    const seventh = await activate(trial.licenceKey);
    expect(seventh.statusCode).toBe(409);
    expect(seventh.json()).toMatchObject({ code: 'device_limit' });

    const details = (
      await app.inject({
        method: 'GET',
        url: `/api/owner/licences/${trial.licenceId}`,
        headers: owner,
      })
    ).json<{
      devices: { id: string }[];
      events: { kind: string }[];
    }>();
    expect(details.devices).toHaveLength(6);
    expect(details.events.filter((e) => e.kind === 'activated')).toHaveLength(6);

    // Freeing a device makes room; the removed device cannot come back.
    const removed = details.devices[0]!.id;
    expect(
      (await post(`/owner/licences/${trial.licenceId}/devices/${removed}/revoke`, {}, owner))
        .statusCode,
    ).toBe(200);
    expect((await activate(trial.licenceKey)).statusCode).toBe(200);
    const back = await activate(trial.licenceKey, deviceId);
    expect(back.json()).toMatchObject({ code: 'device_revoked' });
  });

  it('distinguishes typos from unknown keys', async () => {
    const trial = await createTrial('typo@example.in');
    const k = trial.licenceKey;
    const last = k.at(-1) === 'A' ? 'B' : 'A';
    const typo = await activate(k.slice(0, -1) + last);
    expect(typo.statusCode).toBe(400);
    expect(typo.json()).toMatchObject({ code: 'invalid_key_format' });

    // A well-formed key that was never issued.
    const { generateLicenceKey } = await import('../src/licensing/licence-key.js');
    expect((await activate(generateLicenceKey())).statusCode).toBe(404);
  });

  it('extends and shortens trials with notice, and tells the tenant in-app and by email', async () => {
    const trial = await createTrial('trialchange@example.in');
    const { token } = (await activate(trial.licenceKey)).json<{ token: string }>();

    const extendTo = new Date(Date.now() + 200 * DAY).toISOString();
    const ext = await post(
      `/owner/licences/${trial.licenceId}/trial-end`,
      { newEndsAt: extendTo, reason: 'Pilot customer' },
      owner,
    );
    expect(ext.statusCode).toBe(200);
    expect(ext.json()).toMatchObject({ kind: 'extended' });

    const tooSoon = await post(
      `/owner/licences/${trial.licenceId}/trial-end`,
      { newEndsAt: new Date(Date.now() + 3 * DAY).toISOString() },
      owner,
    );
    expect(tooSoon.statusCode).toBe(400);
    expect(tooSoon.json()).toMatchObject({ code: 'notice_too_short' });

    const shorten = await post(
      `/owner/licences/${trial.licenceId}/trial-end`,
      { newEndsAt: new Date(Date.now() + 30 * DAY).toISOString() },
      owner,
    );
    expect(shorten.json()).toMatchObject({ kind: 'shortened' });

    const notices = await app.inject({
      method: 'GET',
      url: '/api/licences/notices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(notices.json<{ kind: string }[]>().map((n) => n.kind)).toEqual([
      'trial_shortened',
      'trial_extended',
    ]);
    const emails =
      await sql`SELECT template FROM core.email_outbox WHERE data->>'licenceId' = ${trial.licenceId}`;
    expect(emails.map((e) => e.template).sort()).toEqual([
      'licence_key',
      'trial_changed',
      'trial_changed',
    ]);

    // A refreshed token carries the new end date.
    const refreshed = await post('/licences/refresh', { token });
    expect(refreshed.json<{ entitlement: { ends: string } }>().entitlement.ends.slice(0, 10)).toBe(
      new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10),
    );
  });

  it('revocation blocks activation and refresh', async () => {
    const trial = await createTrial('revoke@example.in');
    const { token } = (await activate(trial.licenceKey)).json<{ token: string }>();
    expect(
      (await post(`/owner/licences/${trial.licenceId}/revoke`, { reason: 'Chargeback' }, owner))
        .statusCode,
    ).toBe(200);
    expect((await activate(trial.licenceKey)).json()).toMatchObject({ code: 'licence_revoked' });
    expect((await post('/licences/refresh', { token })).statusCode).toBe(403);
  });

  it('rejects forged tokens', async () => {
    const res = await post('/licences/refresh', { token: 'ent1.eyJ2IjoxfQ.AAAA' });
    expect(res.statusCode).toBe(401);
  });

  it('keeps event tables append-only', async () => {
    await expect(sql`UPDATE core.licence_event SET actor = 'x'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM core.owner_audit`).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE core.download_event`).rejects.toThrow(/append-only/);
  });

  it('records downloads and validates input', async () => {
    const ok = await post('/downloads', {
      email: 'x@y.in',
      kind: 'trial',
      seats: 3,
      platform: 'windows',
      appVersion: '0.1.0',
    });
    expect(ok.statusCode).toBe(204);
    const bad = await post('/downloads', {
      email: 'not-an-email',
      kind: 'trial',
      seats: 0,
      platform: 'windows',
      appVersion: '',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_request' });
  });
});
