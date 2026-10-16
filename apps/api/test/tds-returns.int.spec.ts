// TDS deposited and returned in a real tenant database (docs/wave3-plan.md step 6b), every figure by hand: a contractor
// under 194C (a bill over the single limit, one under, then the year's catch-up) and rent under 194I; three challans
// (one with interest), a repeat and a duplicate refused; the quarter's 26Q; what clients deducted matched against a
// 26AS extract.
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
import ExcelJS from 'exceljs';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('TDS returns (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-tds-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'tds-admin@example.in');
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
  const vbill = (body: object) =>
    post(
      '/tenant/accounts/vendor-bills',
      { entityId, orderId: null, projectId: null, ...body },
      manager,
    );
  const challan = (body: object, as: Record<string, string> = manager) =>
    post(
      '/tenant/accounts/tds/challans',
      { entityId, bankAccountId: bank, bsrCode: '0510308', ...body },
      as,
    );

  it("deposits deductions in challans, once each, and gives the quarter's 26Q", async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Nagpur Builders Pvt Ltd',
        gstin: '27AAACN1234K1Z2',
        tan: 'NGPA12345B',
        address: 'Civil Lines',
        city: 'Nagpur',
        pincode: '440001',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    bank = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id,
          code: 'A4002',
          name: 'SBI Current 7788',
          kind: 'bank',
        }),
      )
    ).accounts.find((a) => a.code === 'A4002')!.id;
    const ledger = (code: string) => chart.accounts.find((a) => a.code === code)!.id;
    const party = async (body: object) =>
      (
        await ok<{ id: string }>(
          post('/tenant/parties', { isClient: false, isVendor: true, ...body }),
        )
      ).id;
    const ramesh = await party({ name: 'Ramesh Shinde', pan: 'ABCPS1234K', tdsSection: '194C' });
    const patil = await party({ name: 'Patil Estates', pan: 'AAAFP5678Q', tdsSection: '194I' });
    const bill = (
      partyId: string,
      billNo: string,
      billDate: string,
      account: string,
      rate: string,
    ) =>
      ok<{ id: string; tds: string }>(
        vbill({
          partyId,
          billNo,
          billDate,
          dueDate: billDate,
          lines: [{ accountId: ledger(account), description: billNo, qty: '1', rate, gstPct: '0' }],
        }),
      );
    // Rent of ₹2,50,000 for the year (over ₹2,40,000): 10% = 25,000. Ramesh: ₹40,000 (over ₹30,000: 1% = 400),
    // ₹20,000 (nothing), then ₹50,000 in August (the year at ₹1,10,000: 1% on the 70,000 not yet taxed = 700).
    expect((await bill(patil, 'PE/7', '2026-07-01', 'X7002', '250000')).tds).toBe('25000.00');
    expect((await bill(ramesh, 'R/1', '2026-07-10', 'X7001', '40000')).tds).toBe('400.00');
    expect((await bill(ramesh, 'R/2', '2026-07-25', 'X7001', '20000')).tds).toBe('0.00');
    expect((await bill(ramesh, 'R/3', '2026-08-12', 'X7001', '50000')).tds).toBe('700.00');

    let q = await ok<{ problems: string[] }>(
      get(`/tenant/accounts/tds/26q?entityId=${entityId}&quarter=2026-27-Q2`, manager),
    );
    expect(q.problems).toEqual(['3 deductions are not yet in a challan.']);

    expect(
      (
        await challan(
          { section: '194C', period: '2026-07', depositedOn: '2026-08-07', challanNo: '00012' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    const c1 = await ok<{ tax: string; total: string; lines: { billNo: string }[] }>(
      challan({
        section: '194C',
        period: '2026-07',
        depositedOn: '2026-08-07',
        challanNo: '00012',
      }),
    );
    expect([c1.tax, c1.total, c1.lines.map((l) => l.billNo)]).toEqual([
      '400.00',
      '400.00',
      ['R/1'],
    ]);
    expect(
      (
        await challan({
          section: '194C',
          period: '2026-07',
          depositedOn: '2026-08-07',
          challanNo: '00014',
        })
      ).json(),
    ).toMatchObject({ code: 'nothing_to_deposit' });
    expect(
      (
        await challan({
          section: '194I',
          period: '2026-07',
          depositedOn: '2026-08-07',
          challanNo: '00012',
        })
      ).json(),
    ).toMatchObject({ code: 'challan_exists' });
    await ok(
      challan({
        section: '194I',
        period: '2026-07',
        depositedOn: '2026-08-07',
        challanNo: '00013',
      }),
    );
    // August's ₹700, deposited late with ₹21 interest.
    const c3 = await ok<{ total: string; voucher: { id: string } }>(
      challan({
        section: '194C',
        period: '2026-08',
        depositedOn: '2026-09-10',
        challanNo: '00031',
        interest: '21',
      }),
    );
    expect(c3.total).toBe('721.00');
    const v = await ok<{
      type: string;
      lines: { account: { name: string }; debit: string; credit: string }[];
    }>(get(`/tenant/accounts/vouchers/${c3.voucher.id}`, manager));
    expect(v.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['TDS payable 194C', '700.00', '0.00'],
      ['Interest and fees on TDS', '21.00', '0.00'],
      ['SBI Current 7788', '0.00', '721.00'],
    ]);

    q = await ok(get(`/tenant/accounts/tds/26q?entityId=${entityId}&quarter=2026-27-Q2`, manager));
    const f = q as unknown as {
      problems: string[];
      total: string;
      challans: { challanNo: string; total: string }[];
      deductees: {
        pan: string;
        party: string;
        section: string;
        paid: string;
        base: string;
        tds: string;
        challan: { challanNo: string };
      }[];
    };
    expect(f.problems).toEqual([]);
    expect(f.total).toBe('26100.00');
    expect(f.challans.map((c) => [c.challanNo, c.total])).toEqual([
      ['00012', '400.00'],
      ['00013', '25000.00'],
      ['00031', '721.00'],
    ]);
    expect(
      f.deductees.map((d) => [d.pan, d.section, d.paid, d.base, d.tds, d.challan.challanNo]),
    ).toEqual([
      ['AAAFP5678Q', '194I', '250000.00', '250000.00', '25000.00', '00013'],
      ['ABCPS1234K', '194C', '40000.00', '40000.00', '400.00', '00012'],
      ['ABCPS1234K', '194C', '50000.00', '70000.00', '700.00', '00031'],
    ]);
    const x = await app.inject({
      method: 'GET',
      url: `/api/tenant/accounts/tds/26q?entityId=${entityId}&quarter=2026-27-Q2&format=xlsx`,
      headers: manager,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Deductor', 'Challans', 'Deductees']);
    expect(wb.getWorksheet('Deductor')!.getRow(2).values).toEqual([undefined, 'TAN', 'NGPA12345B']);
    expect(wb.getWorksheet('Deductees')!.rowCount).toBe(4);
  });

  it('gives Form 16A and the 26Q text for the FVU, and deducts at a lower certificate rate', async () => {
    // docs/wave8-plan.md step 8b.3.
    const parties = await ok<{ id: string; name: string }[]>(get('/tenant/parties'));
    const ramesh = parties.find((p) => p.name === 'Ramesh Shinde')!.id;
    const f = await ok<{
      deductee: { pan: string };
      tds: string;
      deposited: string;
      complete: boolean;
      rows: unknown[];
    }>(
      get(
        `/tenant/accounts/tds/16a?entityId=${entityId}&quarter=2026-27-Q2&partyId=${ramesh}`,
        manager,
      ),
    );
    expect([f.deductee.pan, f.rows.length, f.tds, f.deposited, f.complete]).toEqual([
      'ABCPS1234K',
      2,
      '1100.00',
      '1100.00',
      true,
    ]);
    const file = await app.inject({
      method: 'GET',
      url: `/api/tenant/accounts/tds/fvu?entityId=${entityId}&quarter=2026-27-Q2&form=26Q`,
      headers: manager,
    });
    expect(file.headers['content-disposition']).toContain('NGPA12345B_26Q_2026-27-Q2.txt');
    const recs = file.body
      .trim()
      .split('\r\n')
      .map((l) => l.split('^'));
    expect(recs.map((r) => r[1])).toEqual(['FH', 'BH', 'CD', 'DD', 'CD', 'DD', 'CD', 'DD']);
    expect(recs[1]!.slice(2, 5)).toEqual(['1', '3', '26Q']);
    expect(recs.filter((r) => r[1] === 'DD').map((r) => r.at(-1))).toEqual(['94C', '4IB', '94C']);

    // A contractor with a certificate under section 197 for 0.5% up to ₹1 lakh: ₹50,000 bears ₹250, not ₹1,000.
    const kale = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          isClient: false,
          isVendor: true,
          name: 'Kale Constructions',
          pan: 'AAAFK1111L',
          tdsSection: '194C',
        }),
      )
    ).id;
    const cert = {
      entityId,
      partyId: kale,
      section: '194C',
      certNo: 'LDC/2026/4471',
      rate: '0.5',
      limit: '100000',
      validFrom: '2026-10-01',
      validTo: '2027-03-31',
    };
    expect((await post('/tenant/accounts/tds/certificates', cert, worker)).statusCode).toBe(403);
    await ok(post('/tenant/accounts/tds/certificates', cert, manager));
    const chart = await ok<{ accounts: { id: string; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const b = await ok<{ tds: string; tdsRate: string }>(
      vbill({
        partyId: kale,
        billNo: 'K/1',
        billDate: '2026-10-05',
        dueDate: '2026-10-05',
        lines: [
          {
            accountId: chart.accounts.find((a) => a.code === 'X7001')!.id,
            description: 'Plaster',
            qty: '1',
            rate: '50000',
            gstPct: '0',
          },
        ],
      }),
    );
    expect([b.tds, Number(b.tdsRate)]).toEqual(['250.00', 0.5]);
    const certs = await ok<{ certNo: string; used: string }[]>(
      get(`/tenant/accounts/tds/certificates?entityId=${entityId}`, manager),
    );
    expect(certs.map((x) => [x.certNo, x.used])).toEqual([['LDC/2026/4471', '50000.00']]);
  });

  it('matches what clients deducted against a 26AS extract', async () => {
    const client = async (name: string, tan: string | null) => {
      const id = (await ok<{ id: string }>(post('/tenant/parties', { name, isClient: true, tan })))
        .id;
      const projectId = (
        await ok<{ id: string }>(
          post('/tenant/projects', { name: `${name} works`, clientId: id }, manager),
        )
      ).id;
      await ok(
        post(
          `/tenant/projects/${projectId}/bill-terms`,
          { rowVersion: null, gstPct: '18', retentionPct: '0', advanceAmount: '100000' },
          manager,
        ),
      );
      return { id, projectId };
    };
    const receipt = (
      c: { id: string; projectId: string },
      receivedOn: string,
      amount: string,
      tds: string,
    ) =>
      ok(
        post(
          '/tenant/accounts/client-receipts',
          {
            entityId,
            partyId: c.id,
            bankAccountId: bank,
            receivedOn,
            amount,
            tds,
            allocations: [
              {
                kind: 'advance',
                projectId: c.projectId,
                amount: String(Number(amount) + Number(tds)),
              },
            ],
          },
          manager,
        ),
      );
    await receipt(await client('PWD Nagpur', 'NGPP01234C'), '2026-08-01', '49000', '1000');
    await receipt(await client('Metro Rail', 'PNEM04567D'), '2026-09-01', '98000', '2000');
    await receipt(await client('Shri Patil', null), '2026-08-15', '24500', '500');

    // The extract: PWD in full; Metro ₹1,800 over two lines (₹200 short); a deductor the books do not know.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('26AS');
    ws.addRow(['Form 26AS, Part I']);
    ws.addRow(['TAN of Deductor', 'Name of Deductor', 'Amount Paid / Credited', 'Tax Deducted']);
    ws.addRow(['NGPP01234C', 'PWD NAGPUR', 50000, 1000]);
    ws.addRow(['PNEM04567D', 'METRO RAIL', 50000, 1000]);
    ws.addRow(['PNEM04567D', 'METRO RAIL', 40000, 800]);
    ws.addRow(['MUMX09876E', 'UNKNOWN CO', 3000, 300]);
    const boundary = '----tds' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="26AS.xlsx"\r\n` +
          'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
      ),
      Buffer.from(await wb.xlsx.writeBuffer()),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await ok<{
      rows: { status: string; party: string; books: string | null; reported: string | null }[];
    }>(
      app.inject({
        method: 'POST',
        url: `/api/tenant/accounts/tds/credits?entityId=${entityId}&quarter=2026-27-Q2`,
        payload,
        headers: { ...manager, 'content-type': `multipart/form-data; boundary=${boundary}` },
      }),
    );
    expect(r.rows.map((x) => [x.status, x.party, x.books, x.reported])).toEqual([
      ['short', 'Metro Rail', '2000.00', '1800.00'],
      ['matched', 'PWD Nagpur', '1000.00', '1000.00'],
      ['no_tan', 'Shri Patil', '500.00', null],
      ['not_in_books', 'UNKNOWN CO', null, '300.00'],
    ]);
  });
});
