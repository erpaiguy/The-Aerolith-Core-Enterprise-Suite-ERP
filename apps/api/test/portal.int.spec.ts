// Portals in a real tenant database (docs/wave6-plan.md step 5): the fair-use cap per kind raised by the operator;
// an invitation accepted and signed in; lockout after five wrong passwords; a portal token refused on staff routes
// and a staff token on portal routes; one vendor never seeing another's enquiry or order; a quote submitted, accepted
// into the RFQ as the vendor's quote; an order acknowledged; a subcontractor's measurement accepted into the book; an
// invoice file sent and fetched by staff; a client seeing only their own project and transmittal; a deactivated
// user's session ended at once.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { capCheck, partyFits } from '../src/portal/portal-rules.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);
type H = Record<string, string>;

describe('portal rules', () => {
  it('fits the party to its portal and caps each kind', () => {
    const vendor = { is_vendor: true, is_subcontractor: false, is_client: false };
    expect(partyFits(vendor, 'vendor')).toBe(true);
    expect(partyFits(vendor, 'client')).toBe(false);
    expect(capCheck(49, 50)).toEqual({ ok: true });
    expect(capCheck(50, 50)).toEqual({ ok: false, reason: 'portal_cap_reached' });
  });
});

describe.skipIf(!controlUrl || !adminUrl)('portals (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: H;

  const req = (method: 'GET' | 'POST', url: string, headers: H, payload?: object) =>
    app.inject({ method, url: `/api${url}`, headers, ...(payload ? { payload } : {}) });
  const post = (url: string, payload: object = {}, headers: H = t.admin) =>
    req('POST', url, headers, payload);
  const get = (url: string, headers: H = t.admin) => req('GET', url, headers);
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };

  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ id: string; temporaryPassword: string }>();
    const login = (password: string) =>
      post(
        '/auth/login',
        { entitlementToken: t.entitlement, identifier: username, password, client: 'desktop' },
        {},
      ).then((r) => r.json<{ accessToken: string }>().accessToken);
    const first = await login(created.temporaryPassword);
    await post(
      '/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: 'Bar-Bending-Yard-44' },
      { authorization: `Bearer ${first}` },
    );
    return {
      id: created.id,
      headers: { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` },
    };
  }

  const party = async (name: string, roles: object) =>
    (await ok<{ id: string }>(post('/tenant/parties', { name, isClient: false, ...roles }))).id;

  /** Invited by the manager, accepted with a password; returns the portal headers. */
  async function portalUser(partyId: string, kind: string, email: string) {
    const inv = await ok<{ id: string; token: string }>(
      post('/tenant/portal-users', { partyId, kind, email, name: email.split('@')[0] }, manager),
    );
    const res = await post(
      '/portal/auth/accept',
      { tenant: t.tenantId, token: inv.token, password: 'Portal-Pass-2026' },
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('aerolith_prt=');
    expect(String(res.headers['set-cookie'])).toContain('Path=/api/portal/auth');
    return {
      id: inv.id,
      headers: { authorization: `Bearer ${res.json<{ accessToken: string }>().accessToken}` },
      cookie: String(res.headers['set-cookie']).split(';')[0]!,
    };
  }

  beforeAll(async () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-portal-test-')),
      DOCUMENT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-portal-files-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'portal-admin@example.in');
    manager = (await staff('suresh', 'manager')).headers;
    db = await app.get(TenantConnections).forTenant(t.tenantId);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  let shinde: string;
  let patil: string;
  let vendorA: Awaited<ReturnType<typeof portalUser>>;
  let vendorB: Awaited<ReturnType<typeof portalUser>>;

  it('invites within the fair-use cap, raised by the operator; portal users are not seats', async () => {
    shinde = await party('Shinde Steel Traders', { isVendor: true });
    patil = await party('Patil Cement Agency', { isVendor: true });
    // The cap is lowered to 1 to prove it; the operator raises it again.
    await control`UPDATE core.licence SET portal_cap = 1 WHERE id = ${t.licenceId}`;
    vendorA = await portalUser(shinde, 'vendor', 'sales@shinde-steel.in');
    const over = await post(
      '/tenant/portal-users',
      { partyId: patil, kind: 'vendor', email: 'office@patil-cement.in', name: 'Patil' },
      manager,
    );
    expect(over.statusCode).toBe(409);
    expect(over.json<{ code: string }>().code).toBe('portal_cap_reached');
    // Not a client, so not on the client portal; the same email twice is refused.
    expect(
      (
        await post(
          '/tenant/portal-users',
          { partyId: patil, kind: 'client', email: 'x@patil-cement.in', name: 'Patil' },
          manager,
        )
      ).json<{ code: string }>().code,
    ).toBe('party_not_that_kind');
    const op = await import('../src/licensing/licensing.service.js');
    await app
      .get(op.LicensingService)
      .changePortalCap(t.licenceId, 50, 'More vendors', 'operator:test');
    const [ev] = await control<{ kind: string; data: { from: number; to: number } }[]>`
      SELECT kind, data FROM core.licence_event WHERE licence_id = ${t.licenceId} AND kind = 'portal_cap_changed'`;
    expect(ev?.data).toMatchObject({ from: 1, to: 50 });
    vendorB = await portalUser(patil, 'vendor', 'office@patil-cement.in');
    const list = await ok<{
      cap: number;
      inUse: Record<string, number>;
      users: { status: string }[];
    }>(get('/tenant/portal-users', manager));
    expect([list.cap, list.inUse.vendor, list.users.map((u) => u.status)]).toEqual([
      50,
      2,
      ['active', 'active'],
    ]);
    // Seats: only the admin and the manager.
    const [{ n }] =
      (await db`SELECT count(*)::int AS n FROM platform."user" WHERE status = 'active'`) as unknown as [
        { n: number },
      ];
    expect(n).toBe(2);
  });

  it('signs in, locks after five wrong passwords, and keeps staff and portal routes apart', async () => {
    const login = (password: string) =>
      post(
        '/portal/auth/login',
        { tenant: t.tenantId, email: 'SALES@shinde-steel.in', password },
        {},
      );
    expect((await login('Portal-Pass-2026')).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await login('wrong-password-1')).statusCode).toBe(401);
    expect((await login('Portal-Pass-2026')).statusCode).toBe(401);
    await db`UPDATE portal."user" SET locked_until = NULL, failed_logins = 0`;

    // A portal token on a staff route, and a staff token on a portal route.
    expect((await get('/tenant/projects', vendorA.headers)).statusCode).toBe(401);
    expect((await get('/portal/enquiries', manager)).statusCode).toBe(401);
    // Refresh with the cookie and the client header.
    const r = await req(
      'POST',
      '/portal/auth/refresh',
      { cookie: vendorA.cookie, 'x-aerolith-client': 'browser' },
      {
        tenant: t.tenantId,
      },
    );
    expect(r.statusCode).toBe(200);
    vendorA.cookie = String(r.headers['set-cookie']).split(';')[0]!;
  });

  let rfqId: string;
  let lines: { id: string }[];

  it('shows a vendor only their own enquiry; a quote counts once staff accept it', async () => {
    const tenderId = (
      await ok<{ id: string }>(post('/tenant/tenders', { title: 'Hostel, Washim' }))
    ).id;
    const rfq = await ok<{ id: string }>(
      post(`/tenant/tenders/${tenderId}/rfqs`, {
        title: 'Steel supply',
        kind: 'material',
        dueOn: '2099-12-31',
      }),
    );
    rfqId = rfq.id;
    await ok(
      post(`/tenant/rfqs/${rfqId}/lines`, { free: { description: 'TMT bars Fe 500D', unit: 't' } }),
    );
    await ok(
      post(`/tenant/rfqs/${rfqId}/lines`, { free: { description: 'Binding wire', unit: 'kg' } }),
    );
    await ok(post(`/tenant/rfqs/${rfqId}/vendors`, { partyId: shinde }));
    await ok(post(`/tenant/rfqs/${rfqId}/vendors/${shinde}`, { status: 'sent' }));

    const mine = await ok<{ id: string; number: string }[]>(
      get('/portal/enquiries', vendorA.headers),
    );
    expect(mine.map((e) => e.id)).toEqual([rfqId]);
    expect(await ok<unknown[]>(get('/portal/enquiries', vendorB.headers))).toEqual([]);
    expect((await get(`/portal/enquiries/${rfqId}`, vendorB.headers)).statusCode).toBe(404);

    const e = await ok<{ lines: { id: string; description: string }[] }>(
      get(`/portal/enquiries/${rfqId}`, vendorA.headers),
    );
    lines = e.lines;
    const sent = await ok<{ id: string; number: string; status: string }>(
      post(
        `/portal/enquiries/${rfqId}/quote`,
        {
          reference: 'SST/Q/77',
          gstPct: '18',
          lines: [
            { lineId: lines[0]!.id, rate: '61500' },
            { lineId: lines[1]!.id, rate: '78.50' },
          ],
        },
        vendorA.headers,
      ),
    );
    expect(sent.number).toMatch(/^PS-\d{6}$/);
    expect(sent.status).toBe('submitted');
    // Nothing in the RFQ until accepted.
    const [none] =
      (await db`SELECT count(*)::int AS n FROM tender.rfq_quote WHERE rfq_id = ${rfqId}`) as unknown as [
        { n: number },
      ];
    expect(none.n).toBe(0);
    const waiting = await ok<{ id: string; party: string }[]>(
      get('/tenant/portal-submissions', manager),
    );
    expect(waiting.map((w) => w.party)).toEqual(['Shinde Steel Traders']);
    const accepted = await ok<{ status: string }>(
      post(`/tenant/portal-submissions/${sent.id}/accept`, {}, manager),
    );
    expect(accepted.status).toBe('accepted');
    expect(
      (await post(`/tenant/portal-submissions/${sent.id}/accept`, {}, manager)).statusCode,
    ).toBe(409);
    const rates = await db<{ rate: string; reference: string }[]>`
      SELECT ql.rate::text AS rate, q.reference FROM tender.rfq_quote q
      JOIN tender.rfq_quote_line ql ON ql.quote_id = q.id WHERE q.rfq_id = ${rfqId} AND q.party_id = ${shinde}
      ORDER BY ql.rate DESC`;
    expect(rates.map((r) => [r.rate, r.reference])).toEqual([
      ['61500.0000', 'SST/Q/77'],
      ['78.5000', 'SST/Q/77'],
    ]);
    // The vendor sees the outcome.
    expect(
      (await ok<{ status: string }[]>(get('/portal/submissions', vendorA.headers))).map(
        (s) => s.status,
      ),
    ).toEqual(['accepted']);
  });

  let woId: string;
  let lineKey: string;
  let sub: Awaited<ReturnType<typeof portalUser>>;
  let projectId: string;
  let client: string;

  it("acknowledges a work order and has the subcontractor's measurement accepted into the book", async () => {
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
    client = await party('Zilla Parishad Washim', { isClient: true });
    projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'School, Washim', clientId: client }, manager),
      )
    ).id;
    const site = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    const kale = await party('Kale Constructions', {
      isVendor: true,
      isSubcontractor: true,
      gstin: '27ABCPK1234L1Z5',
      pan: 'ABCPK1234L',
    });
    const o = await ok<{ open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'work',
          partyId: kale,
          siteId: site,
          lines: [
            {
              description: 'Brickwork 230 mm',
              unit: 'cum',
              qty: '100',
              rate: '4500',
              gstPct: '18',
            },
          ],
        },
        manager,
      ),
    );
    const issued = await ok<{ id: string; inForce: { lines: { lineKey: string }[] } }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    woId = issued.id;
    lineKey = issued.inForce.lines[0]!.lineKey;
    sub = await portalUser(kale, 'subcontractor', 'site@kale.in');

    // Work orders only on the subcontractor portal; vendor A sees none of it.
    expect(
      (await ok<{ id: string }[]>(get('/portal/orders', sub.headers))).map((x) => x.id),
    ).toEqual([woId]);
    expect((await get(`/portal/orders/${woId}`, vendorA.headers)).statusCode).toBe(404);
    const ack = await ok<{ status: string; acknowledgedRef: string }>(
      post(`/portal/orders/${woId}/acknowledge`, { reference: 'Signed copy' }, sub.headers),
    );
    expect([ack.status, ack.acknowledgedRef]).toEqual([
      'acknowledged',
      'Portal: site, Signed copy',
    ]);

    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const m = await ok<{ id: string }>(
      post(
        `/portal/orders/${woId}/measurements`,
        { measuredOn: today, lines: [{ lineKey, qty: '12.5', description: 'Ground floor walls' }] },
        sub.headers,
      ),
    );
    // A vendor cannot measure.
    expect(
      (
        await post(
          `/portal/orders/${woId}/measurements`,
          { measuredOn: today, lines: [{ lineKey, qty: '1' }] },
          vendorA.headers,
        )
      ).statusCode,
    ).toBe(403);
    await ok(post(`/tenant/portal-submissions/${m.id}/accept`, {}, manager));
    const book = await db<
      { qty: string }[]
    >`SELECT qty::text AS qty FROM acc.wo_measurement WHERE order_id = ${woId}`;
    expect(book.map((b) => b.qty)).toEqual(['12.5000']);
    const order = await ok<{ lines: { measured: string }[] }>(
      get(`/portal/orders/${woId}`, sub.headers),
    );
    expect(order.lines[0]!.measured).toBe('12.5000');

    // An invoice file: refused unless a PDF or photo; kept for the accounts team; rejection with a reason.
    const send = (bytes: Buffer, name: string) => {
      const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
      return app.inject({
        method: 'POST',
        url: `/api/portal/orders/${woId}/invoices?invoiceNo=KC%2F12&invoiceDate=${today}&amount=56250`,
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
              'Content-Type: application/octet-stream\r\n\r\n',
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        headers: { ...sub.headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
    };
    expect(
      (await send(Buffer.from('MZ not an invoice'), 'bill.exe')).json<{ code: string }>().code,
    ).toBe('not_an_invoice_file');
    const pdf = Buffer.from('%PDF-1.4\n% invoice KC/12\n%%EOF\n');
    const inv = await send(pdf, 'KC-12.pdf');
    expect(inv.statusCode).toBe(201);
    const invId = inv.json<{ id: string }>().id;
    const file = await get(`/tenant/portal-submissions/${invId}/file`, manager);
    expect(file.rawPayload.equals(pdf)).toBe(true);
    const rej = await ok<{ status: string; reason: string }>(
      post(
        `/tenant/portal-submissions/${invId}/reject`,
        { reason: 'GSTIN missing on the invoice' },
        manager,
      ),
    );
    expect([rej.status, rej.reason]).toEqual(['rejected', 'GSTIN missing on the invoice']);
  });

  it('shows a client only their own projects and transmittals', async () => {
    const zp = await portalUser(client, 'client', 'ee@zp-washim.in');
    const projects = await ok<{ id: string; name: string }[]>(get('/portal/projects', zp.headers));
    expect(projects.map((p) => p.name)).toEqual(['School, Washim']);
    expect((await get('/portal/enquiries', zp.headers)).statusCode).toBe(403);
    expect((await get(`/portal/projects/${projectId}`, vendorA.headers)).statusCode).toBe(403);

    const [admin] = await db<
      { id: string }[]
    >`SELECT id FROM platform."user" WHERE role = 'admin' LIMIT 1`;
    const [tr] = await db<{ id: string }[]>`
      INSERT INTO dms.transmittal (project_id, number, subject, party_id, recipient, purpose, status, issued_on,
        created_by, issued_by)
      VALUES (${projectId}, 'TR-001', 'Structural drawings for information', ${client}, 'Executive Engineer',
        'information', 'issued', (now() AT TIME ZONE 'Asia/Kolkata')::date, ${admin!.id}, ${admin!.id})
      RETURNING id`;
    const list = await ok<{ id: string; number: string }[]>(
      get('/portal/transmittals', zp.headers),
    );
    expect(list.map((x) => x.number)).toEqual(['TR-001']);
    const acked = await ok<{ status: string; acknowledgedBy: string }>(
      post(`/portal/transmittals/${tr!.id}/acknowledge`, {}, zp.headers),
    );
    expect([acked.status, acked.acknowledgedBy]).toEqual(['acknowledged', 'ee (portal)']);
  });

  it("ends a deactivated user's session at once", async () => {
    expect((await get('/portal/enquiries', vendorB.headers)).statusCode).toBe(200);
    await ok(post(`/tenant/portal-users/${vendorB.id}/deactivate`, {}, manager));
    expect((await get('/portal/enquiries', vendorB.headers)).statusCode).toBe(401);
    expect(
      (
        await post(
          '/portal/auth/login',
          { tenant: t.tenantId, email: 'office@patil-cement.in', password: 'Portal-Pass-2026' },
          {},
        )
      ).statusCode,
    ).toBe(401);
    // A worker cannot invite.
    const w = await staff('raju', 'worker');
    expect(
      (
        await post(
          '/tenant/portal-users',
          { partyId: patil, kind: 'vendor', email: 'a@b.in', name: 'Ab' },
          w.headers,
        )
      ).statusCode,
    ).toBe(403);
  });
});
