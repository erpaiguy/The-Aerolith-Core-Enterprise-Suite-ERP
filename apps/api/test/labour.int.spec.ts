// Contract labour in a real tenant database (docs/wave3-plan.md step 13), every figure by hand: a contractor whose
// licence is near its end and exceeded; workers (the DPDP rule for Aadhaar); September's musters with overtime, a
// worker refused on two sites in a day, the daily report's counts; the wage sheet with a worker below the minimum
// wage refused, put right, passed and verified as paid; the registers; BOCW cess due on the cost and paid.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
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

describe.skipIf(!controlUrl || !adminUrl)('contract labour (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-lab-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'lab-admin@example.in');
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
  let p1: string;
  let s1: string;
  let s2: string;
  let party: string;
  const w = new Map<string, string>();
  let sheetId: string;
  const put = (url: string, payload: object, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'PUT', url: `/api${url}`, payload, headers });
  const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}`;

  it('keeps a contractor, its licence and its workers', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Amravati Roads Pvt Ltd',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    p1 = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Ring road, Amravati' }, manager))
    ).id;
    const sites = await ok<{ sites: { id: string; name: string }[] }>(
      post(`/tenant/projects/${p1}/sites`, { name: 'Ring road', stateCode: '27' }, manager),
    );
    s1 = sites.sites[0]!.id;
    s2 = (
      await ok<{ sites: { id: string; name: string }[] }>(
        post(`/tenant/projects/${p1}/sites`, { name: 'Bypass', stateCode: '27' }, manager),
      )
    ).sites.find((s) => s.name === 'Bypass')!.id;
    party = (
      await ok<{ id: string }>(
        post('/tenant/parties', { name: 'Shree Labour Supply', isClient: false, isVendor: true }),
      )
    ).id;

    expect((await get('/tenant/labour/contractors', worker)).statusCode).toBe(403);
    // A licence for two workers, ending in 20 days.
    const validTo = new Date(Date.now() + 330 * 60_000 + 20 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await ok(
      put(
        `/tenant/labour/contractors/${party}`,
        {
          licenceNo: 'CLRA/27/1234',
          licenceWorkers: 2,
          licenceValidTo: validTo,
          bocwRegistration: 'BOCW/AMT/77',
        },
        manager,
      ),
    );
    const add = (body: object) =>
      post(
        `/tenant/labour/contractors/${party}/workers`,
        { joinedOn: '2026-08-01', ...body },
        manager,
      );
    expect(
      (
        await add({
          name: 'X Y',
          trade: 'Mason',
          skill: 'skilled',
          dailyWage: 700,
          aadhaarLast4: '1234',
        })
      ).json(),
    ).toMatchObject({ code: 'aadhaar_consent' });
    await ok(
      add({
        name: 'Ramesh Pawar',
        relative: 'Bhagwan Pawar',
        gender: 'male',
        trade: 'Mason',
        skill: 'skilled',
        dailyWage: '750',
      }),
    );
    await ok(
      add({
        name: 'Sunita Jadhav',
        gender: 'female',
        trade: 'Helper',
        skill: 'unskilled',
        dailyWage: '450',
        aadhaarLast4: '4321',
        aadhaarConsentOn: '2026-08-01',
      }),
    );
    const list = await ok<{ id: string; name: string }[]>(
      add({
        name: 'Ganesh More',
        gender: 'male',
        trade: 'Helper',
        skill: 'unskilled',
        dailyWage: '520',
      }),
    );
    for (const x of list) w.set(x.name.split(' ')[0]!, x.id);
    const c = await ok<
      {
        name: string;
        workers: number;
        overLicence: boolean;
        licence: { daysLeft: number; nearing: boolean };
      }[]
    >(get('/tenant/labour/contractors', manager));
    expect(c).toEqual([
      expect.objectContaining({
        name: 'Shree Labour Supply',
        workers: 3,
        overLicence: true,
        licence: { daysLeft: 20, lapsed: false, nearing: true },
      }),
    ]);
    // Maharashtra's minimum wages (the test's own figures): unskilled ₹500 in zone I, ₹480 in zone III; skilled ₹700.
    for (const m of [
      { skill: 'unskilled', zone: 'Zone I', daily: '500' },
      { skill: 'unskilled', zone: 'Zone III', daily: '480' },
      { skill: 'skilled', zone: 'Zone I', daily: '700' },
    ])
      await ok(
        post(
          '/tenant/labour/min-wages',
          { stateCode: '27', effectiveFrom: '2026-04-01', ...m },
          manager,
        ),
      );
  });

  it("keeps the site's muster and shows it in the daily report", async () => {
    const mark = (d: number, marks: object[], as = manager, siteId = s1) =>
      post(`/tenant/labour/sites/${siteId}/muster`, { date: day(d), partyId: party, marks }, as);
    expect((await mark(1, [], worker)).statusCode).toBe(404);
    expect(
      (
        await post(
          `/tenant/labour/sites/${s1}/muster`,
          { date: '2099-01-01', partyId: party, marks: [] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'future_day' });
    // Ramesh 1–5 September (2 hours' overtime on the 2nd); Sunita 1–3 and half the 4th; Ganesh 1–4.
    for (let d = 1; d <= 5; d++) {
      const marks: object[] = [
        { workerId: w.get('Ramesh'), status: 'present', overtimeHours: d === 2 ? 2 : 0 },
      ];
      if (d <= 4)
        marks.push({ workerId: w.get('Sunita'), status: d === 4 ? 'half_day' : 'present' });
      if (d <= 4) marks.push({ workerId: w.get('Ganesh'), status: 'present' });
      await ok(mark(d, marks));
    }
    expect(
      (await mark(1, [{ workerId: w.get('Ramesh'), status: 'present' }], manager, s2)).json(),
    ).toMatchObject({
      code: 'elsewhere',
    });
    const m = await ok<{
      rows: { name: string; status: string | null; overtimeHours: string | null }[];
    }>(get(`/tenant/labour/sites/${s1}/muster?date=${day(2)}&partyId=${party}`, manager));
    expect(m.rows.map((r) => [r.name, r.status, r.overtimeHours])).toEqual([
      ['Ganesh More', 'present', '0.0'],
      ['Ramesh Pawar', 'present', '2.0'],
      ['Sunita Jadhav', 'present', '0.0'],
    ]);
    const dr = await ok<{ id: string }>(
      post(`/tenant/projects/${p1}/daily-reports`, { siteId: s1, reportDate: day(4) }, manager),
    );
    expect(
      (await ok<{ muster: unknown[] }>(get(`/tenant/daily-reports/${dr.id}`, manager))).muster,
    ).toEqual([
      {
        contractor: 'Shree Labour Supply',
        trade: 'Helper',
        present: 1,
        halfDays: 1,
        overtimeHours: '0.0',
      },
      {
        contractor: 'Shree Labour Supply',
        trade: 'Mason',
        present: 1,
        halfDays: 0,
        overtimeHours: '0.0',
      },
    ]);
  });

  it("works September's wage sheet against the minimum wage, then verifies it paid", async () => {
    const sheet = await ok<{
      id: string;
      total: string;
      shortfall: string;
      lines: Record<string, unknown>[];
    }>(post('/tenant/labour/wage-sheets', { partyId: party, siteId: s1, month: '2026-09' }));
    sheetId = sheet.id;
    // Ramesh: 5 days at ₹750 = ₹3,750 and 2 hours at twice ₹750 ÷ 8 = ₹375. Sunita: 3½ days at ₹450 = ₹1,575, but
    // unskilled work earns at least ₹500 (the higher zone): ₹175 short. Ganesh: 4 days at ₹520 = ₹2,080.
    expect(
      sheet.lines.map((l) => [
        l.name,
        l.days,
        l.wages,
        l.overtime,
        l.gross,
        l.minimum,
        l.shortfall,
      ]),
    ).toEqual([
      ['Ganesh More', 4, 2080, 0, 2080, 500, 0],
      ['Ramesh Pawar', 5, 3750, 375, 4125, 700, 0],
      ['Sunita Jadhav', 3.5, 1575, 0, 1575, 500, 175],
    ]);
    expect(sheet).toMatchObject({ total: '7780.00', shortfall: '175.00' });
    expect((await post(`/tenant/labour/wage-sheets/${sheetId}/pass`)).json()).toMatchObject({
      code: 'below_minimum',
    });
    // Sunita's rate raised to the minimum; worked again: 3½ × ₹500 = ₹1,750.
    const sunita = (
      await ok<{ id: string; rowVersion: number }[]>(
        get(`/tenant/labour/contractors/${party}/workers`),
      )
    ).find((x) => x.id === w.get('Sunita'))!;
    await ok(
      put(`/tenant/labour/workers/${sunita.id}`, {
        dailyWage: '500',
        rowVersion: sunita.rowVersion,
      }),
    );
    expect(await ok(post(`/tenant/labour/wage-sheets/${sheetId}/work`))).toMatchObject({
      total: '7955.00',
      shortfall: '0.00',
    });
    expect(
      (
        await post(`/tenant/labour/wage-sheets/${sheetId}/verify`, {
          paidOn: '2026-10-05',
          reference: 'NEFT 8812',
          mode: 'bank',
        })
      ).json(),
    ).toMatchObject({ code: 'not_passed' });
    await ok(post(`/tenant/labour/wage-sheets/${sheetId}/pass`));
    expect(
      await ok(
        post(`/tenant/labour/wage-sheets/${sheetId}/verify`, {
          paidOn: '2026-10-05',
          reference: 'NEFT 8812',
          mode: 'bank',
        }),
      ),
    ).toMatchObject({ status: 'verified', paidOn: '2026-10-05' });
    // The month is closed to the muster.
    expect(
      (
        await post(
          `/tenant/labour/sites/${s1}/muster`,
          { date: day(7), partyId: party, marks: [] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'month_passed' });

    // The registers: workmen, the muster roll (P and H by day) and wages.
    const file = await app.inject({
      method: 'GET',
      url: `/api/tenant/labour/wage-sheets/${sheetId}/registers`,
      headers: t.admin,
    });
    expect(file.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'Register of workmen',
      'Muster roll',
      'Register of wages',
    ]);
    const roll = wb.getWorksheet('Muster roll')!;
    const sunitaRow = Array.from(roll.getRow(5).values as ExcelJS.CellValue[]).slice(1);
    expect(sunitaRow.slice(0, 7)).toEqual([3, 'Sunita Jadhav', 'female', 'P', 'P', 'P', 'H']);
    expect(sunitaRow[sunitaRow.length - 1]).toBe(3.5);
    expect(
      Array.from(
        wb.getWorksheet('Register of workmen')!.getRow(4).values as ExcelJS.CellValue[],
      ).slice(1, 4),
    ).toEqual([2, 'Ramesh Pawar', 'Bhagwan Pawar']);
  });

  it('tracks BOCW cess on the cost of construction to payment', async () => {
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const bank = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id,
          code: 'A4002',
          name: 'SBI Current 1188',
          kind: 'bank',
        }),
      )
    ).accounts.find((a) => a.code === 'A4002')!.id;
    // ₹10 lakh of site cost booked to the ring road.
    await ok(
      post('/tenant/accounts/vouchers', {
        entityId,
        type: 'payment',
        date: '2026-09-10',
        reference: 'CHQ 000201',
        narration: 'Site works',
        lines: [
          {
            accountId: chart.accounts.find((a) => a.code === 'X7002')!.id,
            debit: '1000000',
            credit: '0',
            projectId: p1,
          },
          { accountId: bank, debit: '0', credit: '1000000' },
        ],
      }),
    );
    const paid = await ok(
      post(`/tenant/labour/projects/${p1}/cess`, {
        paidOn: '2026-10-10',
        amount: '6000',
        reference: 'BOCW/CH/551',
        bankAccountId: bank,
      }),
    );
    expect(paid).toMatchObject({
      cost: '1000000.00',
      due: '10000.00',
      paid: '6000.00',
      balance: '4000.00',
      payments: [expect.objectContaining({ reference: 'BOCW/CH/551', voucher: 'PV/2026-27/0002' })],
    });
  });
});
