// RFQs in a real tenant database (docs/wave1-plan.md step 9): a waterproofing package from the BOQ, two
// subcontractors (one replying in the enquiry workbook, one typed in, GST extra and GST included), the comparative
// statement, choosing vendors, putting the chosen rates into the BOQ (and not into a frozen one), and a materials RFQ
// that sets a resource's rate.
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
import type { BoqRow } from '../src/boq/boq.service.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { financialYear } from '../src/tender/tender-rules.js';
import { boqInvariants } from './helpers/boq.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

interface Rfq {
  id: string;
  number: string;
  status: string;
  rowVersion: number;
  lines: {
    id: string;
    seq: number;
    description: string;
    qty: string | null;
    ourRate: string | null;
    l1: string | null;
    cells: Record<string, { rate: string; basic: string; amount: string | null; rank: number }>;
    selected: { partyId: string; basic: string } | null;
  }[];
  vendors: {
    partyId: string;
    name: string;
    status: string;
    quote: { gstMode: string; source: string } | null;
  }[];
  cs: {
    vendors: {
      partyId: string;
      basicTotal: string;
      gst: string;
      total: string;
      complete: boolean;
      rank: number | null;
    }[];
    totals: Record<string, unknown>;
  };
}

describe.skipIf(!controlUrl || !adminUrl)('RFQs (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let worker: Record<string, string>;
  let tenderId: string;
  let boqId: string;
  let rfq: Rfq;
  let aqua: string;
  let dry: string;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  const upload = (rfqId: string, buffer: Buffer, partyId?: string) => {
    const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="quote.xlsx"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: `/api/tenant/rfqs/${rfqId}/quotes/import${partyId ? `?partyId=${partyId}` : ''}`,
      payload,
      headers: { ...t.admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  /** The vendor's reply: the enquiry workbook with rates typed into column F. */
  const filled = async (
    pack: Buffer,
    rates: Record<number, string | number>,
    gst = 'Extra on top of the rates',
  ) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(pack as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Enquiry')!;
    ws.getCell('C10').value = 'AQ/221';
    ws.getCell('C11').value = '31-12-2026';
    ws.getCell('C12').value = gst;
    for (let r = 16; r <= ws.rowCount; r++) {
      const seq = Number(ws.getRow(r).getCell(1).value);
      if (rates[seq] !== undefined) ws.getRow(r).getCell(6).value = rates[seq];
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const rows = async (id: string) =>
    (await ok<{ rows: BoqRow[] }>(get(`/tenant/boqs/${id}/rows?limit=500`))).rows;

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
    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      CONTROL_PLANE_ENC_KEY: ENC.toString('base64'),
      LOCAL_PG_ADMIN_URL: adminUrl,
      RATE_LIMIT_SCALE: '50',
      PUBLIC_API_URL: 'https://api.example.in',
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-rfq-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'rfq-admin@example.in');
    worker = await staff('mahesh', 'worker');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    tenderId = (
      await ok<{ id: string }>(post('/tenant/tenders', { title: 'Hostel block, Yavatmal' }))
    ).id;
    boqId = (await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Civil' })))
      .id;
    const item = (
      tempId: string,
      parentId: string,
      afterId: string | null,
      code: string,
      description: string,
      qty: string,
      rate: string,
    ) => ({
      op: 'insert',
      tempId,
      parentId,
      afterId,
      type: 'item',
      code,
      description,
      unit: 'sqm',
      qty,
      rate,
    });
    await ok(
      post(`/tenant/boqs/${boqId}/changes`, {
        ops: [
          {
            op: 'insert',
            tempId: 'tA',
            parentId: null,
            afterId: null,
            type: 'section',
            code: '2',
            description: 'Waterproofing',
          },
          item('ta1', 'tA', null, '2.1', 'Waterproofing of terrace', '100', '340'),
          item('ta2', 'tA', 'ta1', '2.2', 'Waterproofing of toilets', '40', '230'),
          {
            op: 'insert',
            tempId: 'tB',
            parentId: null,
            afterId: 'tA',
            type: 'section',
            code: '3',
            description: 'Plaster',
          },
          item('tb1', 'tB', null, '3.1', 'Internal plaster 12 mm', '900', '210'),
        ],
      }),
    );
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('builds a work RFQ from a BOQ section, without adding an item twice', async () => {
    rfq = await ok<Rfq>(
      post(`/tenant/tenders/${tenderId}/rfqs`, {
        title: 'Waterproofing package',
        kind: 'work',
        dueOn: '2026-11-20',
        terms: 'Rates for supply and application, 10-year guarantee.',
      }),
    );
    expect(rfq.number).toBe(`RFQ/${financialYear(new Date())}/0001`);
    const section = (await rows(boqId)).find((r) => r.code === '2')!;
    const first = await ok<{ added: number; rfq: Rfq }>(
      post(`/tenant/rfqs/${rfq.id}/lines`, { boqId, nodeIds: [section.id] }),
    );
    expect(first.added).toBe(2);
    expect(
      (
        await ok<{ added: number }>(
          post(`/tenant/rfqs/${rfq.id}/lines`, { boqId, nodeIds: [section.id] }),
        )
      ).added,
    ).toBe(0);
    rfq = (
      await ok<{ rfq: Rfq }>(
        post(`/tenant/rfqs/${rfq.id}/lines`, {
          free: { description: 'Extra for coving', unit: 'm' },
        }),
      )
    ).rfq;
    expect(rfq.lines.map((l) => [l.seq, l.description, l.qty, l.ourRate])).toEqual([
      [1, 'Waterproofing of terrace', '100.0000', '340.0000'],
      [2, 'Waterproofing of toilets', '40.0000', '230.0000'],
      [3, 'Extra for coving', null, null],
    ]);
    // Materials do not go into a work RFQ; workers cannot change RFQs.
    expect(
      (await post(`/tenant/rfqs/${rfq.id}/lines`, { resourceIds: [rfq.id] })).json(),
    ).toMatchObject({
      code: 'wrong_kind',
    });
    expect(
      (await post(`/tenant/rfqs/${rfq.id}/lines`, { free: { description: 'x' } }, worker))
        .statusCode,
    ).toBe(403);
  });

  it('adds subcontractors to the party master and makes each one an enquiry workbook', async () => {
    rfq = await ok<Rfq>(
      post(`/tenant/rfqs/${rfq.id}/vendors`, {
        name: 'Aqua Seal Systems',
        email: 'quotes@aquaseal.in',
      }),
    );
    rfq = await ok<Rfq>(post(`/tenant/rfqs/${rfq.id}/vendors`, { name: 'DryTech Waterproofing' }));
    aqua = rfq.vendors.find((v) => v.name === 'Aqua Seal Systems')!.partyId;
    dry = rfq.vendors.find((v) => v.name === 'DryTech Waterproofing')!.partyId;
    const subs = await ok<{ name: string }[]>(get('/tenant/parties?kind=subcontractor'));
    expect(subs.map((p) => p.name)).toEqual(['Aqua Seal Systems', 'DryTech Waterproofing']);

    const res = await get(`/tenant/rfqs/${rfq.id}/vendors/${aqua}/pack`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('Aqua Seal Systems.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Enquiry')!;
    expect(ws.getCell('B2').value).toBe(rfq.number);
    expect((ws.getRow(16).values as unknown[]).slice(1, 6)).toEqual([
      1,
      '2.1',
      'Waterproofing of terrace',
      'sqm',
      100,
    ]);
    expect(ws.getCell('G16').value).toEqual({ formula: 'IF(F16="","",E16*F16)' });
    expect(wb.getWorksheet('_aerolith')!.state).toBe('veryHidden');

    rfq = await ok<Rfq>(post(`/tenant/rfqs/${rfq.id}/vendors/${aqua}`, { status: 'sent' }));
    expect(rfq.status).toBe('sent');
  });

  it("imports the filled workbook as the vendor's quote, and refuses one for someone else or with bad rates", async () => {
    const pack = (await get(`/tenant/rfqs/${rfq.id}/vendors/${aqua}/pack`)).rawPayload;
    const wrong = await upload(rfq.id, await filled(pack, { 1: 350 }), dry);
    expect(wrong.json()).toMatchObject({ code: 'wrong_vendor' });
    const bad = await upload(rfq.id, await filled(pack, { 1: 'three fifty' }));
    expect(bad.json()).toMatchObject({ code: 'quote_has_errors' });

    const res = await ok<{ lines: number; skipped: number; rfq: Rfq }>(
      upload(rfq.id, await filled(pack, { 1: 350, 2: '2,00', 3: 50 })),
    );
    expect(res).toMatchObject({ lines: 3, skipped: 0 });
    // "2,00" is read the Indian way: 200.
    expect(res.rfq.lines[1]!.cells[aqua]).toMatchObject({ rate: '200.0000' });
    expect(res.rfq.vendors.find((v) => v.partyId === aqua)).toMatchObject({
      status: 'quoted',
      quote: { gstMode: 'extra', source: 'file' },
    });
  });

  it('ranks the quotes before GST in the comparative statement', async () => {
    rfq = await ok<Rfq>(
      post(`/tenant/rfqs/${rfq.id}/vendors/${dry}/quote`, {
        receivedOn: '2026-11-18',
        gstMode: 'included',
        gstPct: '18',
        lines: [
          { lineId: rfq.lines[0]!.id, rate: '413' },
          { lineId: rfq.lines[1]!.id, rate: '212.40' },
        ],
      }),
    );
    const [l1, l2, l3] = rfq.lines;
    expect(l1!.cells[dry]).toMatchObject({ basic: '350.0000', rank: 1 });
    expect(l1!.l1).toBeNull(); // a tie at 350
    expect(l2!.l1).toBe(dry);
    expect(l3!.l1).toBe(aqua);
    expect(rfq.cs.vendors).toEqual([
      expect.objectContaining({
        partyId: aqua,
        basicTotal: '43000.00',
        gst: '7740.00',
        complete: true,
        rank: 1,
      }),
      expect.objectContaining({
        partyId: dry,
        basicTotal: '42200.00',
        gst: '7596.00',
        complete: false,
        rank: null,
      }),
    ]);
    expect(rfq.cs.totals).toMatchObject({ splitL1: '42200.00', estimate: '43200.00' });
  });

  it('chooses the lowest per line, leaves ties to the estimator, and refuses a vendor who did not quote', async () => {
    const low = await ok<{ chosen: number; rfq: Rfq }>(
      post(`/tenant/rfqs/${rfq.id}/select`, { lowest: true }),
    );
    expect(low.chosen).toBe(2);
    const notQuoted = await post(`/tenant/rfqs/${rfq.id}/select`, {
      lines: [{ lineId: rfq.lines[2]!.id, partyId: dry }],
    });
    expect(notQuoted.json()).toMatchObject({ code: 'not_quoted' });
    rfq = (
      await ok<{ rfq: Rfq }>(
        post(`/tenant/rfqs/${rfq.id}/select`, {
          lines: [{ lineId: rfq.lines[0]!.id, partyId: aqua, note: 'Better guarantee terms' }],
        }),
      )
    ).rfq;
    expect(rfq.lines.map((l) => l.selected?.partyId ?? null)).toEqual([aqua, dry, aqua]);
    expect((await post(`/tenant/rfqs/${rfq.id}/select`, { lowest: true }, worker)).statusCode).toBe(
      403,
    );
  });

  it('puts the chosen rates into the BOQ before GST, and skips a frozen BOQ', async () => {
    const res = await ok<{
      boqs: { name: string; updated: number; unchanged: number; skipped: string | null }[];
    }>(post(`/tenant/rfqs/${rfq.id}/apply`));
    expect(res.boqs).toEqual([{ boqId, name: 'Civil', updated: 2, unchanged: 0, skipped: null }]);
    const after = await rows(boqId);
    expect(
      after.filter((r) => r.code?.startsWith('2.')).map((r) => [r.code, r.rate, r.amount]),
    ).toEqual([
      ['2.1', '350.0000', '35000.00'],
      ['2.2', '180.0000', '7200.00'], // 212.40 including 18 % GST
    ]);
    expect(await boqInvariants(db, boqId)).toEqual([]);
    const events = await db<{ kind: string }[]>`
      SELECT kind FROM tender.tender_event WHERE tender_id = ${tenderId} AND kind LIKE 'rfq%' ORDER BY id`;
    expect(events.map((e) => e.kind)).toEqual([
      'rfq_created',
      'rfq_quote',
      'rfq_quote',
      'rfq_applied',
    ]);

    await ok(post(`/tenant/boqs/${boqId}/freeze`, { kind: 'internal' }));
    const frozen = await ok<{ boqs: { skipped: string | null }[] }>(
      post(`/tenant/rfqs/${rfq.id}/apply`),
    );
    expect(frozen.boqs[0]!.skipped).toContain('start revision 2');
  });

  it('closes an RFQ against changes until it is reopened', async () => {
    rfq = await ok<Rfq>(
      post(`/tenant/rfqs/${rfq.id}`, { rowVersion: rfq.rowVersion, status: 'closed' }),
    );
    expect(
      (await post(`/tenant/rfqs/${rfq.id}/lines`, { free: { description: 'Late item' } })).json(),
    ).toMatchObject({
      code: 'rfq_closed',
    });
    rfq = await ok<Rfq>(
      post(`/tenant/rfqs/${rfq.id}`, { rowVersion: rfq.rowVersion, status: 'sent' }),
    );
    expect(rfq.status).toBe('sent');
  });

  it('prices a resource from a materials RFQ, dated the day of the quote', async () => {
    const cement = await ok<{ id: string }>(
      post('/tenant/resources', {
        code: 'CEM-OPC53',
        name: 'Cement OPC 53 grade',
        kind: 'material',
        unit: 'bag',
        rate: '410',
        effectiveFrom: '2026-04-01',
      }),
    );
    let m = await ok<Rfq>(
      post(`/tenant/tenders/${tenderId}/rfqs`, { title: 'Cement supply', kind: 'material' }),
    );
    m = (await ok<{ rfq: Rfq }>(post(`/tenant/rfqs/${m.id}/lines`, { resourceIds: [cement.id] })))
      .rfq;
    expect(m.lines[0]).toMatchObject({ description: 'Cement OPC 53 grade', ourRate: '410.0000' });
    m = await ok<Rfq>(post(`/tenant/rfqs/${m.id}/vendors`, { name: 'Vidarbha Cement Traders' }));
    const v = m.vendors[0]!.partyId;
    m = await ok<Rfq>(
      post(`/tenant/rfqs/${m.id}/vendors/${v}/quote`, {
        receivedOn: '2026-10-05',
        gstMode: 'extra',
        gstPct: '28',
        lines: [{ lineId: m.lines[0]!.id, rate: '395' }],
      }),
    );
    await ok(post(`/tenant/rfqs/${m.id}/select`, { award: v }));
    const res = await ok<{ resources: number }>(post(`/tenant/rfqs/${m.id}/apply`));
    expect(res.resources).toBe(1);
    const rates = await db<{ effective_from: string; rate: string; source: string }[]>`
      SELECT effective_from::text, rate::text, source FROM est.resource_rate WHERE resource_id = ${cement.id}
      ORDER BY effective_from`;
    expect(rates.map((r) => [r.effective_from, r.rate])).toEqual([
      ['2026-04-01', '410.0000'],
      ['2026-10-05', '395.0000'],
    ]);
    expect(rates[1]!.source).toContain('Vidarbha Cement Traders');
    const vendors = await ok<{ name: string }[]>(get('/tenant/parties?kind=vendor'));
    expect(vendors.map((p) => p.name)).toContain('Vidarbha Cement Traders');
  });
});
