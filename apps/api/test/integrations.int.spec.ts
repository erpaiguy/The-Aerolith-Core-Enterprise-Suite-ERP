// Integrations in a real tenant database (docs/wave6-plan.md step 6): an API key made, used for the report views,
// refused without its scope and after it is revoked; the OpenAPI document; a webhook receiving a signed test and a
// signed `order.issued` written in the order's own transaction, a failure retried on schedule; the Tally agent
// fetching pending vouchers as Tally XML from a fake Tally, reporting back, and a refused voucher staying pending.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import {
  isPrivateAddress,
  nextAttempt,
  parseApiKey,
  sign,
  verify,
} from '../src/integrations/integration-rules.js';
import { WebhooksService } from '../src/integrations/webhooks.service.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
// @ts-expect-error: a plain script without types (tools/tally-agent)
import { parseTallyReply, syncOnce } from '../../../tools/tally-agent/agent.mjs';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);
type H = Record<string, string>;

describe('integration rules', () => {
  it('signs and verifies, schedules retries, refuses private addresses and reads keys and Tally replies', () => {
    const body = '{"event":"ping"}';
    const header = sign('whsec_x', 1_800_000_000, body);
    expect(verify('whsec_x', header, body, 1_800_000_100)).toBe(true);
    expect(verify('whsec_x', header, `${body} `, 1_800_000_100)).toBe(false);
    expect(verify('whsec_y', header, body, 1_800_000_100)).toBe(false);
    expect(verify('whsec_x', header, body, 1_800_001_000)).toBe(false);
    const now = new Date('2026-10-12T10:00:00Z');
    expect(nextAttempt(1, now)?.toISOString()).toBe('2026-10-12T10:01:00.000Z');
    expect(nextAttempt(5, now)?.toISOString()).toBe('2026-10-12T22:00:00.000Z');
    expect(nextAttempt(6, now)).toBeNull();
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '172.20.0.1',
      '192.168.1.9',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111'])
      expect(isPrivateAddress(ip)).toBe(false);
    expect(parseApiKey('aek1.x.y.z')).toBeNull();
    expect(
      parseTallyReply(
        '<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger &apos;X&apos; does not exist!</LINEERROR></RESPONSE>',
      ),
    ).toEqual({
      created: 0,
      altered: 0,
      errors: 1,
      message: 'Ledger &apos;X&apos; does not exist!',
    });
  });
});

