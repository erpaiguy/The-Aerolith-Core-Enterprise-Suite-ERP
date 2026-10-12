// Fixed assets in a real tenant database (docs/wave3-plan.md step 9), every figure by hand: an excavator capitalised
// from a supplier's bill and a car brought in with the opening balances; a year's depreciation (straight line split by
// a transfer between projects, WDV on the opening book value) posted, reversed and run again; the Income Tax blocks;
// the car sold at a gain and the excavator at a loss.
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
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('fixed assets (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-fa-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'fa-admin@example.in');
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

  let entityId: string;
  let bank: string;
  let p1: string;
  let p2: string;
  let excavator: string;
  let car: string;
  interface Asset {
    id: string;
    number: string;
    bookValue: string;
    depreciation: string;
    status: string;
  }

  it('registers assets from a bill and the opening balances, and moves one', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Wardha Earthmovers Pvt Ltd',
        gstin: '27AAACW5678K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const chart = await ok<{ accounts: { id: string; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const code = (c: string) => chart.accounts.find((a) => a.code === c)!.id;
    bank = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: code('A40'),
          code: 'A4002',
          name: 'SBI Current',
          kind: 'bank',
        }),
      )
    ).accounts.find((a) => a.code === 'A4002')!.id;
    p1 = (await ok<{ id: string }>(post('/tenant/projects', { name: 'Highway, Wardha' }, manager)))
      .id;
    p2 = (await ok<{ id: string }>(post('/tenant/projects', { name: 'Canal, Arvi' }, manager))).id;
    const dealer = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Nagpur Earthmovers',
          isClient: false,
          isVendor: true,
          gstin: '27AAACN9876E1Z1',
        }),
      )
    ).id;
    // The excavator's bill: ₹12,00,000 + 18% to the plant and machinery ledger.
    const bill = await ok<{ id: string }>(
      post(
        '/tenant/accounts/vendor-bills',
        {
          entityId,
          partyId: dealer,
          orderId: null,
          projectId: null,
          tdsSection: null,
          billNo: 'NE/451',
          billDate: '2026-06-01',
          dueDate: '2026-07-01',
          lines: [
            {
              accountId: code('A1001'),
              description: 'Excavator 20 t',
              qty: '1',
              rate: '1200000',
              gstPct: '18',
            },
          ],
        },
        manager,
      ),
    );
    const classes = await ok<{ id: string; name: string }[]>(
      get('/tenant/accounts/asset-classes', manager),
    );
    const cls = (n: string) => classes.find((c) => c.name === n)!.id;
    const register = (body: object, as: Record<string, string> = manager) =>
      post('/tenant/accounts/assets', { entityId, ...body }, as);
    const exc = {
      name: 'Excavator 20 t',
      classId: cls('Construction equipment'),
      source: 'bill',
      vendorBillId: bill.id,
      purchasedOn: '2026-06-01',
      putToUseOn: '2026-07-01',
      projectId: p1,
    };
    expect((await register({ ...exc, cost: '1200000' }, worker)).statusCode).toBe(403);
    expect((await register({ ...exc, cost: '1200001' })).json()).toMatchObject({
      code: 'over_bill',
    });
    const a = await ok<Asset>(register({ ...exc, cost: '1200000' }));
    excavator = a.id;
    expect([a.number, a.bookValue]).toEqual(['FA/2026-27/0001', '1200000.00']);
    // The car came with the books: ₹10,00,000 less ₹2,00,000 depreciated; tax value ₹6,00,000.
    car = (
      await ok<Asset>(
        register({
          name: 'Site jeep',
          classId: cls('Motor vehicles'),
          source: 'opening',
          purchasedOn: '2024-04-01',
          putToUseOn: '2024-04-01',
          cost: '1000000',
          openingDepreciation: '200000',
          itOpeningWdv: '600000',
          projectId: p1,
        }),
      )
    ).id;
    // The excavator moves to the canal on 1 January.
    await ok(
      post(
        `/tenant/accounts/assets/${excavator}/transfer`,
        { date: '2027-01-01', projectId: p2 },
        manager,
      ),
    );
  });

  it('runs a year of depreciation, reverses it and runs it again; the tax blocks', async () => {
    // Excavator: (12,00,000 − 60,000) ÷ 12 = 95,000 a year; 184 days at the highway (47,890.41), 90 at the canal
    // (23,424.66). Jeep: 8,00,000 × 31.23% = 2,49,840. Together ₹3,21,155.07.
    const run = () =>
      post('/tenant/accounts/depreciation-runs', { entityId, upto: '2027-03-31' }, manager);
    const r = await ok<{ id: string; total: string; voucher: string }>(run());
    expect([r.total, r.voucher]).toEqual(['321155.07', 'JV/2026-27/0001']);
    const v = await ok<{
      lines: {
        account: { name: string };
        project: { name: string } | null;
        debit: string;
        credit: string;
      }[];
    }>(
      get(
        `/tenant/accounts/vouchers/${(await ok<{ vouchers: { id: string; number: string }[] }>(get(`/tenant/accounts/vouchers?entityId=${entityId}`, manager))).vouchers.find((x) => x.number === 'JV/2026-27/0001')!.id}`,
        manager,
      ),
    );
    expect(
      v.lines.map((l) => [l.account.name, l.project?.name ?? null, l.debit, l.credit]),
    ).toEqual([
      ['Depreciation', 'Highway, Wardha', '297730.41', '0.00'],
      ['Depreciation', 'Canal, Arvi', '23424.66', '0.00'],
      ['Vehicles', null, '0.00', '249840.00'],
      ['Plant and machinery', null, '0.00', '71315.07'],
    ]);
    expect((await run()).json()).toMatchObject({ code: 'nothing_to_charge' });
    // Reversed: the assets fall back; run again, the same.
    await ok(
      post(
        `/tenant/accounts/depreciation-runs/${r.id}/reverse`,
        { date: '2027-03-31', reason: 'Wrong class' },
        manager,
      ),
    );
    expect((await ok<Asset>(get(`/tenant/accounts/assets/${excavator}`, manager))).bookValue).toBe(
      '1200000.00',
    );
    expect((await ok<{ total: string }>(run())).total).toBe('321155.07');
    expect((await ok<Asset>(get(`/tenant/accounts/assets/${excavator}`, manager))).bookValue).toBe(
      '1128684.93',
    );

    // Tax: the excavator used 274 days (full 15%: 1,80,000); the jeep's block from ₹6,00,000 (90,000).
    const tax = await ok<{
      blocks: {
        block: string;
        opening: string;
        additionsFull: string;
        depreciation: string;
        closing: string;
      }[];
    }>(get(`/tenant/accounts/assets/tax-depreciation?entityId=${entityId}&fy=2026-27`, manager));
    expect(
      tax.blocks.map((b) => [b.block, b.opening, b.additionsFull, b.depreciation, b.closing]),
    ).toEqual([
      ['Construction equipment 15.00%', '0.00', '1200000.00', '180000.00', '1020000.00'],
      ['Motor vehicles 15.00%', '600000.00', '0.00', '90000.00', '510000.00'],
    ]);
  });

  it('sells the jeep at a gain and the excavator at a loss', async () => {
    // Jeep: book 5,50,160, sold for 5,60,000: a gain of 9,840.
    const sell = (id: string, proceeds: string) =>
      ok<Asset & { disposedOn: string }>(
        post(
          `/tenant/accounts/assets/${id}/dispose`,
          { date: '2027-04-01', proceeds, bankAccountId: bank },
          manager,
        ),
      );
    const jeep = await sell(car, '560000');
    expect([jeep.status, jeep.bookValue]).toEqual(['disposed', '550160.00']);
    // Excavator: book 11,28,684.93, sold for 9,00,000: a loss of 2,28,684.93.
    await sell(excavator, '900000');
    const list = await ok<{ vouchers: { id: string; number: string; type: string }[] }>(
      get(`/tenant/accounts/vouchers?entityId=${entityId}&from=2027-04-01&to=2027-04-01`, manager),
    );
    const lines = async (id: string) =>
      (
        await ok<{ lines: { account: { name: string }; debit: string; credit: string }[] }>(
          get(`/tenant/accounts/vouchers/${id}`, manager),
        )
      ).lines.map((l) => [l.account.name, l.debit, l.credit]);
    const [first, second] = list.vouchers.sort((x, y) => x.number.localeCompare(y.number));
    expect(await lines(first!.id)).toEqual([
      ['SBI Current', '560000.00', '0.00'],
      ['Vehicles', '0.00', '550160.00'],
      ['Profit or loss on sale of assets', '0.00', '9840.00'],
    ]);
    expect(await lines(second!.id)).toEqual([
      ['SBI Current', '900000.00', '0.00'],
      ['Plant and machinery', '0.00', '1128684.93'],
      ['Profit or loss on sale of assets', '228684.93', '0.00'],
    ]);
    // A run with disposed assets in it is not reversed; a disposed asset is not moved.
    const runs = await ok<{ id: string; reversed: boolean }[]>(
      get(`/tenant/accounts/depreciation-runs?entityId=${entityId}`, manager),
    );
    expect(
      (
        await post(
          `/tenant/accounts/depreciation-runs/${runs.find((x) => !x.reversed)!.id}/reverse`,
          { date: '2027-04-02', reason: 'again' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'asset_disposed' });
    expect(
      (
        await post(
          `/tenant/accounts/assets/${car}/transfer`,
          { date: '2027-05-01', projectId: p2 },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'disposed' });
  });
});
