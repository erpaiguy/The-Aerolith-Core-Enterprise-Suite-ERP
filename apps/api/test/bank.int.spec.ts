// Bank reconciliation in a real tenant database (docs/wave3-plan.md step 7), every figure by hand: a September statement
// (CSV, Indian figures) for a bank ledger; suggestions by amount, date and reference; one line matched to two vouchers;
// charges and interest made vouchers in one click; a match undone and made again; the same file refused, a longer
// one taking only its new line; the reconciliation agreeing with the statement's balance.
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

describe.skipIf(!controlUrl || !adminUrl)('bank reconciliation (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-bank-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'bank-admin@example.in');
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
  const id = new Map<string, string>();
  interface Line {
    id: string;
    date: string;
    amount: string;
    match: { id: string; vouchers: { number: string }[] } | null;
    suggestions: { voucherId: string; position: number; number: string; byReference: boolean }[];
  }
  const upload = (name: string, content: string, as: Record<string, string> = manager) => {
    const boundary = '----bank' + Math.random().toString(16).slice(2);
    return app.inject({
      method: 'POST',
      url: `/api/tenant/accounts/bank/${bank}/statements`,
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          `Content-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`,
      ),
      headers: { ...as, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  const statement = () =>
    ok<{ lines: Line[]; book: { number: string; amount: string }[] }>(
      get(
        `/tenant/accounts/bank/${bank}/statement?entityId=${entityId}&from=2026-09-01&to=2026-09-30`,
        manager,
      ),
    );
  const HEAD = 'Txn Date,Description,Ref No,Debit,Credit,Balance\r\n';
  const SEPT =
    HEAD +
    '02/09/2026,NEFT CR UTR778899 SCRAP BUYER,UTR778899,,"1,00,000.00","1,00,000.00"\r\n' +
    '08/09/2026,CHQ PAID 000101,000101,"30,000.00",,"70,000.00"\r\n' +
    '13/09/2026,NEFT BATCH 77,BATCH77,"8,000.00",,"62,000.00"\r\n' +
    '30/09/2026,SMS CHARGES,,59.00,,"61,941.00"\r\n' +
    '30/09/2026,INTEREST CREDIT,,,412.00,"62,353.00"\r\n';

  it('imports a statement by its mapping, once', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Amravati Infra Pvt Ltd',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    for (const a of chart.accounts) id.set(a.code, a.id);
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
    // The books for September: scrap sold for ₹1,00,000 (UTR778899); rent ₹30,000 by cheque 000101; office ₹12,000 by
    // cheque 000102 (not presented in September); ₹5,000 and ₹3,000 in one NEFT batch; a ₹20,000 cheque deposited on
    // the 29th (not credited in September).
    const voucher = (
      type: string,
      date: string,
      reference: string,
      dr: string,
      cr: string,
      amount: string,
    ) =>
      ok(
        post(
          '/tenant/accounts/vouchers',
          {
            entityId,
            type,
            date,
            reference,
            narration: reference,
            lines: [
              { accountId: dr, debit: amount, credit: '0' },
              { accountId: cr, debit: '0', credit: amount },
            ],
          },
          manager,
        ),
      );
    await voucher('receipt', '2026-09-02', 'UTR778899', bank, id.get('I2002')!, '100000');
    await voucher('payment', '2026-09-05', 'CHQ 000101', id.get('X7002')!, bank, '30000');
    await voucher('payment', '2026-09-10', 'CHQ 000102', id.get('X7001')!, bank, '12000');
    await voucher('payment', '2026-09-12', 'NEFT BATCH 77', id.get('X7001')!, bank, '5000');
    await voucher('payment', '2026-09-12', 'NEFT BATCH 77', id.get('X7001')!, bank, '3000');
    await voucher('receipt', '2026-09-29', 'CHQ DEP 5501', bank, id.get('I2002')!, '20000');

    // No mapping yet; then SBI's layout.
    expect((await upload('sept.csv', SEPT)).json()).toMatchObject({ code: 'no_mapping' });
    await ok(
      app.inject({
        method: 'PUT',
        url: `/api/tenant/accounts/bank/${bank}/mapping`,
        headers: manager,
        payload: {
          date: 'Txn Date',
          narration: 'Description',
          reference: 'Ref No',
          withdrawal: 'Debit',
          deposit: 'Credit',
          balance: 'Balance',
          dateFormat: 'DD/MM/YYYY',
        },
      }),
    );
    expect((await upload('sept.csv', SEPT, worker)).statusCode).toBe(403);
    expect(await ok(upload('sept.csv', SEPT))).toMatchObject({
      format: 'table',
      imported: 5,
      skipped: 0,
      from: '2026-09-02',
      to: '2026-09-30',
    });
    expect((await upload('sept.csv', SEPT)).json()).toMatchObject({ code: 'already_imported' });
  });

  it('suggests, matches one line to two vouchers, posts charges, and reconciles', async () => {
    let s = await statement();
    const [utr, chq, batch, charges, interest] = s.lines;
    expect(utr!.suggestions.map((x) => [x.number, x.byReference])).toEqual([
      ['RV/2026-27/0001', true],
    ]);
    expect(chq!.suggestions.map((x) => [x.number, x.byReference])).toEqual([
      ['PV/2026-27/0001', true],
    ]);
    expect(batch!.suggestions).toEqual([]);
    const match = (lineId: string, lines: object[]) =>
      post(`/tenant/accounts/bank-lines/${lineId}/match`, { entityId, lines }, manager);
    const pick = (x: { voucherId: string; position: number }) => ({
      voucherId: x.voucherId,
      position: x.position,
    });
    await ok(match(utr!.id, [pick(utr!.suggestions[0]!)]));
    await ok(match(chq!.id, [pick(chq!.suggestions[0]!)]));
    // The batch: the two NEFT payments together; one alone does not add up.
    const book = (
      await ok<{ book: { voucherId: string; position: number; number: string; amount: string }[] }>(
        get(
          `/tenant/accounts/bank/${bank}/statement?entityId=${entityId}&from=2026-09-01&to=2026-09-30`,
          manager,
        ),
      )
    ).book;
    const neft = book.filter(
      (b) => b.number === 'PV/2026-27/0003' || b.number === 'PV/2026-27/0004',
    );
    expect((await match(batch!.id, [pick(neft[0]!)])).json()).toMatchObject({
      code: 'amounts_differ',
    });
    await ok(match(batch!.id, neft.map(pick)));
    expect((await match(batch!.id, neft.map(pick))).json()).toMatchObject({ code: 'not_open' });
    // Charges and interest, one click each.
    const charge = await ok<{ voucher: { number: string } }>(
      post(
        `/tenant/accounts/bank-lines/${charges!.id}/post`,
        { entityId, accountId: id.get('X5002')!, narration: 'SMS charges' },
        manager,
      ),
    );
    const int = await ok<{ voucher: { number: string } }>(
      post(
        `/tenant/accounts/bank-lines/${interest!.id}/post`,
        { entityId, accountId: id.get('I2001')!, narration: 'Interest on balance' },
        manager,
      ),
    );
    expect([charge.voucher.number, int.voucher.number]).toEqual([
      'PV/2026-27/0005',
      'RV/2026-27/0003',
    ]);

    // A match undone (with a reason) and made again.
    s = await statement();
    expect(s.lines.every((l) => l.match)).toBe(true);
    await ok(
      post(
        `/tenant/accounts/bank-matches/${s.lines[1]!.match!.id}/undo`,
        { reason: 'Wrong cheque' },
        manager,
      ),
    );
    s = await statement();
    expect(s.lines[1]!.match).toBeNull();
    await ok(match(s.lines[1]!.id, [pick(s.lines[1]!.suggestions[0]!)]));

    // As at 30 September: books 1,00,000 − 30,000 − 12,000 − 8,000 + 20,000 − 59 + 412 = 70,353; add cheque 000102 not
    // presented (12,000); less the deposit not credited (20,000): 62,353, the statement's balance.
    const r = await ok<{
      books: string;
      notPresented: { total: string; lines: { reference: string }[] };
      notCredited: { total: string };
      bankOnly: { total: string };
      perBank: string;
      statement: { balance: string; date: string };
      difference: string;
    }>(
      get(
        `/tenant/accounts/bank/${bank}/reconciliation?entityId=${entityId}&asOf=2026-09-30`,
        manager,
      ),
    );
    expect([
      r.books,
      r.notPresented.total,
      r.notPresented.lines.map((l) => l.reference),
      r.notCredited.total,
      r.bankOnly.total,
      r.perBank,
      r.statement,
      r.difference,
    ]).toEqual([
      '70353.00',
      '12000.00',
      ['CHQ 000102'],
      '20000.00',
      '0.00',
      '62353.00',
      { balance: '62353.00', date: '2026-09-30' },
      '0.00',
    ]);

    // October's file repeats September's lines: only the new one is taken.
    expect(
      await ok(
        upload(
          'to-oct.csv',
          SEPT + '03/10/2026,CHQ PAID 000102,000102,"12,000.00",,"50,353.00"\r\n',
        ),
      ),
    ).toMatchObject({ imported: 1, skipped: 5 });
  });
});
