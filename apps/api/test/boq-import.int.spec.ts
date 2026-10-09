// BOQ import and export in a real tenant database: Excel and CSV uploads, detection, dry run, import, the stored
// invariants afterwards, an export -> import round trip, permissions, cancelling and interrupted jobs.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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
import { ImportService, type ImportJob } from '../src/boq/import/import.service.js';
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

async function xlsx(sheets: { name: string; rows: ExcelJS.CellValue[][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const r of s.rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!controlUrl || !adminUrl)('BOQ import and export (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let importDir: string;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let tenderId: string;
  let worker: Record<string, string>;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const newBoq = async (name: string) =>
    (await post(`/tenant/tenders/${tenderId}/boqs`, { name })).json<{ id: string }>().id;

  const upload = (
    boqId: string,
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
      url: `/api/tenant/boqs/${boqId}/imports`,
      payload,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  /** The job once its background work has finished. */
  const settled = async (jobId: string) => {
    await app.get(ImportService).settled(jobId);
    return (await get(`/tenant/imports/${jobId}`)).json<ImportJob>();
  };
  const uploaded = async (boqId: string, fileName: string, content: Buffer | string) => {
    const res = await upload(boqId, fileName, content);
    if (res.statusCode !== 201) throw new Error(`${res.statusCode} ${res.body}`);
    return settled(res.json<ImportJob>().id);
  };
  const validated = async (job: ImportJob, settings: object = {}) => {
    const res = await post(`/tenant/imports/${job.id}/validate`, { ...job.settings, ...settings });
    if (res.statusCode !== 200) throw new Error(`${res.statusCode} ${res.body}`);
    return settled(job.id);
  };
  const imported = async (job: ImportJob, skipErrors = false) => {
    const res = await post(`/tenant/imports/${job.id}/start`, { skipErrors });
    if (res.statusCode !== 200) throw new Error(`${res.statusCode} ${res.body}`);
    return settled(job.id);
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
  /** Rows without ids and keys, for comparing two BOQs. */
  const shape = (rows: BoqRow[]) =>
    rows.map((r) => ({
      depth: r.depth,
      type: r.type,
      code: r.code,
      description: r.description,
      notes: r.notes,
      unit: r.unit,
      qty: r.qty,
      rate: r.rate,
      amount: r.amount,
      subtotal: r.subtotal,
      childCount: r.childCount,
    }));
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
    t = await readyTenant(app, control, ENC, 'import-admin@example.in');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    tenderId = (await post('/tenant/tenders', { title: 'Hostel block, Pune' })).json<{
      id: string;
    }>().id;
    worker = await staff('suresh', 'worker');
  }, 90_000);

  afterAll(async () => {
    delete process.env.IMPORT_DIR;
    delete process.env.IMPORT_MAX_MB;
    await app?.close();
    await control?.end();
    await server?.end();
  });

  // A typical tender BOQ workbook: a cover sheet, then the schedule with title rows, a numbered hierarchy, Indian
  // number formatting, a formula, a sub-item list, a rate-only "LS" row and a unit nobody listed.
  const tenderWorkbook = () =>
    xlsx([
      { name: 'Cover', rows: [['Name of work: G+4 hostel block'], ['Tender no. PWD/12/2026']] },
      {
        name: 'Schedule B',
        rows: [
          ['Name of work: G+4 hostel block'],
          ['Schedule of quantities'],
          ['Sl. No.', 'Description of item', 'Unit', 'Qty', 'Rate (₹)', 'Amount (₹)'],
          ['1', 'EARTHWORK'],
          ['1.1', 'Excavation in ordinary soil', 'Cu.M', '1,250.5', 350, 437675],
          ['1.2', 'Filling with', null, null, null, null],
          ['(a)', 'excavated earth', 'm3', 400, 120.25, { formula: 'D9*E9', result: 48100 }],
          ['(b)', 'river sand', 'cum', 80, '1,450', 116000],
          ['', 'Rates include lead up to 50 m'],
          ['2', 'CONCRETE'],
          ['2.1', 'PCC 1:4:8', 'cum', 12.5, 5200, 65000],
          ['2.2', 'RCC M25 including shuttering', 'cum', 140, 7850.75, 1099105],
          ['2.3', 'Steel reinforcement', 'MT', 18.234, 72000, 1312848],
          ['3', 'MISCELLANEOUS'],
          ['3.1', 'Site clearance', 'LS', 1, 25000, 25000],
          ['3.2', 'Gabion boxes', 'bundle', 10, 4000, 40000],
        ],
      },
    ]);

  describe('an Excel tender BOQ', () => {
    let boqId: string;
    let job: ImportJob;

    it('scans the workbook, picks the schedule sheet and suggests header, columns and numbering', async () => {
      boqId = await newBoq('Imported schedule');
      job = await uploaded(boqId, 'Schedule B.xlsx', await tenderWorkbook());
      expect(job).toMatchObject({ status: 'uploaded', fileType: 'xlsx', progress: 100 });
      expect(job.sheets.map((s) => [s.name, s.rows])).toEqual([
        ['Cover', 2],
        ['Schedule B', 16],
      ]);
      expect(job.settings).toEqual({
        sheet: 1,
        headerRow: 3,
        mapping: { code: 0, description: 1, unit: 2, qty: 3, rate: 4, amount: 5 },
        structure: 'numbering',
        normaliseUnits: true,
      });
      expect(job.sheets[1]!.preview[6]).toEqual({
        rowNo: 7,
        cells: ['(a)', 'excavated earth', 'm3', '400', '120.25', '48100'],
      });
    });

    it('dry-runs: counts, total and warnings, nothing written', async () => {
      job = await validated(job);
      expect(job.status).toBe('validated');
      expect(job.summary).toMatchObject({
        lines: 13,
        counts: { sections: 4, items: 8, notes: 1, errors: 0, unitsNormalised: 2 },
        unknownUnits: [{ unit: 'bundle', rows: 1 }],
      });
      // 437675 + 48100 + 116000 + 65000 + 1099105 + 1312848 + 25000 + 40000, with 140 × 7850.75 = 1099105.00
      expect(job.summary!.total).toBe('3143728.00');
      expect(job.summary!.issues).toEqual([
        expect.objectContaining({ rowNo: 16, field: 'unit', severity: 'warning' }),
      ]);
      expect((await header(boqId)).nodeCount).toBe(0);
    });

    it('imports into the empty BOQ with the hierarchy, totals and every invariant intact', async () => {
      job = await imported(job);
      expect(job).toMatchObject({ status: 'imported', progress: 100, error: null });
      expect(job.summary!.result).toMatchObject({
        nodeCount: 13,
        itemCount: 8,
        total: '3143728.00',
      });
      expect(await header(boqId)).toMatchObject({
        total: '3143728.00',
        nodeCount: 13,
        itemCount: 8,
      });
      const rows = await allRows(boqId);
      expect(rows.map((r) => [r.depth, r.type, r.code, r.unit])).toEqual([
        [0, 'section', '1', null],
        [1, 'item', '1.1', 'cum'],
        [1, 'section', '1.2', null],
        [2, 'item', '(a)', 'cum'],
        [2, 'item', '(b)', 'cum'],
        [2, 'note', null, null],
        [0, 'section', '2', null],
        [1, 'item', '2.1', 'cum'],
        [1, 'item', '2.2', 'cum'],
        [1, 'item', '2.3', 'MT'],
        [0, 'section', '3', null],
        [1, 'item', '3.1', 'LS'],
        [1, 'item', '3.2', 'bundle'],
      ]);
      expect(rows[0]).toMatchObject({ subtotal: '601775.00', childCount: 2 });
      expect(rows[1]).toMatchObject({ qty: '1250.5000', rate: '350.0000', amount: '437675.00' });
      expect(rows[2]).toMatchObject({ subtotal: '164100.00', childCount: 3 });
      expect(rows[5]!.description).toBe('Rates include lead up to 50 m');
      expect(await boqInvariants(db, boqId)).toEqual([]);
      // The upload is gone once imported.
      expect(existsSync(join(importDir, t.tenantId, job.id))).toBe(false);
      // The tender's history records it.
      const events = await db<{ kind: string }[]>`
        SELECT kind FROM tender.tender_event WHERE tender_id = ${tenderId} AND kind = 'boq_imported'`;
      expect(events).toHaveLength(1);
    });

    it('checks a second file into a BOQ that has lines as a revised BOQ: the same file changes nothing', async () => {
      const again = await validated(await uploaded(boqId, 'again.xlsx', await tenderWorkbook()));
      expect(again.summary!.revision).toMatchObject({
        before: 13,
        unchanged: 13,
        added: 0,
        removed: 0,
        changed: 0,
        moved: 0,
        total: '3143728.00',
      });
      expect((await post(`/tenant/imports/${again.id}/cancel`)).statusCode).toBe(200);
    });

    it('exports to Excel and imports back unchanged', async () => {
      const res = await get(`/tenant/boqs/${boqId}/export?format=xlsx`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename=".+Imported schedule\.xlsx"/,
      );
      const file = res.rawPayload;
      // A real workbook: Excel's outline levels and the bold section rows survive.
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file as unknown as ArrayBuffer);
      const ws = wb.worksheets[0]!;
      expect(ws.getRow(1).values).toEqual([
        undefined,
        'Level',
        'Type',
        'Code',
        'Description',
        'Unit',
        'Qty',
        'Rate',
        'Amount',
        'Notes',
      ]);
      expect(ws.getRow(2).font?.bold).toBe(true);
      expect(ws.getRow(5).outlineLevel).toBe(2);
      expect(ws.getRow(2).getCell(8).value).toBe(601775);

      const copy = await newBoq('Round trip (xlsx)');
      let j = await uploaded(copy, 'export.xlsx', file);
      expect(j.settings).toMatchObject({ headerRow: 1, structure: 'level' });
      j = await validated(j);
      expect(j.summary).toMatchObject({ lines: 13, counts: { errors: 0, warnings: 1 } }); // 'bundle' again
      j = await imported(j);
      expect(j.status).toBe('imported');
      expect(shape(await allRows(copy))).toEqual(shape(await allRows(boqId)));
      expect(await header(copy)).toMatchObject({ total: '3143728.00', nodeCount: 13 });
      expect(await boqInvariants(db, copy)).toEqual([]);
    });

    it('exports to CSV and imports back unchanged, including text that looks like a formula', async () => {
      // A description a spreadsheet would execute is guarded on export and restored on import.
      const rows = await allRows(boqId);
      await post(`/tenant/boqs/${boqId}/changes`, {
        ops: [
          {
            op: 'update',
            id: rows[5]!.id,
            rowVersion: rows[5]!.rowVersion,
            description: '=HYPERLINK("http://x")',
            notes: 'line one\nline two, "quoted"',
          },
        ],
      });
      const res = await get(`/tenant/boqs/${boqId}/export?format=csv`);
      expect(res.statusCode).toBe(200);
      expect(
        res.body.startsWith('﻿Level,Type,Code,Description,Unit,Qty,Rate,Amount,Notes\r\n'),
      ).toBe(true);
      expect(res.body).toContain(
        `2,note,,"'=HYPERLINK(""http://x"")",,,,,"line one\nline two, ""quoted"""`,
      );
      expect(res.body).toContain('1,item,1.1,Excavation in ordinary soil,cum,1250.5,350,437675,');

      const copy = await newBoq('Round trip (csv)');
      let j = await uploaded(copy, 'export.csv', res.body);
      expect(j).toMatchObject({ fileType: 'csv', settings: { headerRow: 1, structure: 'level' } });
      j = await imported(await validated(j));
      expect(j.status).toBe('imported');
      expect(shape(await allRows(copy))).toEqual(shape(await allRows(boqId)));
      expect(await boqInvariants(db, copy)).toEqual([]);
    });
  });

  describe("a client's revised BOQ, imported into a revision", () => {
    const v1 =
      'Code,Description,Unit,Qty,Rate\r\n' +
      '1,Earthwork,,,\r\n' +
      '1.1,Excavation in ordinary soil,cum,100,350\r\n' +
      '1.2,Backfilling in layers,cum,40,210\r\n' +
      '2,Concrete,,,\r\n' +
      '2.1,PCC 1:4:8 below footings,cum,12,5200\r\n' +
      '2.2,RCC M25 in footings,cum,30,7400\r\n';
    // The client's corrigendum: no rates; 1.1 up, 1.3 new, 2.1 dropped, 2.2 up, backfilling moved to 2.3.
    const v2 =
      'Code,Description,Unit,Qty\r\n' +
      '1,Earthwork,,\r\n' +
      '1.1,Excavation in ordinary soil,cum,120\r\n' +
      '1.3,Anti-termite treatment,sqm,200\r\n' +
      '2,Concrete,,\r\n' +
      '2.2,RCC M25 in footings,cum,32\r\n' +
      '2.3,Backfilling in layers,cum,40\r\n';
    let boqId: string;
    let frozenCsv: string;

    it('checks the revised file against the BOQ: matched, changed, moved, added, removed, rates kept', async () => {
      boqId = await newBoq('Revised by corrigendum');
      await imported(await validated(await uploaded(boqId, 'v1.csv', v1)));
      // 2.2 was measured on site: 1 × 30.
      const rcc = (await allRows(boqId)).find((r) => r.code === '2.2')!;
      const m = await post(`/tenant/boqs/${boqId}/lines/${rcc.id}/measurements`, {
        rowVersion: rcc.rowVersion,
        rows: [
          {
            description: 'Footings',
            nos: '1',
            length: '30',
            breadth: null,
            height: null,
            deduct: false,
          },
        ],
      });
      expect(m.statusCode).toBe(200);
      frozenCsv = (await get(`/tenant/boqs/${boqId}/export?format=csv`)).body;
      expect(
        (await post(`/tenant/boqs/${boqId}/freeze`, { kind: 'submitted', label: 'R0' })).statusCode,
      ).toBe(200);
      // A frozen BOQ takes no import; a revision does.
      expect((await upload(boqId, 'v2.csv', v2)).json()).toMatchObject({ code: 'boq_locked' });
      expect((await post(`/tenant/boqs/${boqId}/revise`)).statusCode).toBe(200);

      const job = await validated(await uploaded(boqId, 'v2.csv', v2));
      expect(job.status).toBe('validated');
      expect(job.summary!.revision).toMatchObject({
        before: 6,
        matchedByCode: 4,
        matchedByDescription: 1,
        changed: 3,
        moved: 1,
        added: 1,
        removed: 1,
        measuredOverridden: 1,
        ratesKept: 3,
        // 120 × 350 + 32 × 7400 + 40 × 210; the new item has no rate yet.
        total: '287200.00',
      });

      const done = await imported(job);
      expect(done).toMatchObject({ status: 'imported', error: null });
      const rows = await allRows(boqId);
      expect(rows.map((r) => [r.depth, r.code, r.qty, r.rate, r.measured])).toEqual([
        [0, '1', null, null, false],
        [1, '1.1', '120.0000', '350.0000', false],
        [1, '1.3', '200.0000', null, false],
        [0, '2', null, null, false],
        [1, '2.2', '32.0000', '7400.0000', false],
        [1, '2.3', '40.0000', '210.0000', false],
      ]);
      expect(await header(boqId)).toMatchObject({ total: '287200.00', nodeCount: 6, itemCount: 4 });
      expect(await boqInvariants(db, boqId)).toEqual([]);
    });

    it('compares as a revision (changed, not removed and re-added) and keeps the frozen version intact', async () => {
      const c = (await get(`/tenant/boqs/${boqId}/compare?from=1&to=2`)).json<{
        summary: Record<string, unknown>;
        rows: { change: string; codeA: string | null; codeB: string | null; moved: boolean }[];
      }>();
      expect(c.summary).toEqual({ added: 1, removed: 1, changed: 3, itemsDelta: '-40600.00' });
      expect(c.rows.map((r) => [r.change, r.codeA ?? r.codeB, r.codeB, r.moved])).toEqual(
        expect.arrayContaining([
          ['changed', '1.1', '1.1', false],
          ['added', '1.3', '1.3', false],
          ['removed', '2.1', null, false],
          ['changed', '2.2', '2.2', false],
          ['changed', '1.2', '2.3', true],
        ]),
      );
      expect((await get(`/tenant/boqs/${boqId}/export?format=csv&version=1`)).body).toBe(frozenCsv);
      const events = await db<{ data: { mode: string; added: number } }[]>`
        SELECT data FROM tender.tender_event WHERE tender_id = ${tenderId} AND kind = 'boq_imported'
        ORDER BY id DESC LIMIT 1`;
      expect(events[0]!.data).toMatchObject({ mode: 'revision', added: 1 });
    });

    it('refuses to apply a check that the BOQ has outrun', async () => {
      const again =
        'Code,Description,Unit,Qty\r\n1,Earthwork,,\r\n1.1,Excavation in ordinary soil,cum,125\r\n';
      const job = await validated(await uploaded(boqId, 'v3.csv', again));
      const row = (await allRows(boqId)).find((r) => r.code === '1.3')!;
      const edit = await post(`/tenant/boqs/${boqId}/changes`, {
        ops: [{ op: 'update', id: row.id, rowVersion: row.rowVersion, rate: '45' }],
      });
      expect(edit.statusCode).toBe(200);
      const done = await imported(job);
      expect(done.status).toBe('failed');
      expect(done.error).toContain('changed since the check');
      expect((await allRows(boqId)).find((r) => r.code === '1.1')!.qty).toBe('120.0000');
    });
  });

  describe('a messy CSV', () => {
    // Semicolons, a byte-order mark, a multi-line quoted description, a blank row and two bad rows.
    const csv =
      '﻿Item;Particulars;UOM;Quantity;Rate\r\n' +
      ';SITE WORKS;;;\r\n' +
      '1;"Clearing site,\nincluding disposal";sqm;"1.200,5";12\r\n' +
      ';;;;\r\n' +
      '2;Trench excavation;cum;45;abc\r\n' +
      '3;Dewatering;LS;;15000\r\n' +
      ';FINISHES;;;\r\n' +
      '4;Plaster 12 mm;sqm;600;210\r\n' +
      '5;Extra item, rate later;nos;5;\r\n';

    let boqId: string;
    let job: ImportJob;

    it('finds the semicolon columns and reports errors with row numbers', async () => {
      boqId = await newBoq('Messy CSV');
      job = await uploaded(boqId, 'messy.csv', csv);
      expect(job.settings).toMatchObject({
        sheet: 0,
        headerRow: 1,
        mapping: { code: 0, description: 1, unit: 2, qty: 3, rate: 4 },
        structure: 'headings',
      });
      job = await validated(job);
      expect(job.summary!.counts).toMatchObject({ errors: 2, sections: 2 });
      // Row numbers count records as a spreadsheet shows them, so the multi-line row is one row.
      expect(job.summary!.issues.map((i) => [i.rowNo, i.severity, i.field ?? '-'])).toEqual([
        [3, 'error', 'qty'], // "1.200,5": a European decimal comma is not guessed
        [5, 'error', 'rate'],
      ]);
    });

    it('refuses to import while errors remain unless told to skip those rows', async () => {
      const res = await post(`/tenant/imports/${job.id}/start`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'has_errors' });
    });

    it('offers every issue as a CSV report', async () => {
      const res = await get(`/tenant/imports/${job.id}/issues`);
      expect(res.statusCode).toBe(200);
      expect(res.body.split('\r\n').slice(0, 3)).toEqual([
        '﻿Row,Severity,Column,Message',
        '3,error,qty,"Quantity ""1.200,5"" is not a number"',
        '5,error,rate,"Rate ""abc"" is not a number"',
      ]);
    });

    it('imports the good rows when asked to skip errors', async () => {
      job = await imported(job, true);
      expect(job.status).toBe('imported');
      const rows = await allRows(boqId);
      expect(rows.map((r) => [r.depth, r.type, r.code, r.description])).toEqual([
        [0, 'section', null, 'SITE WORKS'],
        [1, 'item', '3', 'Dewatering'],
        [0, 'section', null, 'FINISHES'],
        [1, 'item', '4', 'Plaster 12 mm'],
        [1, 'item', '5', 'Extra item, rate later'],
      ]);
      expect(await header(boqId)).toMatchObject({ total: '126000.00', itemCount: 3 });
      expect(await boqInvariants(db, boqId)).toEqual([]);
    });
  });

  describe('jobs', () => {
    it('cancels a job and deletes the upload', async () => {
      const boqId = await newBoq('Cancelled import');
      const job = await uploaded(boqId, 'x.xlsx', await tenderWorkbook());
      expect(existsSync(join(importDir, t.tenantId, job.id))).toBe(true);
      const res = await post(`/tenant/imports/${job.id}/cancel`);
      expect(res.json()).toMatchObject({ status: 'cancelled' });
      expect(existsSync(join(importDir, t.tenantId, job.id))).toBe(false);
      expect((await post(`/tenant/imports/${job.id}/validate`, job.settings!)).statusCode).toBe(
        409,
      );
      expect((await get(`/tenant/boqs/${boqId}/imports/latest`)).json()).toMatchObject({
        job: { id: job.id, status: 'cancelled' },
      });
    });

    it('refuses edits while an import runs, and fails a job whose worker stopped reporting', async () => {
      const boqId = await newBoq('Interrupted import');
      const job = await uploaded(boqId, 'x.xlsx', await tenderWorkbook());
      await db`UPDATE platform.import_job SET status = 'importing' WHERE id = ${job.id}`;
      const edit = await post(`/tenant/boqs/${boqId}/changes`, {
        ops: [{ op: 'insert', tempId: 't1', parentId: null, afterId: null, type: 'section' }],
      });
      expect(edit.statusCode).toBe(409);
      expect(edit.json()).toMatchObject({ code: 'boq_importing' });

      await db`UPDATE platform.import_job SET updated_at = now() - interval '20 minutes' WHERE id = ${job.id}`;
      expect((await get(`/tenant/imports/${job.id}`)).json()).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Interrupted'),
      });
      expect(
        (
          await post(`/tenant/boqs/${boqId}/changes`, {
            ops: [{ op: 'insert', tempId: 't1', parentId: null, afterId: null, type: 'section' }],
          })
        ).statusCode,
      ).toBe(200);
    });

    it('rejects files that are too large, empty, or zip files that are not workbooks', async () => {
      const boqId = await newBoq('Bad files');
      const big = await upload(boqId, 'big.csv', 'a,b\n'.repeat(700_000));
      expect(big.statusCode).toBe(413);
      expect(big.json()).toMatchObject({ code: 'file_too_large' });
      expect((await upload(boqId, 'empty.csv', '')).json()).toMatchObject({ code: 'empty_file' });
      const zip = await uploaded(
        boqId,
        'fake.xlsx',
        Buffer.from('PK\u0003\u0004this is not a workbook'),
      );
      expect(zip).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('could not be read as an Excel workbook'),
      });
      const xls = await upload(
        boqId,
        'old.xls',
        Buffer.from('d0cf11e0a1b11ae1' + '00'.repeat(64), 'hex'),
      );
      expect(xls.statusCode).toBe(415);
      expect(xls.json()).toMatchObject({ code: 'unsupported_file', type: 'xls' });
      expect((await upload(boqId, 'boq.pdf', '%PDF-1.7\n...')).json()).toMatchObject({
        type: 'pdf',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/tenant/boqs/${boqId}/imports`,
            headers: t.admin,
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
    });

    it('lets workers export but not import, unless their role is allowed to edit BOQs', async () => {
      const boqId = await newBoq('Worker access');
      expect((await upload(boqId, 'x.csv', 'Description,Qty\nA,1\n', worker)).statusCode).toBe(403);
      expect((await get(`/tenant/boqs/${boqId}/export?format=csv`, worker)).statusCode).toBe(200);
      await post('/tenant/permissions', { role: 'worker', permission: 'boq.edit', granted: true });
      expect((await upload(boqId, 'x.csv', 'Description,Qty\nA,1\n', worker)).statusCode).toBe(201);
      await post('/tenant/permissions', { role: 'worker', permission: 'boq.edit', granted: false });
    });
  });

  describe('units', () => {
    it('lists the seeded units and adds new ones, refusing clashing spellings', async () => {
      const units = (await get('/tenant/units', worker)).json<
        { code: string; aliases: string[] }[]
      >();
      expect(units.find((u) => u.code === 'cum')!.aliases).toContain('m3');
      expect(
        (await post('/tenant/units', { code: 'brass', name: 'Brass (100 cft)' }, worker))
          .statusCode,
      ).toBe(403);
      const clash = await post('/tenant/units', { code: 'cu.m', name: 'Clash' });
      expect(clash.statusCode).toBe(409);
      expect(clash.json()).toMatchObject({ code: 'unit_exists', unit: 'cum' });
      const added = await post('/tenant/units', {
        code: 'brass',
        name: 'Brass (100 cft)',
        aliases: ['Brass.'],
      });
      expect(added.statusCode).toBe(201);

      // New aliases normalise on the next import.
      const boqId = await newBoq('Units');
      let job = await uploaded(boqId, 'u.csv', 'Description,Unit,Qty,Rate\nSand,brass.,2,6000\n');
      job = await validated(job);
      expect(job.summary).toMatchObject({ unknownUnits: [], counts: { unitsNormalised: 1 } });
      await imported(job);
      expect((await allRows(boqId))[0]).toMatchObject({ unit: 'brass', amount: '12000.00' });
    });
  });
});
