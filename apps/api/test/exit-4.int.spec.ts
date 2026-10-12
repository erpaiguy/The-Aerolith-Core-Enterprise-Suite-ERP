// The exit check for Wave 4 (docs/wave4-plan.md step 7), in a real tenant database: a pilot project's monthly review run
// from the app — planned against actual against forecast, earned value, cash flow, variations, contracts and the risk
// register — with its figures cross-checked between the services that work them; the portfolio across two projects;
// the MEP pack loaded once, equipment commissioned only on a passed checklist, and a clash raised and resolved.
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

describe.skipIf(!controlUrl || !adminUrl)(
  'Wave 4 exit check and the MEP pack (integration)',
  () => {
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
        IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-exit4-test-')),
      });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = configureApp(
        moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      t = await readyTenant(app, control, ENC, 'exit4-admin@example.in');
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

    it("runs a pilot project's monthly review, the portfolio, and the MEP pack", async () => {
      const db = await app.get(TenantConnections).forTenant(t.tenantId);
      const company = (
        await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
      ).companies[0]!;
      const entityId = company.id;
      await ok(
        post(`/tenant/companies/${entityId}`, {
          name: 'Akola Infra Pvt Ltd',
          gstin: '27AAACA1234K1Z2',
          booksFrom: '2026-04-01',
          rowVersion: company.rowVersion,
        }),
      );
      const chart = await ok<{ accounts: { id: string; code: string }[] }>(
        get('/tenant/accounts/chart', manager),
      );
      const acct = (c: string) => chart.accounts.find((a) => a.code === c)!.id;
      const project = async (name: string) =>
        (await ok<{ id: string }>(post('/tenant/projects', { name }, manager))).id;
      const pilot = await project('Hostel, Akola');
      const other = await project('Depot, Washim');
      const boq = async (
        projectId: string,
        kind: string,
        items: [string, string, string, string][],
      ) => {
        const id = (
          await ok<{ id: string }>(
            post(`/tenant/projects/${projectId}/boqs`, { name: kind, kind }, manager),
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
                ...items.map(([code, unit, qty, rate], i) => ({
                  op: 'insert',
                  tempId: `t${i}`,
                  parentId: 'tS',
                  afterId: i ? `t${i - 1}` : null,
                  type: 'item',
                  code,
                  description: code,
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
      // The pilot: contract 10,00,000 (A.1 100 cum × 6,000, A.2 400 sqm × 1,000); budget 8,00,000 on the same lines.
      const contract = await boq(pilot, 'contract', [
        ['A.1', 'cum', '100', '6000'],
        ['A.2', 'sqm', '400', '1000'],
      ]);
      const budget = await boq(pilot, 'budget', [
        ['A.1', 'cum', '100', '4800'],
        ['A.2', 'sqm', '400', '800'],
      ]);
      await db`UPDATE est.boq_node b SET line_key = c.line_key FROM est.boq_node c
      WHERE b.boq_id = ${budget} AND c.boq_id = ${contract} AND c.code = b.code`;
      await ok(post(`/tenant/projects/${pilot}/cost-control/baseline`, {}, manager));
      await boq(other, 'contract', [['B.1', 'cum', '10', '10000']]);

      // September: 50 cum of A.1 measured (EV at budget 2,40,000); ₹2,60,000 spent.
      const node = async (code: string) =>
        (
          await db<
            { id: string }[]
          >`SELECT id::text FROM est.boq_node WHERE boq_id = ${contract} AND code = ${code}`
        )[0]!.id;
      await ok(
        post(
          `/tenant/boqs/${contract}/lines/${await node('A.1')}/progress`,
          { measuredOn: '2026-09-20', qty: '50' },
          manager,
        ),
      );
      await ok(
        post(
          '/tenant/accounts/vouchers',
          {
            entityId,
            type: 'journal',
            date: '2026-09-25',
            lines: [
              { accountId: acct('X2002'), debit: '260000', projectId: pilot },
              { accountId: acct('L4004'), credit: '260000' },
            ],
          },
          manager,
        ),
      );
      // A variation: 50 sqm more plaster (₹50,000, cost ₹40,000), approved by the client.
      const vo = await ok<{ id: string; rowVersion: number }>(
        post(
          `/tenant/projects/${pilot}/variations`,
          {
            title: 'Extra plaster, stair core',
            source: 'client_instruction',
            lines: [{ kind: 'change', code: 'A.2', qty: '50' }],
          },
          manager,
        ),
      );
      const sent = await ok<{ rowVersion: number }>(
        post(`/tenant/variations/${vo.id}/submit`, { rowVersion: vo.rowVersion }, manager),
      );
      await ok(
        post(
          `/tenant/variations/${vo.id}/client`,
          {
            decision: 'approved',
            reference: 'EE/140',
            date: '2026-09-28',
            rowVersion: sent.rowVersion,
          },
          manager,
        ),
      );
      // A risk that occurred, with ₹30,000 of ₹1,00,000 contingency drawn; a contract with its guarantee.
      const risk = await ok<{ id: string }>(
        post(
          `/tenant/projects/${pilot}/risks`,
          {
            category: 'design',
            event: 'Drawings late for block B',
            probability: 4,
            impact: 3,
            costImpact: '60000',
            status: 'occurred',
          },
          manager,
        ),
      );
      await ok(post(`/tenant/projects/${pilot}/contingency`, { held: '100000' }, manager));
      await ok(
        post(`/tenant/risks/${risk.id}/draws`, { amount: '30000', date: '2026-09-29' }, manager),
      );
      await ok(
        post(
          `/tenant/projects/${pilot}/risks`,
          {
            category: 'commercial',
            event: 'Steel prices rise',
            probability: 3,
            impact: 4,
            costImpact: '80000',
          },
          manager,
        ),
      );
      const c = await ok<{ id: string }>(
        post(
          `/tenant/projects/${pilot}/contracts`,
          {
            kind: 'client',
            reference: 'ZP/14',
            title: 'Hostel works',
            value: '1000000',
            completionOn: '2027-03-31',
          },
          manager,
        ),
      );
      await ok(
        post(
          `/tenant/contracts/${c.id}/obligations`,
          { title: 'Monthly progress report', dueOn: '2026-10-05' },
          manager,
        ),
      );

      // The monthly review for September.
      const r = await ok<{
        asOf: string;
        summary: Record<string, unknown>;
        cost: { totals: Record<string, string> };
        earnedValue: { ev: string; ac: string; bac: string; cpi: string | null };
        cash: { month: { in: string; out: string } };
        variations: { totals: Record<string, { count: number; value: string }> };
        risks: {
          contingency: { held: string; drawn: string; remaining: string };
          openExpectedValue: string;
          top: { number: string }[];
        };
        contracts: { calendar: { what: string }[] };
      }>(get(`/tenant/projects/${pilot}/review?month=2026-09`, manager));
      expect(r.asOf).toBe('2026-09-30');
      // Planned, actual, forecast: budget 8,00,000 + the variation's 40,000; 2,60,000 spent.
      expect(r.cost.totals).toMatchObject({
        original: '800000.00',
        changes: '40000.00',
        budget: '840000.00',
        actual: '260000.00',
      });
      // Earned value agrees with cost control: AC is the same ledger, BAC the same budget. EV 50 × 4,800 = 2,40,000;
      // CPI 2,40,000 ÷ 2,60,000 = 0.9231.
      expect(r.earnedValue).toMatchObject({
        ac: r.cost.totals.actual,
        bac: r.cost.totals.budget,
        ev: '240000.00',
        cpi: '0.9231',
      });
      // Cash out in September is the journal? No: a journal moves no cash. Nothing paid, nothing received.
      expect(r.cash.month).toEqual({ in: '0.00', out: '0.00' });
      expect(r.variations.totals).toEqual({ approved: { count: 1, value: '50000.00' } });
      // Contingency remaining = held − drawn; open risk value = 50% × 80,000.
      expect(r.risks.contingency).toMatchObject({
        held: '100000.00',
        drawn: '30000.00',
        remaining: '70000.00',
      });
      expect(r.risks.openExpectedValue).toBe('40000.00');
      expect(r.contracts.calendar.map((x) => x.what)).toEqual(['Monthly progress report']);
      // The tender margin: contract less approved variations (10,00,000) against the original budget (8,00,000).
      expect(r.summary).toMatchObject({
        contract: '1050000.00',
        tenderMargin: '200000.00',
        tenderMarginPct: '20.0',
      });

      // The portfolio: both projects, with totals.
      const pf = await ok<{
        tiles: { project: { id: string }; contract: string }[];
        totals: { contract: string };
      }>(get('/tenant/portfolio?asOf=2026-09-30', manager));
      expect(pf.tiles.map((x) => [x.project.id, x.contract])).toEqual([
        [pilot, '1050000.00'],
        [other, '100000.00'],
      ]);
      expect(pf.totals.contract).toBe('1150000.00');

      // The MEP pack (not for a worker): five BOQ templates and five checklists, then nothing more the second time.
      expect((await post('/tenant/mep-pack', {}, worker)).statusCode).toBe(403);
      const first = await ok<{ boqTemplates: string[]; checklists: string[] }>(
        post('/tenant/mep-pack', {}, manager),
      );
      expect([first.boqTemplates.length, first.checklists.length]).toEqual([5, 5]);
      expect(await ok(post('/tenant/mep-pack', {}, manager))).toEqual({
        boqTemplates: [],
        checklists: [],
      });
      // An AHU on the schedule; commissioned only on a passed T&C checklist.
      let mep = await ok<{ equipment: { id: string; status: string; rowVersion: number }[] }>(
        post(
          `/tenant/projects/${pilot}/mep/equipment`,
          {
            tag: 'AHU-01',
            system: 'hvac',
            description: 'Air handling unit, 8,000 cfm',
            capacity: '8000 cfm',
            location: 'Terrace',
          },
          manager,
        ),
      );
      const ahu = mep.equipment[0]!;
      const [tnc] = await db<
        { id: string }[]
      >`SELECT id FROM qa.checklist_template WHERE name = 'T&C: HVAC'`;
      const checklist = async (answers: unknown[]) =>
        await ok<{ id: string; result: string }>(
          post(
            `/tenant/projects/${pilot}/checklists`,
            {
              templateId: tnc!.id,
              doneOn: '2026-10-01',
              location: 'AHU-01',
              answers: answers.map((answer) => ({ answer })),
            },
            manager,
          ),
        );
      const failed = await checklist(['yes', 'yes', 19, 'yes', 'yes']);
      expect(failed.result).toBe('failed');
      expect(
        (
          await post(
            `/tenant/mep-equipment/${ahu.id}/status`,
            { status: 'commissioned', checklistId: failed.id, rowVersion: ahu.rowVersion },
            manager,
          )
        ).json(),
      ).toMatchObject({ code: 'checklist_failed' });
      const passed = await checklist(['yes', 'yes', 14, 'yes', 'yes']);
      mep = await ok(
        post(
          `/tenant/mep-equipment/${ahu.id}/status`,
          { status: 'commissioned', checklistId: passed.id, rowVersion: ahu.rowVersion },
          manager,
        ),
      );
      expect(mep.equipment[0]!.status).toBe('commissioned');
      // A clash: the duct against the beam at grid C4, resolved by dropping the duct.
      const issues = await ok<{ issues: { id: string; number: string; status: string }[] }>(
        post(
          `/tenant/projects/${pilot}/mep/issues`,
          {
            systems: ['hvac', 'electrical'],
            location: 'Grid C4, first floor',
            description: 'Supply duct clashes with the cable tray under the beam',
            raisedOn: '2026-10-02',
          },
          manager,
        ),
      );
      const resolved = await ok<{ issues: { number: string; status: string }[] }>(
        post(
          `/tenant/coordination-issues/${issues.issues[0]!.id}/resolve`,
          { resolution: 'Duct dropped 150 mm, tray moved to the corridor side', on: '2026-10-03' },
          manager,
        ),
      );
      expect(resolved.issues.map((i) => [i.number, i.status])).toEqual([['CI-001', 'resolved']]);
    });
  },
);
