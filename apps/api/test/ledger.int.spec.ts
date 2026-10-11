// The ledger core in a real tenant database (docs/wave3-plan.md step 1), every balance worked by hand: companies; the
// chart with a bank ledger added; opening balances imported from Excel; receipts, payments and journals numbered per
// type and year; a voucher that does not balance refused by the API and by the database; a reversal; a locked month;
// the trial balance, a ledger and the day book; the account map; who may do what.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import ExcelJS from 'exceljs';
import postgres, { type Sql } from 'postgres';
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

describe.skipIf(!controlUrl || !adminUrl)('ledger (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-ledger-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'ledger-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  interface Company {
    id: string;
    name: string;
    gstin: string | null;
    pan: string | null;
    stateCode: string | null;
    booksFrom: string | null;
    rowVersion: number;
  }
  interface Account {
    id: string;
    code: string;
    name: string;
    isGroup: boolean;
    systemKey: string | null;
    kind: string;
    rowVersion: number;
  }
  interface Voucher {
    id: string;
    number: string;
    type: string;
    date: string;
    total: string;
    lines: { account: { code: string; name: string }; debit: string; credit: string }[];
    reverses: { number: string } | null;
    reversedBy: { number: string } | null;
    mayReverse: boolean;
  }
  const multipart = (
    url: string,
    name: string,
    content: Buffer,
    headers: Record<string, string> = t.admin,
  ) => {
    const boundary = '----ledger' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: `/api${url}`,
      payload,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  const workbook = async (rows: (string | number | null)[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Opening');
    ws.addRow(['Opening balances as on 1 April 2026']);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  let main: Company;
  let accounts: Map<string, Account>;
  let hdfc: string;
  let zp: string;
  let vidarbha: string;
  let projectId: string;
  const acct = (key: string) => accounts.get(key)!.id;
  const line = (
    target: { accountId?: string; partyId?: string },
    debit: string,
    credit: string,
    extra: object = {},
  ): Record<string, unknown> => ({
    ...target,
    debit,
    credit,
    ...extra,
  });
  const voucher = (
    type: string,
    date: string,
    lines: object[],
    as: Record<string, string> = manager,
    narration = '',
  ) => post('/tenant/accounts/vouchers', { entityId: main.id, type, date, narration, lines }, as);

  it('keeps companies, the chart and opening balances imported from Excel', async () => {
    const list = await ok<{ companies: Company[]; mayEdit: boolean }>(
      get('/tenant/companies', worker),
    );
    expect(list.mayEdit).toBe(false);
    expect(list.companies.map((c) => c.name)).toEqual(['Main entity']);
    const first = list.companies[0]!;
    const body = {
      name: 'Malegaon Infra Pvt Ltd',
      legalName: 'Malegaon Infra Private Limited',
      gstin: '27AAACM1234F1Z5',
      booksFrom: '2026-04-01',
      rowVersion: first.rowVersion,
    };
    expect((await post(`/tenant/companies/${first.id}`, body, manager)).statusCode).toBe(403);
    expect(
      (await post(`/tenant/companies/${first.id}`, { ...body, stateCode: '24' })).json(),
    ).toMatchObject({ code: 'state_mismatch' });
    // The state and PAN come from the GSTIN.
    main = (await ok<{ companies: Company[] }>(post(`/tenant/companies/${first.id}`, body)))
      .companies[0]!;
    expect(main).toMatchObject({ stateCode: '27', pan: 'AAACM1234F', booksFrom: '2026-04-01' });
    const second = await ok<{ companies: Company[] }>(
      post('/tenant/companies', {
        name: 'Malegaon Interiors LLP',
        gstin: '24AAKFM9876Q1Z2',
        booksFrom: '2026-04-01',
      }),
    );
    expect(second.companies.map((c) => c.name)).toEqual([
      'Malegaon Infra Pvt Ltd',
      'Malegaon Interiors LLP',
    ]);

    // The seeded chart, and a bank ledger added under Cash and bank.
    expect((await get('/tenant/accounts/chart', worker)).statusCode).toBe(403);
    let chart = await ok<{ accounts: Account[] }>(get('/tenant/accounts/chart', manager));
    const byKey = new Map(chart.accounts.filter((a) => a.systemKey).map((a) => [a.systemKey!, a]));
    expect(chart.accounts.filter((a) => !a.isGroup).length).toBeGreaterThan(40);
    const bank = {
      parentId: byKey.get('cash_and_bank')!.id,
      code: 'A4002',
      name: 'HDFC Bank 0012',
      kind: 'bank',
    };
    expect((await post('/tenant/accounts/chart', bank, manager)).statusCode).toBe(403);
    chart = await ok(post('/tenant/accounts/chart', bank));
    expect(
      (await post('/tenant/accounts/chart', { ...bank, name: 'Other bank' })).json(),
    ).toMatchObject({
      code: 'code_exists',
    });
    expect(
      (
        await post('/tenant/accounts/chart', {
          ...bank,
          code: 'A9',
          parentId: byKey.get('cash')!.id,
        })
      ).json(),
    ).toMatchObject({ code: 'parent_not_group' });
    accounts = new Map(chart.accounts.map((a) => [a.systemKey ?? a.code, a]));
    hdfc = acct('A4002');

    const party = async (name: string, isClient: boolean) =>
      (await ok<{ id: string }>(post('/tenant/parties', { name, isClient, isVendor: !isClient })))
        .id;
    zp = await party('Zilla Parishad Washim', true);
    vidarbha = await party('Vidarbha Cement Traders', false);
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;

    // Opening balances on 1 April 2026: capital ₹10,00,000; the bank ₹6,00,000, cash ₹50,000 and plant ₹4,00,000;
    // ₹50,000 owed to Vidarbha. By code, by name, by party name, amounts with commas.
    const rows = [
      ['Ledger', 'Debit', 'Credit'],
      ['E1001', null, '10,00,000'],
      ['A4002', 600000, null],
      ['Cash in hand', '50,000.00', null],
      ['a1001', 400000, null],
      ['Vidarbha Cement Traders', null, 50000],
    ];
    const bad = await ok<{ problems: { rowNo: number; message: string }[]; posted: boolean }>(
      multipart(
        `/tenant/companies/${main.id}/opening/import?post=true`,
        'opening.xlsx',
        await workbook([...rows, ['Petty cash box', 10, null]]),
      ),
    );
    expect(bad).toMatchObject({
      posted: false,
      problems: [{ rowNo: 8, message: 'No ledger or party called "Petty cash box".' }],
    });
    const dry = await ok<{
      debit: string;
      credit: string;
      balanced: boolean;
      posted: boolean;
      lines: { label: string }[];
    }>(
      multipart(
        `/tenant/companies/${main.id}/opening/import`,
        'opening.xlsx',
        await workbook(rows),
      ),
    );
    expect(dry).toMatchObject({
      debit: '1050000.00',
      credit: '1050000.00',
      balanced: true,
      posted: false,
    });
    expect(dry.lines.map((l) => l.label)).toEqual([
      'E1001 Capital account',
      'A4002 HDFC Bank 0012',
      'A4001 Cash in hand',
      'A1001 Plant and machinery',
      'Vidarbha Cement Traders (party)',
    ]);
    expect(
      (
        await multipart(
          `/tenant/companies/${main.id}/opening/import?post=true`,
          'opening.xlsx',
          await workbook(rows),
          manager,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      await ok(
        multipart(
          `/tenant/companies/${main.id}/opening/import?post=true`,
          'opening.xlsx',
          await workbook(rows),
        ),
      ),
    ).toMatchObject({ posted: true });
    const opening = await ok<{ voucher: { number: string; date: string } }>(
      get(`/tenant/companies/${main.id}/opening`, manager),
    );
    expect(opening.voucher).toMatchObject({ number: 'OB/2025-26/0001', date: '2026-03-31' });
    // The books' start no longer moves.
    const now = (await ok<{ companies: Company[] }>(get('/tenant/companies'))).companies[0]!;
    expect(
      (
        await post(`/tenant/companies/${main.id}`, {
          ...body,
          booksFrom: '2026-07-01',
          rowVersion: now.rowVersion,
        })
      ).json(),
    ).toMatchObject({ code: 'books_have_entries' });
  });

  it('posts balanced vouchers, numbered by type and year, refuses what does not balance, and reverses', async () => {
    // ₹2,36,000 advance from the Zilla Parishad into the bank.
    const rv = await ok<Voucher>(
      voucher('receipt', '2026-10-05', [
        line({ accountId: hdfc }, '236000', '0'),
        line({ partyId: zp }, '0', '236000'),
      ]),
    );
    expect(rv).toMatchObject({ number: 'RV/2026-27/0001', total: '236000.00' });
    expect(rv.lines.map((l) => l.account.name)).toEqual([
      'HDFC Bank 0012',
      'Zilla Parishad Washim',
    ]);
    // ₹50,000 paid to Vidarbha.
    const pv = await ok<Voucher>(
      voucher('payment', '2026-10-06', [
        line({ partyId: vidarbha }, '50000', '0'),
        line({ accountId: hdfc }, '0', '50000'),
      ]),
    );
    expect(pv.number).toBe('PV/2026-27/0001');
    // ₹12,000 of site overheads against a staff advance: site overheads need a project (the database says so).
    const overheads = [
      line({ accountId: acct('site_overheads') }, '12000', '0'),
      line({ accountId: acct('staff_advances') }, '0', '12000'),
    ];
    expect((await voucher('journal', '2026-10-07', overheads)).json()).toMatchObject({
      code: 'project_needed',
    });
    overheads[0] = { ...overheads[0], projectId };
    expect((await ok<Voucher>(voucher('journal', '2026-10-07', overheads))).number).toBe(
      'JV/2026-27/0001',
    );

    // Refused: unbalanced, bank in a journal, a payment not out of bank or cash, a worker, before the books.
    expect(
      (
        await voucher('journal', '2026-10-07', [
          line({ accountId: acct('rent') }, '100', '0'),
          line({ accountId: acct('staff_advances') }, '0', '99.99'),
        ])
      ).json(),
    ).toMatchObject({ code: 'unbalanced' });
    expect(
      (
        await voucher('journal', '2026-10-07', [
          line({ accountId: hdfc }, '100', '0'),
          line({ accountId: acct('staff_advances') }, '0', '100'),
        ])
      ).json(),
    ).toMatchObject({ code: 'voucher_type' });
    expect(
      (
        await voucher('payment', '2026-10-07', [
          line({ accountId: acct('rent') }, '100', '0'),
          line({ accountId: acct('staff_advances') }, '0', '100'),
        ])
      ).json(),
    ).toMatchObject({ code: 'voucher_type' });
    expect((await voucher('journal', '2026-10-07', overheads, worker)).statusCode).toBe(403);
    expect((await voucher('journal', '2026-03-15', overheads)).json()).toMatchObject({
      code: 'before_books',
    });
    expect(
      (
        await voucher('journal', '2026-10-07', [
          line({ accountId: acct('loans_and_advances') }, '1', '0'),
          line({ accountId: acct('rent') }, '0', '1'),
        ])
      ).json(),
    ).toMatchObject({ code: 'not_a_ledger' });

    // The database itself: an unbalanced voucher fails at commit; a posted line cannot be changed.
    await expect(
      db.begin(async (tx) => {
        const [v] = await tx<{ id: string }[]>`
          INSERT INTO acc.voucher (entity_id, type, number, voucher_date, total)
          VALUES (${main.id}, 'journal', 'X/1', '2026-10-07', 100) RETURNING id`;
        await tx`INSERT INTO acc.voucher_line (voucher_id, position, account_id, debit) VALUES (${v!.id}, 1, ${acct('rent')}, 100)`;
        await tx`INSERT INTO acc.voucher_line (voucher_id, position, account_id, credit) VALUES (${v!.id}, 2, ${acct('staff_advances')}, 90)`;
      }),
    ).rejects.toThrow(/unbalanced/);
    await expect(
      db`UPDATE acc.voucher_line SET debit = 1 WHERE voucher_id = ${pv.id} AND position = 1`,
    ).rejects.toThrow(/permission denied/);
    await expect(db`DELETE FROM acc.voucher WHERE id = ${pv.id}`).rejects.toThrow(
      /permission denied/,
    );

    // The payment was a mistake: reversed on the 8th, every line the other way round.
    const back = await ok<Voucher>(
      post(
        `/tenant/accounts/vouchers/${pv.id}/reverse`,
        { date: '2026-10-08', reason: 'Paid twice' },
        manager,
      ),
    );
    expect(back).toMatchObject({
      number: 'PV/2026-27/0002',
      reverses: { number: 'PV/2026-27/0001' },
      mayReverse: false,
    });
    expect(back.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['Vidarbha Cement Traders', '0.00', '50000.00'],
      ['HDFC Bank 0012', '50000.00', '0.00'],
    ]);
    expect(
      (
        await post(
          `/tenant/accounts/vouchers/${pv.id}/reverse`,
          { date: '2026-10-08', reason: 'again' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'already_reversed' });
    expect(
      (
        await post(
          `/tenant/accounts/vouchers/${back.id}/reverse`,
          { date: '2026-10-08', reason: 'undo' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'is_reversal' });
    expect(await ok<Voucher>(get(`/tenant/accounts/vouchers/${pv.id}`, manager))).toMatchObject({
      reversedBy: { number: 'PV/2026-27/0002' },
      mayReverse: false,
    });
  });

  it('locks a month, in the API and in the database, and reopens it with a reason', async () => {
    const lockBody = { entityId: main.id, month: '2026-10-01' };
    expect((await post('/tenant/accounts/periods/lock', lockBody, manager)).statusCode).toBe(403);
    const p = await ok<{ months: { month: string; lockedAt: string | null; vouchers: number }[] }>(
      post('/tenant/accounts/periods/lock', lockBody),
    );
    expect(p.months.map((m) => [m.month, !!m.lockedAt, m.vouchers]).slice(6, 7)).toEqual([
      ['2026-10-01', true, 4],
    ]);
    const j = [
      line({ accountId: acct('rent') }, '100', '0'),
      line({ accountId: acct('staff_advances') }, '0', '100'),
    ];
    expect((await voucher('journal', '2026-10-20', j)).json()).toMatchObject({
      code: 'period_locked',
    });
    await expect(
      db`INSERT INTO acc.voucher (entity_id, type, number, voucher_date, total) VALUES (${main.id}, 'journal', 'X/2', '2026-10-20', 1)`,
    ).rejects.toThrow(/period_locked/);
    expect(
      (await post('/tenant/accounts/periods/reopen', { ...lockBody, reason: 'x' })).statusCode,
    ).toBe(400);
    await ok(
      post('/tenant/accounts/periods/reopen', { ...lockBody, reason: 'Rent bill came late' }),
    );
    expect((await ok<Voucher>(voucher('journal', '2026-10-20', j))).number).toBe('JV/2026-27/0002');
    const events = await db<{ action: string; reason: string }[]>`
      SELECT action, reason FROM acc.period_event WHERE entity_id = ${main.id} ORDER BY id`;
    expect(events).toEqual([
      { action: 'locked', reason: '' },
      { action: 'reopened', reason: 'Rent bill came late' },
    ]);
    // The second company numbers its own vouchers.
    const other = (await ok<{ companies: Company[] }>(get('/tenant/companies'))).companies[1]!;
    const own = await ok<Voucher>(
      post(
        '/tenant/accounts/vouchers',
        { entityId: other.id, type: 'journal', date: '2026-10-20', lines: j },
        manager,
      ),
    );
    expect(own.number).toBe('JV/2026-27/0001');
  });

  it('gives the trial balance, a ledger and the day book, by hand', async () => {
    // As at 31 October. Bank 6,00,000 + 2,36,000 − 50,000 + 50,000 = 8,36,000 Dr; cash 50,000 Dr; plant 4,00,000 Dr;
    // site overheads 12,000 Dr; rent 100 Dr. Capital 10,00,000 Cr; Vidarbha 50,000 Cr (the payment reversed);
    // Zilla Parishad 2,36,000 Cr; staff advances 12,000 + 100 = 12,100 Cr. Each side ₹12,98,100.00.
    const tb = await ok<{
      rows: {
        code: string;
        name: string;
        isGroup: boolean;
        depth: number;
        debit: string | null;
        credit: string | null;
      }[];
      debit: string;
      credit: string;
    }>(get(`/tenant/accounts/trial-balance?entityId=${main.id}&asOf=2026-10-31`, manager));
    expect([tb.debit, tb.credit]).toEqual(['1298100.00', '1298100.00']);
    const at = (name: string) => tb.rows.find((r) => r.name === name);
    expect(
      [
        'HDFC Bank 0012',
        'Cash and bank',
        'Sundry debtors',
        'Zilla Parishad Washim',
        'Sundry creditors',
        'Loans and advances',
        'Assets',
        'Equity',
        'Expenses',
      ].map((n) => [n, at(n)?.debit ?? null, at(n)?.credit ?? null]),
    ).toEqual([
      ['HDFC Bank 0012', '836000.00', null],
      ['Cash and bank', '886000.00', null],
      ['Sundry debtors', null, '236000.00'],
      ['Zilla Parishad Washim', null, '236000.00'],
      ['Sundry creditors', null, '50000.00'],
      ['Loans and advances', null, '12100.00'],
      // 8,86,000 + 4,00,000 − 2,36,000 − 12,100
      ['Assets', '1037900.00', null],
      ['Equity', null, '1000000.00'],
      ['Expenses', '12100.00', null],
    ]);
    expect(at('Income')).toMatchObject({ debit: null, credit: null, depth: 0 }); // a top group shows even when nil
    // As at 30 September: only the opening balances, ₹10,50,000 a side.
    const sept = await ok<{ debit: string }>(
      get(`/tenant/accounts/trial-balance?entityId=${main.id}&asOf=2026-09-30`, manager),
    );
    expect(sept.debit).toBe('1050000.00');
    // For the project: the site overheads only.
    const proj = await ok<{
      rows: { name: string; debit: string | null }[];
      debit: string;
      credit: string;
    }>(
      get(
        `/tenant/accounts/trial-balance?entityId=${main.id}&asOf=2026-10-31&projectId=${projectId}`,
        manager,
      ),
    );
    expect([
      proj.debit,
      proj.credit,
      proj.rows.find((r) => r.name === 'Site overheads')?.debit,
    ]).toEqual(['12000.00', '0.00', '12000.00']);

    // The bank's ledger for October: opening 6,00,000; +2,36,000; −50,000; +50,000; closing 8,36,000.
    const led = await ok<{
      opening: string;
      closing: string;
      lines: { number: string; balance: string }[];
    }>(
      get(
        `/tenant/accounts/ledgers/${hdfc}?entityId=${main.id}&from=2026-10-01&to=2026-10-31`,
        manager,
      ),
    );
    expect(led.opening).toBe('600000.00');
    expect(led.lines.map((l) => [l.number, l.balance])).toEqual([
      ['RV/2026-27/0001', '836000.00'],
      ['PV/2026-27/0001', '786000.00'],
      ['PV/2026-27/0002', '836000.00'],
    ]);
    expect(led.closing).toBe('836000.00');
    // The day book from the 5th to the 8th: 2,36,000 + 50,000 + 12,000 + 50,000 = ₹3,48,000.
    const book = await ok<{ vouchers: { number: string }[]; total: string }>(
      get(`/tenant/accounts/day-book?entityId=${main.id}&from=2026-10-05&to=2026-10-08`, manager),
    );
    expect(book.vouchers.map((v) => v.number)).toEqual([
      'RV/2026-27/0001',
      'PV/2026-27/0001',
      'JV/2026-27/0001',
      'PV/2026-27/0002',
    ]);
    expect(book.total).toBe('348000.00');
    // As Excel.
    const x = await app.inject({
      method: 'GET',
      url: `/api/tenant/accounts/trial-balance?entityId=${main.id}&asOf=2026-10-31&format=xlsx`,
      headers: manager,
    });
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const values: unknown[][] = [];
    wb.worksheets[0]!.eachRow((r) => values.push((r.values as unknown[]).slice(1)));
    expect(values).toContainEqual(['A4002', '    HDFC Bank 0012', 836000]);
  });

  it('maps roles to ledgers per company, and replaces the opening balances', async () => {
    const map = await ok<{ roles: { role: string; account: { code: string } | null }[] }>(
      get(`/tenant/accounts/map?entityId=${main.id}`, manager),
    );
    expect(map.roles.find((r) => r.role === 'sales_works_contract')?.account?.code).toBe('I1001');
    expect(map.roles.every((r) => r.account)).toBe(true);
    const office = accounts.get('office_expenses')!;
    expect(
      (
        await post(
          '/tenant/accounts/map',
          { entityId: main.id, role: 'round_off', accountId: office.id },
          manager,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post('/tenant/accounts/map', {
          entityId: main.id,
          role: 'round_off',
          accountId: acct('other_expenses'),
        })
      ).json(),
    ).toMatchObject({ code: 'not_a_ledger' });
    const mapped = await ok<{ roles: { role: string; account: { code: string } }[] }>(
      post('/tenant/accounts/map', { entityId: main.id, role: 'round_off', accountId: office.id }),
    );
    expect(mapped.roles.find((r) => r.role === 'round_off')?.account.code).toBe('X7001');
    // A ledger the map posts to is not closed.
    const chart = await ok<{ accounts: Account[] }>(get('/tenant/accounts/chart', manager));
    const o = chart.accounts.find((a) => a.code === 'X7001')!;
    expect(
      (
        await post(`/tenant/accounts/chart/${o.id}`, {
          parentId: acct('other_expenses'),
          code: 'X7001',
          name: o.name,
          closed: true,
          rowVersion: o.rowVersion,
        })
      ).json(),
    ).toMatchObject({ code: 'mapped_to_role' });

    // New opening balances: the old voucher reversed, the new one posted.
    await ok(
      post(`/tenant/companies/${main.id}/opening`, {
        lines: [
          line({ accountId: acct('capital_account') }, '0', '700000'),
          line({ accountId: hdfc }, '700000', '0'),
        ],
      }),
    );
    const vouchers = await ok<{
      vouchers: { number: string; type: string; isReversal: boolean }[];
    }>(get(`/tenant/accounts/vouchers?entityId=${main.id}&type=opening`, manager));
    expect(vouchers.vouchers.map((v) => [v.number, v.isReversal]).sort()).toEqual([
      ['OB/2025-26/0001', false],
      ['OB/2025-26/0002', true],
      ['OB/2025-26/0003', false],
    ]);
    const sept = await ok<{ debit: string }>(
      get(`/tenant/accounts/trial-balance?entityId=${main.id}&asOf=2026-09-30`, manager),
    );
    expect(sept.debit).toBe('700000.00');
  });
});
