// Rate library and rate analysis in a real tenant database: dated resource rates, price-book import, analyses with
// sub-analyses and additions, cycles, and BOQ items priced from analyses (apply, unlink, refresh with totals).
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
import type { BoqRow } from '../src/boq/boq.service.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { boqInvariants } from './helpers/boq.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('rates (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let importDir: string;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let tenderId: string;
  let worker: Record<string, string>;
  let manager: Record<string, string>;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const newBoq = async (name: string) =>
    (await post(`/tenant/tenders/${tenderId}/boqs`, { name })).json<{ id: string }>().id;

  const upload = (
    url: string,
    fileName: string,
    content: Buffer | string,
    headers: Record<string, string> = t.admin,
  ) => {
    const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: `/api${url}`,
      payload,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  const allRows = async (boqId: string) => {
    const out: BoqRow[] = [];
    let after: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ limit: '500' });
      if (after) qs.set('after', after);
      const page = (await get(`/tenant/boqs/${boqId}/rows?${qs}`)).json<{
        rows: BoqRow[];
        hasMore: boolean;
      }>();
      out.push(...page.rows);
      if (!page.hasMore || page.rows.length === 0) return out;
      after = page.rows.at(-1)!.sortKey;
    }
  };
  const header = async (boqId: string) =>
    (await get(`/tenant/boqs/${boqId}`)).json<{
      total: string;
      nodeCount: number;
      itemCount: number;
    }>();

  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ temporaryPassword: string }>();
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
    return { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` };
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
    importDir = await mkdtemp(join(tmpdir(), 'aerolith-import-test-'));
    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      CONTROL_PLANE_ENC_KEY: ENC.toString('base64'),
      LOCAL_PG_ADMIN_URL: adminUrl,
      RATE_LIMIT_SCALE: '200',
      PUBLIC_API_URL: 'https://api.example.in',
      IMPORT_DIR: importDir,
      IMPORT_MAX_MB: '2',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'rates-admin@example.in');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    tenderId = (await post('/tenant/tenders', { title: 'Community hall, Nagpur' })).json<{
      id: string;
    }>().id;
    worker = await staff('suresh', 'worker');
    manager = await staff('meena', 'manager');
  }, 90_000);

  afterAll(async () => {
    delete process.env.IMPORT_DIR;
    delete process.env.IMPORT_MAX_MB;
    await app?.close();
    await control?.end();
    await server?.end();
  });

  interface Resource {
    id: string;
    code: string;
    rate: string | null;
    rateFrom: string | null;
    rowVersion: number;
    rates: { effectiveFrom: string; rate: string; source: string }[];
  }
  interface Analysis {
    id: string;
    code: string;
    rowVersion: number;
    costing: {
      unitRate: string;
      boqRate: string;
      subtotal: string;
      total: string;
      byKind: Record<string, string>;
      additions: { label: string; amount: string }[];
      missing: { code: string }[];
    };
    boqs: { id: string; items: number }[];
  }
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  const ids: Record<string, string> = {};
  const resource = async (
    code: string,
    kind: string,
    unit: string,
    rate: string,
    effectiveFrom = '2026-04-01',
  ) => {
    const r = await ok<Resource>(
      post('/tenant/resources', { code, name: code, kind, unit, rate, effectiveFrom }),
    );
    ids[code] = r.id;
    return r;
  };
  const R = (code: string, qty: string, wastagePct = '0') => ({
    kind: 'resource',
    resourceId: ids[code],
    qty,
    wastagePct,
  });
  const PCC = () => ({
    code: 'PCC-148',
    description: 'PCC 1:4:8 with 40 mm graded stone aggregate',
    unit: 'cum',
    outputQty: '1',
    additions: [
      { label: 'Water charges', pct: '1' },
      { label: "Contractor's profit and overheads", pct: '15' },
    ],
    lines: [
      R('CEM', '3.4', '2'),
      R('AGG40', '0.94'),
      R('SAND', '0.47'),
      R('MASON', '0.1'),
      R('BELDAR', '1.63'),
      R('MIXER', '0.07'),
      { kind: 'lump_sum', description: 'Sundries', amount: '20' },
    ],
  });

  describe('resources', () => {
    it('keeps dated rates and answers "the rate on a date"', async () => {
      await resource('CEM', 'material', 'bag', '380', '2026-04-01');
      const cem = await ok<Resource>(
        post(`/tenant/resources/${ids.CEM}/rates`, {
          effectiveFrom: '2026-07-01',
          rate: '400',
          source: 'Dealer quote 14/2026',
        }),
      );
      expect(cem.rates.map((r) => [r.effectiveFrom, r.rate])).toEqual([
        ['2026-07-01', '400.0000'],
        ['2026-04-01', '380.0000'],
      ]);
      const on = async (asOf: string) =>
        (await ok<{ items: Resource[] }>(get(`/tenant/resources?q=CEM&asOf=${asOf}`))).items[0]!
          .rate;
      expect(await on('2026-03-31')).toBeNull();
      expect(await on('2026-05-15')).toBe('380.0000');
      expect(await on('2026-07-01')).toBe('400.0000');

      for (const [code, kind, unit, rate] of [
        ['AGG40', 'material', 'cum', '1500'],
        ['SAND', 'material', 'cum', '1800'],
        ['MASON', 'labour', 'day', '900'],
        ['BELDAR', 'labour', 'day', '650'],
        ['MIXER', 'equipment', 'day', '1200'],
        ['BRICK', 'material', 'nos', '8'],
      ] as const)
        await resource(code, kind, unit, rate);
    });

    it('refuses duplicate codes (any case), lets workers read and managers edit', async () => {
      const dup = await post('/tenant/resources', {
        code: 'cem',
        name: 'Cement again',
        kind: 'material',
        unit: 'bag',
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ code: 'code_taken' });
      expect((await get('/tenant/resources', worker)).statusCode).toBe(200);
      expect(
        (
          await post(
            '/tenant/resources',
            { code: 'X1', name: 'x', kind: 'other', unit: 'nos' },
            worker,
          )
        ).statusCode,
      ).toBe(403);
      const tmp = await ok<Resource>(
        post(
          '/tenant/resources',
          { code: 'TMP', name: 'Temp', kind: 'other', unit: 'nos' },
          manager,
        ),
      );
      const upd = await ok<Resource & { name: string }>(
        post(
          `/tenant/resources/${tmp.id}`,
          { rowVersion: tmp.rowVersion, name: 'Temporary works' },
          manager,
        ),
      );
      expect(upd.name).toBe('Temporary works');
      const stale = await post(`/tenant/resources/${tmp.id}`, {
        rowVersion: tmp.rowVersion,
        name: 'x',
      });
      expect(stale.statusCode).toBe(409);
      // Masters are archived, never deleted.
      await expect(db`DELETE FROM est.resource WHERE id = ${tmp.id}`).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('price books', () => {
    const csv =
      'Price list Oct 2026\n' +
      'Code,Description,Type,Unit,Rate (₹),W.e.f.\n' +
      'STL-TMT12,TMT bar 12 mm,Material,kg,72.50,01-10-2026\n' +
      'STL-TMT16,TMT bar 16 mm,material,kg,"71.00",01-10-2026\n' +
      'CARP,Carpenter,Labour,day,950,\n' +
      'CEM,Cement OPC 43,Material,bag,400,01-07-2026\n' +
      'BAD1,Bad rate,Material,kg,abc,\n' +
      'BAD2,Bad type,Furniture,kg,10,\n' +
      'STL-TMT12,Duplicate,Material,kg,73,\n';

    it('checks a price book without changing anything', async () => {
      const r = await ok<Record<string, unknown>>(
        upload(
          '/tenant/resources/price-book?dryRun=true&effectiveFrom=2026-10-01',
          'prices.csv',
          csv,
        ),
      );
      expect(r).toMatchObject({
        dryRun: true,
        headerRow: 2,
        rows: 7,
        created: 3,
        updated: 1, // CEM: name changes from "CEM" to "Cement OPC 43"
        rates: 3, // CEM's 400 is already in force on 2026-07-01
        unchanged: 0,
        errors: 3,
      });
      expect((r.issues as { message: string }[]).map((i) => i.message)).toEqual([
        'BAD1: rate "abc" is not a number',
        'BAD2: type "Furniture" must be material, labour, equipment, subcontract or other',
        'STL-TMT12: also on row 3',
      ]);
      expect((await ok<{ total: number }>(get('/tenant/resources?q=TMT'))).total).toBe(0);
    });

    it('applies it, and a second identical import changes nothing', async () => {
      const r = await ok<Record<string, unknown>>(
        upload(
          '/tenant/resources/price-book?dryRun=false&effectiveFrom=2026-10-01',
          'prices.csv',
          csv,
        ),
      );
      expect(r).toMatchObject({ created: 3, updated: 1, rates: 3 });
      const tmt = await ok<{ items: Resource[] }>(get('/tenant/resources?q=TMT&asOf=2026-10-15'));
      expect(tmt.items.map((i) => [i.code, i.rate, i.rateFrom])).toEqual([
        ['STL-TMT12', '72.5000', '2026-10-01'],
        ['STL-TMT16', '71.0000', '2026-10-01'],
      ]);
      const carp = await ok<{ items: (Resource & { kind: string })[] }>(
        get('/tenant/resources?q=CARP'),
      );
      expect(carp.items[0]).toMatchObject({ kind: 'labour' }); // no date in the row: the default date applies
      const again = await ok<Record<string, unknown>>(
        upload(
          '/tenant/resources/price-book?dryRun=false&effectiveFrom=2026-10-01',
          'prices.csv',
          csv,
        ),
      );
      expect(again).toMatchObject({ created: 0, updated: 0, rates: 0, unchanged: 4 });
    });

    it('explains a sheet it cannot read', async () => {
      const r = await upload('/tenant/resources/price-book', 'x.csv', 'Item,Qty\nA,1\n');
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ code: 'no_header' });
      expect(
        (await upload('/tenant/resources/price-book', 'x.csv', 'Code,Name,Rate\n', worker))
          .statusCode,
      ).toBe(403);
    });
  });

  describe('rate analyses', () => {
    let pcc: Analysis;

    it('costs an analysis on a date, by kind, with additions', async () => {
      pcc = await ok<Analysis>(post('/tenant/rate-analyses', PCC()));
      // Created "today" (after July): cement at 400.
      expect(pcc.costing).toMatchObject({
        subtotal: '4896.70',
        unitRate: '5687.5171',
        boqRate: '5687.52',
        byKind: {
          material: '3643.2000',
          labour: '1149.5000',
          equipment: '84.0000',
          other: '20.0000',
        },
        missing: [],
      });
      expect(pcc.costing.additions.map((a) => a.amount)).toEqual(['48.97', '741.85']);
      // In May cement was 380: 3.468 bags × 20 less, plus 16.15 % on top.
      const may = await ok<Analysis>(get(`/tenant/rate-analyses/${pcc.id}?asOf=2026-05-01`));
      expect(may.costing.subtotal).toBe('4827.34');
      // Before any cement rate: reported, not silently cheap.
      const march = await ok<Analysis>(get(`/tenant/rate-analyses/${pcc.id}?asOf=2026-03-01`));
      expect(march.costing.missing.map((m) => m.code)).toEqual([
        'CEM',
        'AGG40',
        'SAND',
        'MASON',
        'BELDAR',
        'MIXER',
      ]);
      const list = await ok<{ items: { code: string; boqRate: string; missing: number }[] }>(
        get('/tenant/rate-analyses?q=PCC'),
      );
      expect(list.items).toEqual([
        expect.objectContaining({ code: 'PCC-148', boqRate: '5687.52', missing: 0 }),
      ]);
    });

    it('nests analyses and refuses cycles', async () => {
      const mortar = await ok<Analysis>(
        post('/tenant/rate-analyses', {
          code: 'MORTAR-16',
          description: 'Cement mortar 1:6',
          unit: 'cum',
          outputQty: '1',
          lines: [R('CEM', '4.4'), R('SAND', '1.2')],
        }),
      );
      expect(mortar.costing.unitRate).toBe('3920.0000');
      const brick = await ok<Analysis>(
        post('/tenant/rate-analyses', {
          code: 'BW-16',
          description: 'Brickwork in cement mortar 1:6',
          unit: 'cum',
          outputQty: '10',
          additions: [{ label: 'Profit and overheads', pct: '15' }],
          lines: [
            R('BRICK', '5000'),
            { kind: 'analysis', subAnalysisId: mortar.id, qty: '2.5' },
            R('MASON', '7'),
          ],
        }),
      );
      expect(brick.costing.unitRate).toBe('6451.5000');

      // Making the mortar use the brickwork would loop.
      const cycle = await post(`/tenant/rate-analyses/${mortar.id}`, {
        rowVersion: mortar.rowVersion,
        code: 'MORTAR-16',
        description: 'Cement mortar 1:6',
        unit: 'cum',
        outputQty: '1',
        lines: [R('CEM', '4.4'), { kind: 'analysis', subAnalysisId: brick.id, qty: '1' }],
      });
      expect(cycle.statusCode).toBe(409);
      expect(cycle.json()).toMatchObject({
        code: 'analysis_cycle',
        path: ['MORTAR-16', 'BW-16', 'MORTAR-16'],
      });
      // Nothing changed.
      const still = await ok<Analysis>(get(`/tenant/rate-analyses/${mortar.id}`));
      expect(still.costing.unitRate).toBe('3920.0000');

      const unknown = await post('/tenant/rate-analyses', {
        code: 'X',
        description: 'x',
        unit: 'nos',
        outputQty: '1',
        lines: [{ kind: 'resource', resourceId: '00000000-0000-4000-8000-000000000000', qty: '1' }],
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toMatchObject({ code: 'unknown_reference' });
      expect((await post('/tenant/rate-analyses', PCC(), worker)).statusCode).toBe(403);
    });

    it('previews an unsaved analysis, including an edit that would create a cycle', async () => {
      const preview = await ok<Analysis['costing']>(
        post('/tenant/rate-analyses/preview', PCC(), worker),
      );
      expect(preview).toMatchObject({ boqRate: '5687.52', subtotal: '4896.70' });
      const may = await ok<Analysis['costing']>(
        post('/tenant/rate-analyses/preview?asOf=2026-05-01', PCC()),
      );
      expect(may.boqRate).toBe('5606.96');
      const list = await ok<{ items: { id: string; code: string }[] }>(
        get('/tenant/rate-analyses'),
      );
      const mortar = list.items.find((i) => i.code === 'MORTAR-16')!;
      const brick = list.items.find((i) => i.code === 'BW-16')!;
      const cyc = await post(`/tenant/rate-analyses/preview?id=${mortar.id}`, {
        code: 'MORTAR-16',
        description: 'Cement mortar 1:6',
        unit: 'cum',
        outputQty: '1',
        lines: [{ kind: 'analysis', subAnalysisId: brick.id, qty: '1' }],
      });
      expect(cyc.statusCode).toBe(409);
      expect(cyc.json()).toMatchObject({ code: 'analysis_cycle' });
    });

    it('copies an analysis under a new code', async () => {
      const copy = await ok<Analysis>(
        post(`/tenant/rate-analyses/${pcc.id}/copy`, { code: 'PCC-148-B' }),
      );
      expect(copy.costing.unitRate).toBe('5687.5171');
      expect(
        (await post(`/tenant/rate-analyses/${pcc.id}/copy`, { code: 'pcc-148' })).statusCode,
      ).toBe(409);
    });
  });

  describe('BOQ items priced from analyses', () => {
    let boqId: string;
    let itemId: string;
    const changes = (ops: object[]) =>
      ok<{ rows: (BoqRow & { rateAnalysisId: string | null })[]; idMap: Record<string, string> }>(
        post(`/tenant/boqs/${boqId}/changes`, { ops }),
      );

    it('applies an analysis to a new item: rate, unit and description as on the BOQ rate date', async () => {
      boqId = await newBoq('Civil');
      const h = await ok<{ rowVersion: number; rateDate: string }>(get(`/tenant/boqs/${boqId}`));
      await ok(post(`/tenant/boqs/${boqId}`, { rowVersion: h.rowVersion, rateDate: '2026-05-01' }));
      const r = await changes([
        {
          op: 'insert',
          tempId: 'ts',
          parentId: null,
          afterId: null,
          type: 'section',
          description: 'Concrete',
        },
        {
          op: 'insert',
          tempId: 'ti',
          parentId: 'ts',
          afterId: null,
          type: 'item',
          qty: '10',
          rateAnalysisId: ids.PCC ?? (await pccId()),
        },
      ]);
      itemId = r.idMap.ti!;
      const item = r.rows.find((x) => x.id === itemId)!;
      // May: cement at 380.
      expect(item).toMatchObject({
        unit: 'cum',
        description: 'PCC 1:4:8 with 40 mm graded stone aggregate',
        rateAnalysisId: await pccId(),
      });
      // 4827.34 × 1.01 × 1.15 = 5606.95541 per cum
      expect(item.rate).toBe('5606.9600');
      expect((await header(boqId)).total).toBe('56069.60');
    });

    it('refuses an analysis priced in another unit, or with missing rates on the rate date', async () => {
      const wrong = await post(`/tenant/boqs/${boqId}/changes`, {
        ops: [
          {
            op: 'insert',
            tempId: 'tw',
            parentId: null,
            afterId: null,
            type: 'item',
            unit: 'sqm',
            rateAnalysisId: await pccId(),
          },
        ],
      });
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json()).toMatchObject({ code: 'unit_mismatch' });
      // "Cu.M" is the same unit as "cum".
      const same = await changes([
        {
          op: 'insert',
          tempId: 'tc',
          parentId: null,
          afterId: null,
          type: 'item',
          unit: 'Cu.M',
          qty: '1',
          rateAnalysisId: await pccId(),
        },
      ]);
      const extra = same.rows.find((x) => x.id === same.idMap.tc)!;
      await changes([{ op: 'delete', id: extra.id, rowVersion: extra.rowVersion }]);
    });

    it('unlinks when a rate is typed by hand', async () => {
      const [row] = (await allRows(boqId)).filter((x) => x.id === itemId);
      const r = await changes([
        { op: 'update', id: itemId, rowVersion: row!.rowVersion, rate: '6000' },
      ]);
      expect(r.rows.find((x) => x.id === itemId)).toMatchObject({
        rate: '6000.0000',
        rateAnalysisId: null,
      });
      const relinked = await changes([
        {
          op: 'update',
          id: itemId,
          rowVersion: row!.rowVersion + 1,
          rateAnalysisId: await pccId(),
        },
      ]);
      expect(relinked.rows.find((x) => x.id === itemId)).toMatchObject({ rate: '5606.9600' });
    });

    it('refreshes linked rates when the rate date moves, keeping every total consistent', async () => {
      const h = await ok<{ rowVersion: number }>(get(`/tenant/boqs/${boqId}`));
      await ok(post(`/tenant/boqs/${boqId}`, { rowVersion: h.rowVersion, rateDate: '2026-08-01' }));
      const r = await ok<{ changed: number; linked: number; header: { total: string } }>(
        post(`/tenant/boqs/${boqId}/refresh-rates`),
      );
      expect(r).toMatchObject({ linked: 1, changed: 1, header: { total: '56875.20' } });
      expect(await boqInvariants(db, boqId)).toEqual([]);
      const again = await ok<{ changed: number }>(post(`/tenant/boqs/${boqId}/refresh-rates`));
      expect(again.changed).toBe(0);

      // Back before any rates: refused, nothing changed.
      const h2 = await ok<{ rowVersion: number }>(get(`/tenant/boqs/${boqId}`));
      await ok(
        post(`/tenant/boqs/${boqId}`, { rowVersion: h2.rowVersion, rateDate: '2026-01-01' }),
      );
      const early = await post(`/tenant/boqs/${boqId}/refresh-rates`);
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({ code: 'missing_rates' });
      expect((await header(boqId)).total).toBe('56875.20');

      // The analysis knows where it is used.
      const a = await ok<Analysis>(get(`/tenant/rate-analyses/${await pccId()}`));
      expect(a.boqs).toEqual([expect.objectContaining({ id: boqId, items: 1 })]);
      expect((await post(`/tenant/boqs/${boqId}/refresh-rates`, {}, worker)).statusCode).toBe(403);
    });
  });

  async function pccId(): Promise<string> {
    ids.PCC ??= (
      await ok<{ items: { id: string; code: string }[] }>(get('/tenant/rate-analyses?q=PCC-148'))
    ).items.find((i) => i.code === 'PCC-148')!.id;
    return ids.PCC;
  }
});
