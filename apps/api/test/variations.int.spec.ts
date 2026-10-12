// Variations (docs/wave4-plan.md step 4), worked by hand in a real tenant database: a new item priced from a rate
// analysis and a changed quantity, approved inside the company with no rules, approved by the client for less, the
// frozen contract BOQ revised as VO-001 and its budget moved with it, cost control's changes, and the next RA bill;
// a second variation executed but not approved; a third billed while pending and then rejected, taken back.
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
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('variations (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-vo-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'vo-admin@example.in');
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

  it('prices, approves and carries variations into the contract, its budget and the next bill', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    await ok(
      post(`/tenant/companies/${company.id}`, {
        name: 'Akola Infra Pvt Ltd',
        gstin: '27AAACA1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const zp = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Zilla Parishad Akola',
          gstin: '27AAALZ1234P1Z5',
          address: 'Civil Lines',
          city: 'Akola',
          pincode: '444001',
        }),
      )
    ).id;
    const projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'Hostel, Akola', clientId: zp }, manager),
      )
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/sites`, { name: 'Akola', stateCode: '27' }, manager),
    );
    const boq = async (
      name: string,
      kind: string,
      items: [string, string, string, string, string][],
    ) => {
      const id = (
        await ok<{ id: string }>(
          post(`/tenant/projects/${projectId}/boqs`, { name, kind }, manager),
        )
      ).id;
      await ok(
        post(
          `/tenant/boqs/${id}/changes`,
          {
            ops: [
              {
                op: 'insert',
                tempId: 'tS',
                parentId: null,
                afterId: null,
                type: 'section',
                code: 'A',
                description: 'Works',
              },
              ...items.map(([code, description, unit, qty, rate], i) => ({
                op: 'insert',
                tempId: `t${i}`,
                parentId: 'tS',
                afterId: i ? `t${i - 1}` : null,
                type: 'item',
                code,
                description,
                unit,
                qty,
                rate,
              })),
            ],
          },
          manager,
        ),
      );
      return id;
    };
    // Contract 5,00,000 + 1,20,000 = 6,20,000; budget 4,00,000 + 96,000 = 4,96,000: a markup of 1.25.
    const contract = await boq('Contract', 'contract', [
      ['A.1', 'RCC M25', 'cum', '100', '5000'],
      ['A.2', 'Plaster', 'sqm', '400', '300'],
    ]);
    const budget = await boq('Budget', 'budget', [
      ['A.1', 'RCC M25', 'cum', '100', '4000'],
      ['A.2', 'Plaster', 'sqm', '400', '240'],
    ]);
    await db`UPDATE est.boq_node b SET line_key = c.line_key FROM est.boq_node c
      WHERE b.boq_id = ${budget} AND c.boq_id = ${contract} AND c.code = b.code`;
    // The agreement: the contract BOQ frozen. The original budget taken for cost control.
    await ok(
      post(
        `/tenant/boqs/${contract}/freeze`,
        { kind: 'internal', label: 'Agreement', note: '' },
        manager,
      ),
    );
    await ok(post(`/tenant/projects/${projectId}/cost-control/baseline`, {}, manager));

    // Waterproofing from an analysis: 1.5 kg of compound at ₹200 a sqm = ₹300 cost; at the markup ₹375.
    const wpc = (
      await ok<{ id: string }>(
        post(
          '/tenant/resources',
          {
            code: 'WPC',
            name: 'Waterproofing compound',
            kind: 'material',
            unit: 'kg',
            rate: '200',
            effectiveFrom: '2026-01-01',
          },
          manager,
        ),
      )
    ).id;
    const wp = (
      await ok<{ id: string }>(
        post(
          '/tenant/rate-analyses',
          {
            code: 'WP-1',
            description: 'Waterproofing of terrace',
            unit: 'sqm',
            outputQty: '1',
            lines: [{ kind: 'resource', resourceId: wpc, qty: '1.5', wastagePct: '0' }],
          },
          manager,
        ),
      )
    ).id;
    type V = {
      id: string;
      number: string;
      status: string;
      value: string;
      cost: string;
      approvedValue: string | null;
      rowVersion: number;
      lines: {
        code: string;
        qty: string;
        rate: string;
        costRate: string;
        value: string;
        cost: string;
      }[];
    };
    const raise = (body: object, as = manager) =>
      post(`/tenant/projects/${projectId}/variations`, body, as);
    expect((await raise({ title: 'Nope', source: 'other', lines: [] }, worker)).statusCode).toBe(
      400,
    );
    const vo1 = await ok<V>(
      raise({
        title: 'Terrace waterproofing and extra plaster',
        source: 'client_instruction',
        instructionRef: 'EE/AKL/112',
        reason: "The engineer's instruction of 2 September",
        lines: [
          { kind: 'new', code: 'V.1', description: '', unit: '', qty: '200', rateAnalysisId: wp },
          { kind: 'change', code: 'A.2', qty: '100' },
        ],
      }),
    );
    // V.1: 200 × 375 = 75,000 (cost 200 × 300 = 60,000); A.2: 100 × 300 = 30,000 (cost 100 × 240 = 24,000).
    expect([vo1.number, vo1.status, vo1.value, vo1.cost]).toEqual([
      'VO-001',
      'draft',
      '105000.00',
      '84000.00',
    ]);
    expect(vo1.lines.map((l) => [l.code, l.rate, l.costRate, l.value])).toEqual([
      ['V.1', '375.0000', '300.0000', '75000.00'],
      ['A.2', '300.0000', '240.0000', '30000.00'],
    ]);
    // No approval rules: approved inside at once and with the client.
    const sent = await ok<V>(
      post(`/tenant/variations/${vo1.id}/submit`, { rowVersion: vo1.rowVersion }, manager),
    );
    expect(sent.status).toBe('submitted');
    // The client allows ₹350 for the waterproofing and 80 sqm of plaster: 70,000 + 24,000 = 94,000.
    expect(
      (
        await post(
          `/tenant/variations/${vo1.id}/client`,
          {
            decision: 'approved',
            reference: 'EE/AKL/140',
            date: '2026-09-20',
            rowVersion: sent.rowVersion,
          },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    const done = await ok<V>(
      post(
        `/tenant/variations/${vo1.id}/client`,
        {
          decision: 'approved',
          reference: 'EE/AKL/140',
          date: '2026-09-20',
          rowVersion: sent.rowVersion,
          lines: [
            { position: 1, rate: '350' },
            { position: 2, qty: '80' },
          ],
        },
        manager,
      ),
    );
    expect([done.status, done.approvedValue]).toEqual(['approved', '94000.00']);

    // The contract BOQ: a new revision frozen as VO-001, the new item under Variations, plaster 480.
    const versions = await db<{ version_no: number; label: string }[]>`
      SELECT version_no, label FROM est.boq_version WHERE boq_id = ${contract} ORDER BY version_no`;
    expect(versions.map((v) => [v.version_no, v.label])).toEqual([
      [1, 'Agreement'],
      [2, 'VO-001'],
    ]);
    const lines = async (boqId: string) =>
      Object.fromEntries(
        (
          await db<{ code: string; qty: string; rate: string; line_key: string }[]>`
            SELECT code, qty::text, rate::text, line_key::text FROM est.boq_node
            WHERE boq_id = ${boqId} AND node_type = 'item' ORDER BY sort_key`
        ).map((n) => [n.code, [n.qty, n.rate, n.line_key]]),
      );
    const c = await lines(contract);
    const b = await lines(budget);
    expect([c['V.1']![0], c['V.1']![1], c['A.2']![0]]).toEqual([
      '200.0000',
      '350.0000',
      '480.0000',
    ]);
    // The budget at cost, keyed with the contract.
    expect([b['V.1']![0], b['V.1']![1], b['A.2']![0]]).toEqual([
      '200.0000',
      '300.0000',
      '480.0000',
    ]);
    expect(b['V.1']![2]).toBe(c['V.1']![2]);
    // Cost control: 60,000 + 80 × 240 = 79,200 of approved changes.
    const cc = await ok<{ totals: { original: string; budget: string; changes: string } }>(
      get(`/tenant/projects/${projectId}/cost-control`, manager),
    );
    expect(cc.totals).toMatchObject({
      original: '496000.00',
      budget: '575200.00',
      changes: '79200.00',
    });

    // The next RA bill: 50 sqm of waterproofing at ₹350 and 450 sqm of plaster.
    const nodeId = async (code: string) =>
      (
        await db<
          { id: string }[]
        >`SELECT id::text FROM est.boq_node WHERE boq_id = ${contract} AND code = ${code}`
      )[0]!.id;
    await ok(
      post(
        `/tenant/boqs/${contract}/lines/${await nodeId('V.1')}/progress`,
        { measuredOn: '2026-09-25', qty: '50' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/boqs/${contract}/lines/${await nodeId('A.2')}/progress`,
        { measuredOn: '2026-09-25', qty: '450' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/bill-terms`,
        { rowVersion: null, gstPct: '18', retentionPct: '0' },
        manager,
      ),
    );
    const ra = await ok<{ id: string }>(
      post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-09-30' }, manager),
    );
    const bill = await ok<{
      lines: { code: string; rate: string; cumQty: string; pendingVariation: string | null }[];
      figures?: unknown;
    }>(get(`/tenant/client-bills/${ra.id}`, manager));
    expect(bill.lines.map((l) => [l.code, l.rate, l.cumQty, l.pendingVariation])).toEqual([
      ['A.2', '300.0000', '450.0000', null],
      ['V.1', '350.0000', '50.0000', null],
    ]);

    // VO-002: 10 cum more RCC, submitted, not yet approved; 105 cum measured against 100: executed, ₹50,000 at risk.
    const vo2 = await ok<V>(
      raise({
        title: 'Extra RCC in the lift pit',
        source: 'site_condition',
        lines: [{ kind: 'change', code: 'A.1', qty: '10' }],
      }),
    );
    await ok(post(`/tenant/variations/${vo2.id}/submit`, { rowVersion: vo2.rowVersion }, manager));
    await ok(
      post(
        `/tenant/boqs/${contract}/lines/${await nodeId('A.1')}/progress`,
        { measuredOn: '2026-09-28', qty: '105' },
        manager,
      ),
    );

    // VO-003, with billing while pending allowed: railing goes into the BOQs on submission, and is marked pending.
    await ok(
      post(`/tenant/projects/${projectId}/variations/settings`, { billPending: true }, manager),
    );
    const vo3 = await ok<V>(
      raise({
        title: 'Terrace railing',
        source: 'design_change',
        lines: [
          {
            kind: 'new',
            code: 'V.2',
            description: 'MS railing',
            unit: 'm',
            qty: '20',
            rate: '1000',
            costRate: '800',
          },
        ],
      }),
    );
    const vo3s = await ok<V>(
      post(`/tenant/variations/${vo3.id}/submit`, { rowVersion: vo3.rowVersion }, manager),
    );
    expect((await lines(contract))['V.2']!.slice(0, 2)).toEqual(['20.0000', '1000.0000']);
    expect((await lines(budget))['V.2']!.slice(0, 2)).toEqual(['20.0000', '800.0000']);
    const reg = await ok<{
      variations: { number: string; status: string; executedNotApproved: boolean }[];
      totals: Record<string, { count: number; value: string }>;
      atRisk: string;
    }>(get(`/tenant/projects/${projectId}/variations`, manager));
    expect(reg.variations.map((v) => [v.number, v.status, v.executedNotApproved])).toEqual([
      ['VO-001', 'approved', false],
      ['VO-002', 'submitted', true],
      ['VO-003', 'submitted', false],
    ]);
    expect(reg.totals).toEqual({
      approved: { count: 1, value: '94000.00' },
      submitted: { count: 2, value: '70000.00' },
    });
    expect(reg.atRisk).toBe('50000.00');
    // Rejected: the railing, never measured, comes out of both BOQs.
    await ok(
      post(
        `/tenant/variations/${vo3.id}/client`,
        {
          decision: 'rejected',
          reference: 'EE/AKL/151',
          date: '2026-10-01',
          rowVersion: vo3s.rowVersion,
        },
        manager,
      ),
    );
    expect((await lines(contract))['V.2']).toBeUndefined();
    expect((await lines(budget))['V.2']).toBeUndefined();
  });
});
