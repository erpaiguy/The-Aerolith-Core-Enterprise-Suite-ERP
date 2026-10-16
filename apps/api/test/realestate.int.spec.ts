// Real estate sales and RERA (docs/wave6-plan.md step 2) in a real tenant database, figures worked by hand: a unit of
// ₹83,10,000 on a 10/20/30/40 plan; booked, its plinth demand held by RERA §13 until the agreement; receipts allocated
// and their 70% due to the designated account; delay interest; deposits and withdrawals against certified completion;
// the buyer's ledger in the books and the quarterly update.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('real estate sales and RERA (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-re-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 're-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('sells a flat on a payment plan and keeps the RERA account', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    await ok(
      post(`/tenant/companies/${company.id}`, {
        name: 'Pune Homes Pvt Ltd',
        gstin: '27AAACP1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const chart = await ok<{ accounts: { id: string; code: string; systemKey: string | null }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const bankGroup = chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id;
    const bank = async (code: string, name: string) =>
      (
        await ok<{ accounts: { id: string; code: string }[] }>(
          post('/tenant/accounts/chart', { parentId: bankGroup, code, name, kind: 'bank' }),
        )
      ).accounts.find((a) => a.code === code)!.id;
    const collection = await bank('A4002', 'HDFC Collection');
    const designated = await bank('A4003', 'HDFC RERA Designated');
    const operating = await bank('A4004', 'SBI Operating');
    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Shanti Heights, Baner' }, manager))
    ).id;

    const base = `/tenant/projects/${projectId}/sales`;
    expect((await post(`${base}/towers`, { name: 'A', floors: 12 }, worker)).statusCode).toBe(403);
    await ok(
      post(
        `${base}/setup`,
        {
          reraNumber: 'P52100012345',
          collectionAccountId: collection,
          designatedAccountId: designated,
        },
        manager,
      ),
    );
    type O = {
      towers: { id: string; name: string }[];
      units: { id: string; number: string; status: string; value: string }[];
      plan: { id: string; name: string }[];
    };
    let o = await ok<O>(post(`${base}/towers`, { name: 'A', floors: 12 }, manager));
    const towerA = o.towers[0]!.id;
    o = await ok<O>(
      post(
        `/tenant/sales/towers/${towerA}/units`,
        {
          units: [
            {
              floor: 12,
              number: '1201',
              carpetSqm: '65.5',
              ratePerSqm: '120000',
              parking: '300000',
              charges: '150000',
            },
            { floor: 12, number: '1202', carpetSqm: '50', ratePerSqm: '120000' },
          ],
        },
        manager,
      ),
    );
    expect(o.units.map((u) => [u.number, u.value])).toEqual([
      ['1201', '8310000.00'],
      ['1202', '6000000.00'],
    ]);
    expect(
      (
        await post(
          `${base}/plan`,
          { stages: [{ name: 'Booking', pct: '10', trigger: 'booking' }] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_100' });
    o = await ok<O>(
      post(
        `${base}/plan`,
        {
          stages: [
            { name: 'On booking', pct: '10', trigger: 'booking' },
            { name: 'On agreement', pct: '20', trigger: 'agreement' },
            { name: 'Plinth', pct: '30', trigger: 'milestone', towerId: towerA },
            { name: 'Possession', pct: '40', trigger: 'milestone' },
          ],
        },
        manager,
      ),
    );
    const stage = (n: string) => o.plan.find((s) => s.name === n)!.id;
    const u1201 = o.units.find((u) => u.number === '1201')!.id;

    // Booked on 1 September: 10% demanded at once (₹8,31,000 + 5% GST = ₹8,72,550).
    type B = {
      id: string;
      number: string;
      status: string;
      demands: {
        number: string;
        stage: string | null;
        base: string;
        cgst: string;
        total: string;
        open: string;
        dueOn: string;
      }[];
      receipts: { number: string; gstPart: string; reraShare: string }[];
      totals: { demanded: string; received: string; outstanding: string };
    };
    let b = await ok<B>(
      post(
        `/tenant/sales/units/${u1201}/book`,
        {
          buyer: { name: 'Anil Kulkarni', phone: '9822012345', pan: 'ABCPK1234F' },
          bookedOn: '2026-09-01',
        },
        manager,
      ),
    );
    expect(b.demands.map((d) => [d.number, d.stage, d.base, d.cgst, d.total, d.dueOn])).toEqual([
      ['DM-001', 'On booking', '831000.00', '20775.00', '872550.00', '2026-09-16'],
    ]);
    expect(
      (
        await post(
          `/tenant/sales/units/${u1201}/book`,
          { buyer: { name: 'X Y' }, bookedOn: '2026-09-02' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_available' });
    // The plinth is reached on 10 September; 30% more would pass 10% before the agreement, so it is held.
    const reached = await ok<{ raised: number }>(
      post(`/tenant/sales/stages/${stage('Plinth')}/reached`, { on: '2026-09-10' }, manager),
    );
    expect(reached.raised).toBe(0);
    // The first receipt, on time.
    b = await ok<B>(
      post(
        `/tenant/sales/bookings/${b.id}/receipts`,
        { on: '2026-09-05', amount: '872550', reference: 'UTR1' },
        manager,
      ),
    );
    expect(b.receipts[0]).toMatchObject({ gstPart: '41550.00', reraShare: '581700.00' });
    // The agreement on 15 September: agreement and plinth demands raised that day, due on the 30th.
    b = await ok<B>(
      post(
        `/tenant/sales/bookings/${b.id}/agreement`,
        { on: '2026-09-15', number: 'HVL-1-4567-2026' },
        manager,
      ),
    );
    expect(b.demands.map((d) => [d.number, d.stage, d.total, d.dueOn])).toEqual([
      ['DM-001', 'On booking', '872550.00', '2026-09-16'],
      ['DM-002', 'On agreement', '1745100.00', '2026-09-30'],
      ['DM-003', 'Plinth', '2617650.00', '2026-09-30'],
    ]);
    // Paid the agreement's demand ten days late.
    b = await ok<B>(
      post(
        `/tenant/sales/bookings/${b.id}/receipts`,
        { on: '2026-10-10', amount: '1745100', reference: 'UTR2' },
        manager,
      ),
    );
    expect(b.receipts[1]).toMatchObject({ gstPart: '83100.00', reraShare: '1163400.00' });
    expect(b.demands.map((d) => d.open)).toEqual(['0.00', '0.00', '2617650.00']);
    // Interest to 10 October at 10.75%: ₹17,45,100 × 10 days = ₹5,139.68; ₹26,17,650 unpaid 10 days = ₹7,709.52.
    b = await ok<B>(post(`/tenant/sales/bookings/${b.id}/interest`, { on: '2026-10-10' }, manager));
    expect(b.demands.at(-1)).toMatchObject({
      number: 'DM-004',
      stage: null,
      base: '12849.20',
      total: '12849.20',
    });
    expect(
      (await post(`/tenant/sales/bookings/${b.id}/interest`, { on: '2026-10-10' }, manager)).json(),
    ).toMatchObject({
      code: 'no_interest',
    });

    // The buyer's ledger: ₹52,48,149.20 demanded less ₹26,17,650 received.
    const [ledger] = await db<{ balance: string }[]>`
      SELECT sum(l.debit - l.credit)::text AS balance FROM acc.voucher_line l JOIN acc.account a ON a.id = l.account_id
      JOIN re.booking k ON k.party_id = a.party_id WHERE k.id = ${b.id}`;
    expect(ledger!.balance).toBe('2630499.20');
    const [advances] = await db<{ balance: string }[]>`
      SELECT sum(l.credit - l.debit)::text AS balance FROM acc.voucher_line l JOIN acc.account a ON a.id = l.account_id
      WHERE a.system_key = 'advances_from_buyers'`;
    expect(advances!.balance).toBe('4986000.00');

    // RERA: ₹17,45,100 due to the designated account; deposited; withdrawals limited by certified completion.
    type R = {
      required: string;
      deposited: string;
      shortfall: string;
      withdrawn: string;
      balance: string;
    };
    let r = await ok<R>(get(`${base}/rera`, manager));
    expect([r.required, r.shortfall]).toEqual(['1745100.00', '1745100.00']);
    r = await ok<R>(
      post(`${base}/rera`, { kind: 'deposit', on: '2026-10-10', amount: '1745100' }, manager),
    );
    expect([r.deposited, r.shortfall]).toEqual(['1745100.00', '0.00']);
    const out = {
      kind: 'withdrawal',
      on: '2026-10-12',
      toAccountId: operating,
      completionPct: '20',
    };
    expect(
      (await post(`${base}/rera`, { ...out, amount: '100000' }, manager)).json(),
    ).toMatchObject({
      code: 'certificates',
    });
    const certs = { engineerRef: 'F1/2026/07', architectRef: 'F2/2026/07', caRef: 'F3/2026/07' };
    expect(
      (await post(`${base}/rera`, { ...out, ...certs, amount: '400000' }, manager)).json(),
    ).toMatchObject({
      code: 'over_limit',
      message: 'At 20% completion ₹349020.00 more may be withdrawn.',
    });
    r = await ok<R>(post(`${base}/rera`, { ...out, ...certs, amount: '300000' }, manager));
    expect([r.withdrawn, r.balance]).toEqual(['300000.00', '1445100.00']);

    // A second unit booked and cancelled frees it.
    const u1202 = o.units.find((u) => u.number === '1202')!.id;
    const b2 = await ok<B>(
      post(
        `/tenant/sales/units/${u1202}/book`,
        { buyer: { name: 'Anil Kulkarni' }, bookedOn: '2026-10-01' },
        manager,
      ),
    );
    await ok(post(`/tenant/sales/bookings/${b2.id}/cancel`, { on: '2026-10-02' }, manager));
    o = await ok<O>(get(base, manager));
    expect(o.units.find((u) => u.number === '1202')!.status).toBe('available');
    // Buyers stay out of client lists.
    expect(
      (await ok<{ name: string }[]>(get('/tenant/parties?kind=client', manager))).some((x) =>
        x.name.includes('Kulkarni'),
      ),
    ).toBe(false);

    // The quarterly update to 30 September.
    const q = await ok<{
      towers: { tower: string; bookedInQuarter: number; milestonesReached: string[] }[];
      collectedInQuarter: string;
      depositedInQuarter: string;
    }>(get(`${base}/quarter?upto=2026-09-30`, manager));
    expect(q.towers).toEqual([
      expect.objectContaining({ tower: 'A', bookedInQuarter: 1, milestonesReached: ['Plinth'] }),
    ]);
    expect([q.collectedInQuarter, q.depositedInQuarter]).toEqual(['872550.00', '0.00']);
    const x = await get(`${base}/quarter?upto=2026-09-30&format=xlsx`, manager);
    expect(x.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    expect(String(wb.worksheets[0]!.getCell(2, 1).value)).toContain('P52100012345');

    // docs/wave8-plan.md step 8b.5: the plinth demand paid less the buyer's 1% TDS under 194-IA; the cash and the TDS
    // together settle it, and 26AS shows the TDS under the buyer's PAN.
    const pay = { on: '2026-10-14', amount: '2591473.50', tds: '26176.50', reference: 'UTR3' };
    expect(
      (await post(`/tenant/sales/bookings/${b.id}/receipts`, pay, manager)).json(),
    ).toMatchObject({ code: 'ack_needed' });
    const paid = await ok<B & { totals: { tdsByBuyer: string } }>(
      post(`/tenant/sales/bookings/${b.id}/receipts`, { ...pay, tdsAck: 'AB1234567' }, manager),
    );
    expect(paid.demands.find((d) => d.number === 'DM-003')!.open).toBe('0.00');
    expect(paid.totals.tdsByBuyer).toBe('26176.50');
    const [up] = await db<{ id: string }[]>`
      INSERT INTO acc.tds_credit_upload (entity_id, quarter, file_name) VALUES (${company.id}, '2026-27-Q3', '26as.xlsx')
      RETURNING id`;
    await db`INSERT INTO acc.tds_credit_line (upload_id, position, tan, deductor, amount, tds)
      VALUES (${up!.id}, 1, 'ABCPK1234F', 'ANIL KULKARNI', 2617650, 26176.50)`;
    const m = await ok<{ rows: { status: string; party: string; books: string | null }[] }>(
      get(`/tenant/accounts/tds/credits?entityId=${company.id}&quarter=2026-27-Q3`, manager),
    );
    expect(m.rows.map((x) => [x.status, x.party, x.books])).toEqual([
      ['matched', 'Anil Kulkarni', '26176.50'],
    ]);
  });
});
