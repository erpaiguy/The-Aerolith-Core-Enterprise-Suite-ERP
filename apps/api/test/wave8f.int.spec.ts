// Wave 8f in a real tenant database (docs/wave8-plan.md): schedule-of-rates tendering — an SOR imported from the
// company's spreadsheet, estimate items citing it, a percentage-rate tender and the item-wise comparative.
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
import ExcelJS from 'exceljs';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { readyTenant } from './helpers/tenant.js';
import { DEFAULT_CRITERIA } from '../src/tender/tender-rules.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)(
  'wave 8f: schedule-of-rates tendering (integration)',
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
        IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-w8f-test-')),
      });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = configureApp(
        moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      t = await readyTenant(app, control, ENC, 'w8f-admin@example.in');
      // Five people: more than a trial's one manager and one worker.
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

    it('prices an estimate from an imported SOR and compares a percentage-rate tender', async () => {
      const db = await app.get(TenantConnections).forTenant(t.tenantId);
      const tender = (
        await ok<{ id: string }>(
          post('/tenant/tenders', { title: 'Approach road, Washim', estimatedValue: '1000000' }),
        )
      ).id;
      const boq = (
        await ok<{ id: string }>(post(`/tenant/tenders/${tender}/boqs`, { name: 'Road' }))
      ).id;
      const item = (
        tempId: string,
        code: string,
        description: string,
        unit: string,
        qty: string,
        afterId: string | null = null,
      ) => ({
        op: 'insert',
        tempId,
        parentId: 'tS',
        afterId,
        type: 'item',
        code,
        description,
        unit,
        qty,
      });
      await ok(
        post(`/tenant/boqs/${boq}/changes`, {
          ops: [
            {
              op: 'insert',
              tempId: 'tS',
              parentId: null,
              afterId: null,
              type: 'section',
              code: '1',
              description: 'Road',
            },
            item('t1', '1.1', 'Excavation in ordinary soil', 'cum', '100'),
            item('t2', '1.2', 'PCC 1:4:8 below the road', 'sqm', '50', 't1'),
          ],
        }),
      );
      const nodes = await db<{ id: string; code: string; line_key: string }[]>`
      SELECT id::text, code, line_key::text FROM est.boq_node WHERE boq_id = ${boq} AND node_type = 'item'
      ORDER BY sort_key`;
      const [l1, l2] = nodes;

      // The company's own copy of the schedule, from its spreadsheet: a chapter heading, two items, one bad row.
      const book = (
        await ok<{ id: string; name: string }[]>(
          post('/tenant/sor-books', {
            name: 'CPWD DSR 2023 (Civil)',
            issuer: 'CPWD',
            edition: '2023',
          }),
        )
      ).find((b) => b.name.startsWith('CPWD'))!.id;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('DSR');
      ws.addRow(['Item No', 'Description of item', 'Unit', 'Rate (Rs)']);
      ws.addRow(['', 'Earth work', '', '']);
      ws.addRow(['2.6.1', 'Excavation in ordinary soil, lead 50 m', 'cum', 250.5]);
      ws.addRow(['4.1.8', 'PCC 1:4:8 with 40 mm aggregate', 'cum', '6,500']);
      ws.addRow(['4.1.9', 'No rate here', 'cum', 'abc']);
      const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
      const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
      const imp = await app.inject({
        method: 'POST',
        url: `/api/tenant/sor-books/${book}/import`,
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dsr.xlsx"\r\n` +
              'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
          ),
          xlsx,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        headers: { ...t.admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(imp.json()).toEqual({
        imported: 2,
        problems: ['Row 5: needs a code, a unit and a rate.'],
      });
      const found = await ok<{ id: string; code: string; chapter: string; rate: string }[]>(
        get('/tenant/sor-items?q=excavation'),
      );
      expect(found.map((x) => [x.code, x.chapter, x.rate])).toEqual([
        ['2.6.1', 'Earth work', '250.5000'],
      ]);
      const pcc = (await ok<{ id: string }[]>(get('/tenant/sor-items?q=4.1.8')))[0]!.id;

      // Cited and priced: the PCC line is in sqm against the schedule's cum, which is shown.
      expect(
        (await post(`/tenant/boqs/${boq}/lines/${l1!.id}/sor`, { sorItemId: found[0]!.id }, worker))
          .statusCode,
      ).toBe(403);
      await ok(post(`/tenant/boqs/${boq}/lines/${l1!.id}/sor`, { sorItemId: found[0]!.id }));
      const cites = await ok<{ sorCode: string; unitDiffers: boolean; rateDiffers: boolean }[]>(
        post(`/tenant/boqs/${boq}/lines/${l2!.id}/sor`, { sorItemId: pcc }),
      );
      expect(cites.map((c) => [c.sorCode, c.unitDiffers, c.rateDiffers])).toEqual([
        ['2.6.1', false, true],
        ['4.1.8', true, true],
      ]);
      const applied = await ok<{ updated: number; citations: { rate: string }[] }>(
        post(`/tenant/boqs/${boq}/sor/apply`, {}),
      );
      expect([applied.updated, ...applied.citations.map((c) => c.rate)]).toEqual([
        2,
        '250.5000',
        '6500.0000',
      ]);

      // A percentage-rate tender, quoted 4.5% below the estimate of ₹10 lakh.
      const mode = await ok<{ quotedValue: string }>(
        post(`/tenant/tenders/${tender}/rate-mode`, { rateMode: 'percentage', quotedPct: '-4.5' }),
      );
      expect(mode.quotedValue).toBe('955000.00');
      await ok(post(`/tenant/tenders/${tender}/status`, { to: 'evaluating' }));
      await ok(
        post(`/tenant/tenders/${tender}/decision`, {
          criteria: DEFAULT_CRITERIA.map((c) => ({ key: c.key, weight: c.weight, score: 4 })),
          decision: 'bid',
        }),
      );
      await ok(
        post(`/tenant/tenders/${tender}/submissions`, {
          submittedAt: new Date().toISOString(),
          mode: 'portal',
          reference: 'MAHATENDERS/4471',
          bidValue: '955000',
        }),
      );
      const work = await ok<{
        bids: { name: string | null; quotedValue: string; quotedPct: string }[];
      }>(
        post(`/tenant/tenders/${tender}/bids`, {
          bids: [
            { us: true, quotedPct: '-4.5' },
            { name: 'Deshmukh Constructions', quotedPct: '-6.2' },
            { name: 'Patil Infra', quotedPct: '1.0' },
          ],
        }),
      );
      expect(work.bids.map((b) => [b.name, b.quotedValue, b.quotedPct])).toEqual([
        ['Deshmukh Constructions', '938000.00', '-6.20'],
        [null, '955000.00', '-4.50'],
        ['Patil Infra', '1010000.00', '1.00'],
      ]);

      // The item-wise comparative: our rates against Deshmukh's.
      const deshmukh = (
        await db<
          { id: string }[]
        >`SELECT id FROM platform.party WHERE name = 'Deshmukh Constructions'`
      )[0]!.id;
      await ok(
        post(`/tenant/tenders/${tender}/item-bids`, {
          rates: [
            { lineKey: l1!.line_key, rate: '240' },
            { lineKey: l2!.line_key, rate: '6200' },
          ],
        }),
      );
      const cmp = await ok<{
        lines: { code: string; lowest: string; lowestBy: string[] }[];
        bidders: { name: string; total: string; rank: number }[];
      }>(
        post(`/tenant/tenders/${tender}/item-bids`, {
          partyId: deshmukh,
          rates: [
            { lineKey: l1!.line_key, rate: '230' },
            { lineKey: l2!.line_key, rate: '6300' },
          ],
        }),
      );
      expect(cmp.lines.map((l) => [l.code, l.lowest, l.lowestBy])).toEqual([
        ['1.1', '230.0000', ['Deshmukh Constructions']],
        ['1.2', '6200.0000', ['Us']],
      ]);
      expect(cmp.bidders.map((b) => [b.name, b.total, b.rank])).toEqual([
        ['Us', '334000.00', 1],
        ['Deshmukh Constructions', '338000.00', 2],
      ]);

      // Percentage tenders so far: ours 1.7 points above the lowest; Deshmukh lowest once.
      const h = await ok<{
        tenders: { ours: string; lowest: string; gap: string }[];
        competitors: { name: string; bids: number; averagePct: string; lowest: number }[];
      }>(get('/tenant/tenders/percentage-history', manager));
      expect(h.tenders.map((x) => [x.ours, x.lowest, x.gap])).toEqual([['-4.50', '-6.20', '1.70']]);
      expect(h.competitors).toEqual([
        { name: 'Deshmukh Constructions', bids: 1, averagePct: '-6.20', lowest: 1 },
        { name: 'Patil Infra', bids: 1, averagePct: '1.00', lowest: 0 },
      ]);
    });
  },
);