describe.skipIf(!controlUrl || !adminUrl)('integrations (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: H;
  let hook: Server;
  let hookUrl: string;
  const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let failNext = 0;

  const req = (method: 'GET' | 'POST' | 'PUT', url: string, headers: H, payload?: object) =>
    app.inject({ method, url: `/api${url}`, headers, ...(payload ? { payload } : {}) });
  const post = (url: string, payload: object = {}, headers: H = t.admin) =>
    req('POST', url, headers, payload);
  const get = (url: string, headers: H = t.admin) => req('GET', url, headers);
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };

  beforeAll(async () => {
    hook = createServer((rq, rs) => {
      let body = '';
      rq.on('data', (c: Buffer) => (body += c.toString()));
      rq.on('end', () => {
        received.push({ headers: rq.headers, body });
        if (failNext > 0) {
          failNext--;
          rs.writeHead(500).end('busy');
        } else rs.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/aerolith`;

    control = postgres(controlUrl!, { onnotice: () => {} });
    server = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    for (const { datname } of await server<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE datname LIKE 'tenant\\_t%'`) {
      await server.unsafe(`DROP DATABASE "${datname}" WITH (FORCE)`);
    }
    await control`DROP SCHEMA IF EXISTS core CASCADE`;
    await control`DROP SCHEMA IF EXISTS aerolith_meta CASCADE`;
    await migrate(control);
    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      CONTROL_PLANE_ENC_KEY: ENC.toString('base64'),
      LOCAL_PG_ADMIN_URL: adminUrl,
      RATE_LIMIT_SCALE: '50',
      PUBLIC_API_URL: 'https://api.example.in',
      WEBHOOK_ALLOW_PRIVATE: 'true',
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-int-test-')),
      DOCUMENT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-int-files-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'int-admin@example.in');
    const created = (
      await post('/tenant/users', { username: 'suresh', displayName: 'Suresh', role: 'manager' })
    ).json<{ temporaryPassword: string }>();
    const login = (password: string) =>
      post(
        '/auth/login',
        { entitlementToken: t.entitlement, identifier: 'suresh', password, client: 'desktop' },
        {},
      ).then((r) => r.json<{ accessToken: string }>().accessToken);
    const first = await login(created.temporaryPassword);
    await post(
      '/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: 'Bar-Bending-Yard-44' },
      { authorization: `Bearer ${first}` },
    );
    manager = { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` };
    db = await app.get(TenantConnections).forTenant(t.tenantId);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
    hook?.close();
  });

  it('serves the report views to a key with the scope, and refuses it without or once revoked', async () => {
    expect(
      (
        await post(
          '/tenant/integrations/api-keys',
          { name: 'BI', scopes: ['reports:read'] },
          manager,
        )
      ).statusCode,
    ).toBe(403);
    const made = await ok<{ id: string; key: string }>(
      post('/tenant/integrations/api-keys', { name: 'Power BI', scopes: ['reports:read'] }),
    );
    expect(made.key).toMatch(/^aek1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const asKey = { authorization: `Bearer ${made.key}` };
    await ok(post('/tenant/projects', { name: 'Hostel, Washim' }, manager));
    await ok(post('/tenant/projects', { name: 'School, Akola' }, manager));

    const views = await ok<{ name: string }[]>(get('/v1/views', asKey));
    expect(views.map((v) => v.name)).toContain('projects');
    const rows = await ok<{ rows: Record<string, unknown>[] }>(
      post(
        '/v1/views/projects/query',
        { fields: ['name'], sort: { field: 'name', dir: 'asc' } },
        asKey,
      ),
    );
    expect(rows.rows.map((r) => r.name)).toEqual(['Hostel, Washim', 'School, Akola']);
    // No SQL from outside: a field that is not in the view is refused.
    expect(
      (await post('/v1/views/projects/query', { fields: ['name; drop table x'] }, asKey))
        .statusCode,
    ).toBe(400);

    // A staff token is not a key; a key is not a staff token.
    expect((await get('/v1/views', t.admin)).statusCode).toBe(401);
    expect((await get('/tenant/projects', asKey)).statusCode).toBe(401);
    // Scope.
    const tally = await ok<{ key: string }>(
      post('/tenant/integrations/api-keys', { name: 'Tally PC', scopes: ['tally'] }),
    );
    const noScope = await get('/v1/views', { authorization: `Bearer ${tally.key}` });
    expect([noScope.statusCode, noScope.json<{ code: string }>().code]).toEqual([
      403,
      'scope_missing',
    ]);
    // Revoked.
    await ok(post(`/tenant/integrations/api-keys/${made.id}/revoke`));
    expect((await get('/v1/views', asKey)).statusCode).toBe(401);
    const keys = await ok<{ name: string; revokedAt: string | null; lastUsedAt: string | null }[]>(
      get('/tenant/integrations/api-keys'),
    );
    expect(keys.find((k) => k.name === 'Power BI')).toMatchObject({
      revokedAt: expect.any(String),
      lastUsedAt: expect.any(String),
    });

    const doc = await ok<{ openapi: string; paths: Record<string, unknown> }>(
      get('/v1/openapi.json', {}),
    );
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual([
      '/views',
      '/views/{view}/query',
      '/tally/pending',
      '/tally/results',
    ]);
  });

  it('sends signed webhooks from the outbox, and retries a failure on schedule', async () => {
    expect(
      (
        await post('/tenant/integrations/webhooks', {
          url: 'ftp://x.example.in',
          events: ['order.issued'],
        })
      ).statusCode,
    ).toBe(400);
    const h = await ok<{ id: string; secret: string }>(
      post('/tenant/integrations/webhooks', { url: hookUrl, events: ['order.issued'] }),
    );
    expect(h.secret).toMatch(/^whsec_/);
    await ok(post(`/tenant/integrations/webhooks/${h.id}/test`));
    expect(received).toHaveLength(1);
    const ping = received[0]!;
    expect(
      verify(
        h.secret,
        String(ping.headers['x-aerolith-signature']),
        ping.body,
        Math.floor(Date.now() / 1000),
      ),
    ).toBe(true);
    expect(JSON.parse(ping.body)).toMatchObject({ event: 'ping' });

    // An order issued: one delivery written with it; the first attempt fails and is retried a minute later.
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    await ok(
      post(`/tenant/companies/${company.id}`, {
        name: 'Washim Infra Pvt Ltd',
        gstin: '27AAACW1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Godown, Washim' }, manager))
    ).id;
    const site = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    const party = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Shinde Steel Traders',
          isClient: false,
          isVendor: true,
          gstin: '27ABCPK1234L1Z5',
        }),
      )
    ).id;
    const o = await ok<{ open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: party,
          siteId: site,
          lines: [{ description: 'TMT bars', unit: 't', qty: '2', rate: '62000', gstPct: '18' }],
        },
        manager,
      ),
    );
    const [queued] = await db<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM platform.webhook_delivery WHERE event = 'order.issued'`;
    expect(queued!.n).toBe(0);
    failNext = 1;
    const issued = await ok<{ id: string; number: string }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    const sender = app.get(WebhooksService);
    expect(await sender.sendDue(t.tenantId)).toBe(1);
    const [d] = await db<
      { status: string; attempts: number; last_status: number; next_at: Date }[]
    >`
      SELECT status, attempts, last_status, next_at FROM platform.webhook_delivery WHERE event = 'order.issued'`;
    expect([d!.status, d!.attempts, d!.last_status]).toEqual(['pending', 1, 500]);
    expect(await sender.sendDue(t.tenantId)).toBe(0); // not due yet
    expect(await sender.sendDue(t.tenantId, new Date(Date.now() + 2 * 60_000))).toBe(1);
    const last = received.at(-1)!;
    const event = JSON.parse(last.body) as {
      event: string;
      data: { orderId: string; number: string };
    };
    expect([event.event, event.data.orderId, event.data.number]).toEqual([
      'order.issued',
      issued.id,
      issued.number,
    ]);
    expect(
      verify(
        h.secret,
        String(last.headers['x-aerolith-signature']),
        last.body,
        Math.floor(Date.now() / 1000),
      ),
    ).toBe(true);
    const list = await ok<{ deliveries: { event: string; status: string; attempts: number }[] }>(
      get('/tenant/integrations/webhooks'),
    );
    expect(list.deliveries.find((x) => x.event === 'order.issued')).toMatchObject({
      status: 'delivered',
      attempts: 2,
    });
  });

  it('runs the Tally agent against a fake Tally: created vouchers leave the queue, a refused one stays', async () => {
    const chart = await ok<{
      accounts: { id: string; isGroup: boolean; systemKey: string | null }[];
    }>(get('/tenant/accounts/chart', manager));
    const leaf = chart.accounts.filter((a) => !a.isGroup);
    const company = (await ok<{ companies: { id: string }[] }>(get('/tenant/companies')))
      .companies[0]!.id;
    for (const [n, amount] of [
      ['Cement for the hostel', '1000'],
      ['Steel for the hostel', '2000'],
    ] as const)
      await ok(
        post('/tenant/accounts/vouchers', {
          entityId: company,
          type: 'journal',
          date: '2026-10-01',
          narration: n,
          lines: [
            { accountId: leaf[0]!.id, debit: amount, credit: '0' },
            { accountId: leaf[1]!.id, debit: '0', credit: amount },
          ],
        }),
      );
    await ok(req('PUT', '/tenant/accounts/mode', t.admin, { mode: 'native_tally' }));
    const key = (
      await ok<{ key: string }>(
        post('/tenant/integrations/api-keys', { name: 'Tally', scopes: ['tally'] }),
      )
    ).key;
    // The agent talks to the app through inject, and to a fake Tally that refuses the steel voucher.
    const fetchImpl = async (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      if (url.startsWith('tally:')) {
        const steel = (init!.body ?? '').includes('Steel for the hostel');
        const reply = steel
          ? '<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Voucher totals do not match!</LINEERROR></RESPONSE>'
          : '<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>';
        return new Response(reply);
      }
      const u = new URL(url);
      const res = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url: u.pathname + u.search,
        headers: init?.headers ?? {},
        ...(init?.body ? { payload: init.body } : {}),
      });
      return new Response(res.body, { status: res.statusCode });
    };
    const first = (await syncOnce({
      server: 'http://app',
      key,
      entityId: company,
      tally: 'tally:9000',
      fetchImpl,
      log: () => {},
    })) as {
      ok: boolean;
      response: string;
    }[];
    expect(first.map((r) => r.ok)).toEqual([true, false]);
    const pending = await ok<{
      vouchers: { number: string; lastError: string | null; xml: string }[];
    }>(get(`/v1/tally/pending?entityId=${company}`, { authorization: `Bearer ${key}` }));
    expect(pending.vouchers).toHaveLength(1);
    expect(pending.vouchers[0]!.lastError).toBe('Voucher totals do not match!');
    expect(pending.vouchers[0]!.xml).toContain('<VOUCHER VCHTYPE="Journal" ACTION="Create">');
    const status = await ok<{ created: number; failed: number }>(
      get(`/tenant/integrations/tally-sync?entityId=${company}`, manager),
    );
    expect([status.created, status.failed]).toEqual([1, 1]);
  });
});
