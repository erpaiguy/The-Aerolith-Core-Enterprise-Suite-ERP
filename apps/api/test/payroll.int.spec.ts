// Payroll in a real tenant database (docs/wave3-plan.md step 12a), every figure by hand: three of a site's staff paid
// for September 2026 (the month the PF ceiling became ₹25,000): unpaid days, arrears and an advance recovered, the
// Code on Wages' 50% rule, PF on the ceiling and on actual wages, ESI, Maharashtra's professional tax, TDS under both
// regimes; approved, posted by project, paid, with the bank file.
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

describe.skipIf(!controlUrl || !adminUrl)('payroll (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let rajuUser: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-pay-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'pay-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, rajuUser] = [m.headers, w.headers, w.id];
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  let entityId: string;
  let p1: string;
  let p2: string;
  let s1: string;
  let s2: string;
  let suresh: string;
  let raju: string;
  let meena: string;
  let runId: string;
  let bank: string;
  const comp = new Map<string, string>();
  const upload = (content: string) => {
    const boundary = '----pay' + Math.random().toString(16).slice(2);
    return app.inject({
      method: 'POST',
      url: `/api/tenant/hr/attendance/import?entityId=${entityId}`,
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="punches.csv"\r\n` +
          `Content-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`,
      ),
      headers: { ...t.admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };

  it("sets up a site's staff: salaries, deployments, September's attendance", async () => {
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
    p2 = (await ok<{ id: string }>(post('/tenant/projects', { name: 'Flyover, Badnera' }, manager)))
      .id;
    s1 = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${p1}/sites`, { name: 'Ring road', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    s2 = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${p2}/sites`, { name: 'Flyover', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    await ok(
      post('/tenant/hr/calendars', { entityId, name: 'Sites', workWeek: 63, isDefault: true }),
    );
    const employee = async (code: string, name: string, gender: string, extra: object = {}) =>
      (
        await ok<{ id: string }>(
          post('/tenant/hr/employees', {
            entityId,
            code,
            name,
            gender,
            joinedOn: '2026-04-01',
            bankAccount: `5000${code.slice(1)}12345`,
            bankIfsc: 'SBIN0001234',
            ...extra,
          }),
        )
      ).id;
    suresh = await employee('E001', 'Suresh Patil', 'male', {
      pan: 'ABCPS1234K',
      uan: '100200300400',
      joinedOn: '2020-04-01',
    });
    raju = await employee('E002', 'Raju Shinde', 'male', {
      kind: 'worker',
      esiNumber: '3100123456',
      userId: rajuUser,
    });
    meena = await employee('E003', 'Meena Kale', 'female');
    for (const id of [suresh, raju, meena])
      await ok(
        post(`/tenant/hr/employees/${id}/deployments`, {
          from: '2026-09-01',
          projectId: p1,
          siteId: s1,
        }),
      );
    // Suresh moves to the flyover halfway through.
    await ok(
      post(`/tenant/hr/employees/${suresh}/deployments`, {
        from: '2026-09-16',
        projectId: p2,
        siteId: s2,
      }),
    );

    // Payroll is its own permission: not even a manager has it by default.
    expect((await get('/tenant/payroll/rules', manager)).statusCode).toBe(403);
    for (const c of await ok<{ id: string; code: string }[]>(get('/tenant/payroll/components')))
      comp.set(c.code, c.id);
    const salary = (id: string, lines: [string, string][], extra: object = {}) =>
      ok(
        post(`/tenant/payroll/employees/${id}/salary`, {
          from: '2026-04-01',
          lines: lines.map(([code, amount]) => ({ componentId: comp.get(code), amount })),
          ...extra,
        }),
      );
    await salary(suresh, [
      ['BASIC', '100000'],
      ['HRA', '40000'],
      ['SPECIAL', '60000'],
    ]);
    await salary(raju, [
      ['BASIC', '12000'],
      ['DA', '3000'],
      ['HRA', '3000'],
    ]);
    await salary(
      meena,
      [
        ['BASIC', '30000'],
        ['CONV', '10000'],
        ['SPECIAL', '40000'],
      ],
      { pfMode: 'actual', regime: 'old', oldDeductions: '150000' },
    );
    expect(
      (
        await post(`/tenant/payroll/employees/${meena}/salary`, {
          from: '2026-03-01',
          lines: [{ componentId: comp.get('BASIC'), amount: '1' }],
        })
      ).json(),
    ).toMatchObject({ code: 'before_joining' });

    // September by the device: everyone in 09:00–18:00 on each working day; Raju away 10–12 September.
    const rows = ['Emp Code,Date,Time'];
    for (let d = 1; d <= 30; d++) {
      const day = `2026-09-${String(d).padStart(2, '0')}`;
      if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) continue;
      for (const code of ['E001', 'E002', 'E003']) {
        if (code === 'E002' && d >= 10 && d <= 12) continue;
        rows.push(`${code},${day},09:00`, `${code},${day},18:00`);
      }
    }
    expect((await ok<{ imported: number }>(upload(rows.join('\n')))).imported).toBe(75);
    const month = await ok<{ rows: { code: string; payable: string }[] }>(
      get(`/tenant/hr/attendance/month?entityId=${entityId}&month=2026-09`),
    );
    expect(month.rows.map((r) => [r.code, r.payable])).toEqual([
      ['E001', '30.0'],
      ['E002', '27.0'],
      ['E003', '30.0'],
    ]);
  });

  it('works September by the rules in force on its last day', async () => {
    const run = await ok<{ id: string }>(
      post('/tenant/payroll/runs', { entityId, month: '2026-09' }),
    );
    runId = run.id;
    // Arrears for Suresh (one-off, taxed at once) and an advance recovered.
    await ok(
      post(`/tenant/payroll/runs/${runId}/adjustments`, {
        employeeId: suresh,
        componentId: comp.get('ARREARS'),
        amount: '50000',
        note: 'April to August',
      }),
    );
    const r = await ok<{
      lines: (Record<string, unknown> & { code: string; pf: Record<string, number> })[];
      totals: Record<string, string>;
    }>(
      post(`/tenant/payroll/runs/${runId}/adjustments`, {
        employeeId: suresh,
        componentId: comp.get('ADVANCE'),
        amount: '5000',
      }),
    );
    const by = Object.fromEntries(r.lines.map((l) => [l.code, l]));
    // Suresh: ₹2 lakh a month and ₹50,000 arrears. Wages: basic ₹1 lakh, the allowances exactly half, so no more. PF
    // on the ₹25,000 ceiling in force from 17 September: 12% ₹3,000; the pension's 8.33% ₹2,082.50 → ₹2,083; EPF ₹917;
    // EDLI and admin ₹125 each. TDS: ₹2 lakh now and for six more months less ₹75,000 is ₹13.25 lakh: ₹78,750 and 4%,
    // ₹81,900 over 7 months = ₹11,700; the arrears add ₹7,800 (₹89,700 on ₹13.75 lakh): ₹19,500.
    expect(by.E001).toMatchObject({
      payableDays: '30.0',
      gross: '250000.00',
      wages: '100000.00',
      pf: { epfWages: 25000, employee: 3000, eps: 2083, employerEpf: 917, edli: 125, admin: 125 },
      esiEmployee: '0.00',
      pt: '200.00',
      tds: '19500.00',
      net: '222300.00',
      split: [
        { projectId: p1, days: 15 },
        { projectId: p2, days: 15 },
      ],
    });
    // Raju: 27 of 30 days, so ₹16,200 of ₹18,000; wages ₹13,500 (basic and DA); PF ₹1,620 (pension ₹1,124.55 →
    // ₹1,125, EPF ₹495, EDLI and admin ₹67.50 → ₹68); ESI (₹18,000 a month is within ₹21,000) 0.75% ₹121.50 → ₹122,
    // 3.25% ₹526.50 → ₹527; PT ₹200; no tax.
    expect(by.E002).toMatchObject({
      payableDays: '27.0',
      gross: '16200.00',
      wages: '13500.00',
      pf: { employee: 1620, eps: 1125, employerEpf: 495, edli: 68, admin: 68 },
      esiEmployee: '122.00',
      esiEmployer: '527.00',
      pt: '200.00',
      tds: '0.00',
      net: '14258.00',
    });
    // Meena: ₹80,000 with ₹50,000 of allowances, ₹10,000 over half: wages ₹40,000; PF on actual wages ₹4,800 (pension
    // still on ₹25,000: ₹2,083; EPF ₹2,717; admin ₹200); PT for a woman over ₹25,000 ₹200; the old regime with ₹1.5
    // lakh declared: ₹3.6 lakh taxable, within the rebate.
    expect(by.E003).toMatchObject({
      wages: '40000.00',
      pf: { epfWages: 40000, employee: 4800, eps: 2083, employerEpf: 2717, edli: 125, admin: 200 },
      pt: '200.00',
      tds: '0.00',
      net: '75000.00',
      tax: { regime: 'old', projected: 360000, yearTax: 0 },
    });
    expect(r.totals).toMatchObject({
      employees: 3,
      gross: '346200.00',
      net: '311558.00',
      pfEmployee: '9420.00',
      esiEmployee: '122.00',
      esiEmployer: '527.00',
      pt: '600.00',
      tds: '19500.00',
      otherDeductions: '5000.00',
    });
  });

  it('approves, posts by project and pays it, with the bank file', async () => {
    expect((await post(`/tenant/payroll/runs/${runId}/post`, {})).json()).toMatchObject({
      code: 'not_approved',
    });
    expect(
      (await ok<{ status: string }>(post(`/tenant/payroll/runs/${runId}/submit`, {}))).status,
    ).toBe('approved');
    expect(
      (
        await post(`/tenant/payroll/runs/${runId}/adjustments`, {
          employeeId: raju,
          componentId: comp.get('OTHER'),
          amount: '10',
        })
      ).json(),
    ).toMatchObject({ code: 'not_draft' });
    // A rule from a month already approved would not match what was paid.
    expect(
      (
        await post('/tenant/payroll/rules', {
          kind: 'esi',
          effectiveFrom: '2026-09-01',
          data: { ceiling: 25000, employeeRate: 0.75, employerRate: 3.25 },
        })
      ).json(),
    ).toMatchObject({ code: 'months_paid' });
    const posted = await ok<{ status: string; voucherId: string }>(
      post(`/tenant/payroll/runs/${runId}/post`, {}),
    );
    expect(posted.status).toBe('posted');
    const v = await ok<{
      date: string;
      total: string;
      lines: {
        account: { name: string };
        project: { name: string } | null;
        debit: string;
        credit: string;
      }[];
    }>(get(`/tenant/accounts/vouchers/${posted.voucherId}`, manager));
    // Salaries by project (Suresh half each); employer PF, EDLI, admin and ESI likewise; owed to staff and authorities.
    expect(v).toMatchObject({ date: '2026-09-30', total: '356858.00' });
    expect(
      v.lines.map((l) => [l.account.name, l.project?.name ?? null, l.debit, l.credit]),
    ).toEqual([
      ['Salaries and wages', 'Ring road, Amravati', '221200.00', '0.00'],
      ['Salaries and wages', 'Flyover, Badnera', '125000.00', '0.00'],
      ['Contribution to PF and ESI', 'Ring road, Amravati', '9033.00', '0.00'],
      ['Contribution to PF and ESI', 'Flyover, Badnera', '1625.00', '0.00'],
      ['Salaries payable', null, '0.00', '311558.00'],
      ['Staff advances', null, '0.00', '5000.00'],
      ['PF payable', null, '0.00', '19551.00'],
      ['ESI payable', null, '0.00', '649.00'],
      ['Professional tax payable', null, '0.00', '600.00'],
      ['TDS payable, salaries', null, '0.00', '19500.00'],
    ]);

    const file = await get(`/tenant/payroll/runs/${runId}/bank-file`);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.body.split('\r\n')).toEqual([
      'Employee code,Name,Account number,IFSC,Amount,Narration',
      'E001,Suresh Patil,500000112345,SBIN0001234,222300.00,Salary 2026-09',
      'E002,Raju Shinde,500000212345,SBIN0001234,14258.00,Salary 2026-09',
      'E003,Meena Kale,500000312345,SBIN0001234,75000.00,Salary 2026-09',
      '',
    ]);
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    bank = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id,
          code: 'A4002',
          name: 'SBI Current 1188',
          kind: 'bank',
        }),
      )
    ).accounts.find((a) => a.code === 'A4002')!.id;
    const paid = await ok<{ status: string; payment: string }>(
      post(`/tenant/payroll/runs/${runId}/pay`, { bankAccountId: bank, date: '2026-10-01' }),
    );
    expect(paid).toMatchObject({ status: 'paid', payment: 'PV/2026-27/0001' });

    // Raju sees his own payslip, not Suresh's; the run list shows it paid.
    const slip = await ok<{ net: string; earnings: { code: string; amount: number }[] }>(
      get(`/tenant/payroll/runs/${runId}/payslips/${raju}`, worker),
    );
    expect((await get(`/tenant/payroll/runs/${runId}/payslips/${suresh}`, worker)).statusCode).toBe(
      403,
    );
    expect(await ok(get('/tenant/payroll/payslips/mine', worker))).toEqual([
      { runId, month: '2026-09', net: '14258.00' },
    ]);
    expect(slip.earnings.map((e) => [e.code, e.amount])).toEqual([
      ['BASIC', 10800],
      ['DA', 2700],
      ['HRA', 2700],
    ]);
    expect(await ok(get('/tenant/payroll/runs?entityId=' + entityId))).toEqual([
      expect.objectContaining({ month: '2026-09', status: 'paid', employees: 3, net: '311558.00' }),
    ]);
  });
  it('files the ECR, the ESI data and the year for Form 16 (the 3b exit check)', async () => {
    // The ECR: only members with a UAN; the others named.
    const ecr = await ok<{ text: string; members: number; withoutUan: string[] }>(
      get(`/tenant/payroll/runs/${runId}/ecr`),
    );
    expect(ecr).toEqual({
      fileName: 'ECR-2026-09.txt',
      text: '100200300400#~#SURESH PATIL#~#250000#~#25000#~#25000#~#25000#~#3000#~#2083#~#917#~#0#~#0\n',
      members: 1,
      withoutUan: ['E002', 'E003'],
    });
    const file = await get(`/tenant/payroll/runs/${runId}/ecr?format=txt`);
    expect(file.headers['content-disposition']).toContain('ECR-2026-09.txt');
    // ESI: Raju, 27 days, ₹16,200.
    expect((await ok<{ rows: unknown[] }>(get(`/tenant/payroll/runs/${runId}/esi`))).rows).toEqual([
      {
        code: 'E002',
        name: 'Raju Shinde',
        ipNumber: '3100123456',
        days: 27,
        wages: 16200,
        employee: '122.00',
        employer: '527.00',
      },
    ]);
    expect((await get(`/tenant/payroll/runs/${runId}/esi?format=xlsx`)).statusCode).toBe(200);
    // The year so far: Suresh's ₹2.5 lakh less ₹75,000; TDS ₹19,500 in the second quarter.
    const year = await ok<{ employees: Record<string, unknown>[] }>(
      get(`/tenant/payroll/year-form?entityId=${entityId}&year=2026`),
    );
    expect(
      year.employees.map((e) => [e.code, e.regime, e.grossSalary, e.taxableIncome, e.tds]),
    ).toEqual([
      ['E001', 'new', '250000.00', '175000.00', '19500.00'],
      ['E002', 'new', '16200.00', '0.00', '0.00'],
      ['E003', 'old', '80000.00', '0.00', '0.00'],
    ]);
    expect(year.employees[0]!.tdsByQuarter).toEqual({
      Q1: '0.00',
      Q2: '19500.00',
      Q3: '0.00',
      Q4: '0.00',
    });
  });

  it("deposits September's salary TDS by challan and gives the quarter's 24Q", async () => {
    // docs/wave8-plan.md step 8b.3: Suresh's ₹19,500 under section 192.
    const c = await ok<{ section: string; tax: string; total: string }>(
      post('/tenant/accounts/tds/salary-challans', {
        entityId,
        period: '2026-09',
        depositedOn: '2026-10-07',
        bsrCode: '0510308',
        challanNo: '00077',
        bankAccountId: bank,
      }),
    );
    expect(c).toMatchObject({ section: '192', tax: '19500.00', total: '19500.00' });
    expect(
      (
        await post('/tenant/accounts/tds/salary-challans', {
          entityId,
          period: '2026-09',
          depositedOn: '2026-10-07',
          bsrCode: '0510308',
          challanNo: '00078',
          bankAccountId: bank,
        })
      ).json(),
    ).toMatchObject({ code: 'nothing_to_deposit' });
    const q = await ok<{
      total: string;
      problems: string[];
      deductees: { code: string; paid: string; tds: string; challan: { challanNo: string } }[];
    }>(get(`/tenant/accounts/tds/24q?entityId=${entityId}&quarter=2026-27-Q2`));
    expect(q.total).toBe('19500.00');
    expect(q.deductees.map((d) => [d.code, d.paid, d.tds, d.challan.challanNo])).toEqual([
      ['E001', '250000.00', '19500.00', '00077'],
    ]);
    // Without the company's TAN there is no file for the FVU.
    expect(
      (
        await get(`/tenant/accounts/tds/fvu?entityId=${entityId}&quarter=2026-27-Q2&form=24Q`)
      ).json(),
    ).toMatchObject({ code: 'tan_missing' });
  });

  it("settles Suresh's full and final after six years", async () => {
    // Earned leave: 5 days brought forward and 11 accrued by September (15 a year, monthly): 16.
    const el = (
      await ok<{ id: string; code: string }[]>(
        post('/tenant/hr/leave-types', {
          code: 'EL',
          name: 'Earned leave',
          daysPerYear: '15',
          accrual: 'monthly',
          carryForwardMax: '30',
        }),
      )
    ).find((x) => x.code === 'EL')!.id;
    await ok(
      app.inject({
        method: 'PUT',
        url: `/api/tenant/hr/employees/${suresh}/leave-openings`,
        payload: { year: 2026, leaveTypeId: el, days: '5' },
        headers: t.admin,
      }),
    );
    expect(
      (await post(`/tenant/payroll/employees/${suresh}/settlement`, { reason: 'resigned' })).json(),
    ).toMatchObject({ code: 'not_leaving' });
    const e = await ok<{ rowVersion: number }>(get(`/tenant/hr/employees/${suresh}`));
    await ok(
      app.inject({
        method: 'PUT',
        url: `/api/tenant/hr/employees/${suresh}`,
        payload: { leftOn: '2026-09-30', rowVersion: e.rowVersion },
        headers: t.admin,
      }),
    );
    // Wages ₹1 lakh (basic; the allowances exactly half). Gratuity: ₹1,00,000 ÷ 26 × 15 × 6 years = ₹3,46,153.85 →
    // ₹3,46,154. Encashment: 16 days × ₹1,00,000 ÷ 26 = ₹61,538. Notice 15 days short: ₹2,00,000 ÷ 30 × 15 = ₹1,00,000
    // recovered. Total ₹3,07,692.
    const s = await ok(
      post(`/tenant/payroll/employees/${suresh}/settlement`, {
        reason: 'resigned',
        noticeDays: '-15',
        leaveTypeCode: 'EL',
      }),
    );
    expect(s).toMatchObject({
      lastDay: '2026-09-30',
      wages: '100000.00',
      years: 6,
      gratuity: '346154.00',
      leaveDays: '16.0',
      encashment: '61538.00',
      noticeAmount: '-100000.00',
      total: '307692.00',
      status: 'draft',
    });
    const posted = await ok<{ status: string; voucher: string }>(
      post(`/tenant/payroll/employees/${suresh}/settlement/post`, {}),
    );
    expect(posted).toMatchObject({ status: 'posted', voucher: 'JV/2026-27/0002' });
    expect(
      (await post(`/tenant/payroll/employees/${suresh}/settlement`, { reason: 'resigned' })).json(),
    ).toMatchObject({ code: 'settled' });
  });

  it('revises salaries in bulk from an increment sheet, all or none', async () => {
    // docs/wave7-plan.md step 7c.7.
    interface Sheet {
      rows: {
        employee: { id: string; code: string };
        salary: { from: string; gross: string } | null;
      }[];
    }
    const sheet = await ok<Sheet>(
      get(`/tenant/payroll/increments?entityId=${entityId}&from=2026-11-01`),
    );
    const r = sheet.rows.find((x) => x.employee.id === raju)!;
    expect(r.salary).not.toBeNull();
    const before = Number(r.salary!.gross);
    // September is approved: an increment from 1 September is refused, for everyone.
    expect(
      (
        await post('/tenant/payroll/increments', {
          entityId,
          from: '2026-09-01',
          rows: [{ employeeId: raju, pct: '10' }],
        })
      ).json(),
    ).toMatchObject({ code: 'months_paid' });
    expect(
      (
        await post(
          '/tenant/payroll/increments',
          { entityId, from: '2026-11-01', rows: [{ employeeId: raju, pct: '10' }] },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    const after = await ok<Sheet>(
      post('/tenant/payroll/increments', {
        entityId,
        from: '2026-11-01',
        rows: [
          { employeeId: raju, pct: '10' },
          ...sheet.rows
            .filter((x) => x.employee.id !== raju)
            .map((x) => ({ employeeId: x.employee.id, pct: '0' })),
        ],
      }),
    );
    const now = after.rows.find((x) => x.employee.id === raju)!.salary!;
    expect(now.from).toBe('2026-11-01');
    // Each part 10% more, to the rupee: within a rupee a part of the whole.
    expect(Math.abs(Number(now.gross) - before * 1.1)).toBeLessThan(sheet.rows.length * 3);
    const history = await ok<{ from: string }[]>(get(`/tenant/payroll/employees/${raju}/salary`));
    expect(history[0]!.from).toBe('2026-11-01');
  });
});
