// Quality in a real tenant database (docs/wave3-plan.md step 14): an inspection rejected and then approved, holding
// uninspected measurements from the client bill; checklists failed and passed, with a photo; cubes, slump and steel
// judged against the criteria, a failure raising an NCR closed only by someone other than who acted; snags; an order
// refused for an item without an approved make, then let through.
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

describe.skipIf(!controlUrl || !adminUrl)('quality (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-qa-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'qa-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  let projectId: string;
  let boqId: string;
  let siteId: string;
  let entityId: string;
  let ir1: string;
  const node = async (code: string) =>
    (
      await db<
        { id: string }[]
      >`SELECT id::text FROM est.boq_node WHERE boq_id = ${boqId} AND code = ${code}`
    )[0]!.id;
  const lineKey = async (code: string) =>
    (
      await db<
        { k: string }[]
      >`SELECT line_key::text AS k FROM est.boq_node WHERE boq_id = ${boqId} AND code = ${code}`
    )[0]!.k;
  const measure = async (code: string, measuredOn: string, qty: string) =>
    ok(
      post(
        `/tenant/boqs/${boqId}/lines/${await node(code)}/progress`,
        { measuredOn, qty },
        manager,
      ),
    );
  const put = (url: string, payload: object, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'PUT', url: `/api${url}`, payload, headers });

  it('inspects measured work and holds the uninspected from the bill', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Washim Builders Pvt Ltd',
        gstin: '27AAACW1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const zp = (
      await ok<{ id: string }>(
        post('/tenant/parties', { name: 'Zilla Parishad Washim', isClient: true }),
      )
    ).id;
    projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'Hostel, Washim', clientId: zp }, manager),
      )
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    siteId = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    boqId = (
      await ok<{ id: string }>(
        post(`/tenant/projects/${projectId}/boqs`, { name: 'Contract', kind: 'contract' }, manager),
      )
    ).id;
    const item = (
      tempId: string,
      afterId: string | null,
      code: string,
      description: string,
      qty: string,
      rate: string,
    ) => ({
      op: 'insert',
      tempId,
      parentId: 'tA',
      afterId,
      type: 'item',
      code,
      description,
      unit: 'cum',
      qty,
      rate,
    });
    await ok(
      post(
        `/tenant/boqs/${boqId}/changes`,
        {
          ops: [
            {
              op: 'insert',
              tempId: 'tA',
              parentId: null,
              afterId: null,
              type: 'section',
              code: 'A',
              description: 'Civil works',
            },
            item('t1', null, 'A.1', 'Excavation in ordinary soil', '100', '350'),
            item('t2', 't1', 'A.2', 'PCC M15', '20', '5600'),
          ],
        },
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
    await measure('A.1', '2026-07-10', '30');
    await measure('A.1', '2026-07-20', '30');

    // The site asks for the excavation to be inspected: both entries, 60 cum. Nothing measured on the PCC yet.
    const a1 = await lineKey('A.1');
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/inspections`,
          { lineKey: await lineKey('A.2'), requestedFor: '2026-07-21' },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'nothing_to_inspect' });
    const r1 = await ok<{ id: string; number: string; entries: unknown[] }>(
      post(
        `/tenant/projects/${projectId}/inspections`,
        {
          lineKey: a1,
          siteId,
          location: 'Block A',
          activity: 'Excavation to level',
          requestedFor: '2026-07-21',
        },
        worker,
      ),
    );
    expect(r1).toMatchObject({ number: 'IR-001', status: 'requested' });
    expect(r1.entries).toHaveLength(2);
    const decide = { inspector: 'Er. Kulkarni (ZP)', decidedOn: '2026-07-22' };
    expect(
      (await post(`/tenant/inspections/${r1.id}/decide`, { ...decide, status: 'approved' }, worker))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          `/tenant/inspections/${r1.id}/decide`,
          { ...decide, status: 'rejected' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'reason_needed' });
    await ok(
      post(
        `/tenant/inspections/${r1.id}/decide`,
        { ...decide, status: 'rejected', comments: 'Levels not to the drawing' },
        manager,
      ),
    );
    // The rejection frees the entries for a fresh request, approved this time.
    const r2 = await ok<{ id: string; number: string; entries: unknown[] }>(
      post(
        `/tenant/projects/${projectId}/inspections`,
        { lineKey: a1, requestedFor: '2026-07-24' },
        worker,
      ),
    );
    expect(r2).toMatchObject({ number: 'IR-002' });
    expect(r2.entries).toHaveLength(2);
    ir1 = r2.id;
    await ok(
      post(
        `/tenant/inspections/${r2.id}/decide`,
        {
          ...decide,
          decidedOn: '2026-07-25',
          status: 'approved_with_comments',
          comments: 'Dewater before PCC',
        },
        manager,
      ),
    );
    await measure('A.1', '2026-07-28', '10');

    // Held: the bill counts 60 cum (the inspected entries), not the 10 measured since.
    expect(
      (await put(`/tenant/projects/${projectId}/quality/hold`, { hold: true }, worker)).statusCode,
    ).toBe(403);
    await ok(put(`/tenant/projects/${projectId}/quality/hold`, { hold: true }, manager));
    const bill = await ok<{ lines: { code: string; measuredQty: string }[] }>(
      post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-07-31' }, manager),
    );
    expect(bill.lines.find((l) => l.code === 'A.1')!.measuredQty).toBe('60.0000');
  });

  it('fills checklists with photos, judges tests and follows failures to closure', async () => {
    const tpl = await ok<{ id: string; name: string }[]>(
      post(
        '/tenant/quality/checklist-templates',
        {
          name: 'Before concreting',
          workType: 'RCC',
          items: [
            { text: 'Cover blocks placed', kind: 'yes_no' },
            { text: 'Cover (mm)', kind: 'number', min: 40, max: 50 },
            { text: 'Remarks', kind: 'note', required: false },
          ],
        },
        manager,
      ),
    );
    const templateId = tpl[0]!.id;
    expect(
      await ok(
        post(
          `/tenant/projects/${projectId}/checklists`,
          {
            templateId,
            siteId,
            doneOn: '2026-08-01',
            location: 'Footing F3',
            answers: [{ answer: 'yes' }, { answer: 35 }, { answer: null }],
          },
          worker,
        ),
      ),
    ).toMatchObject({ result: 'failed', findings: ['Cover (mm): 35 outside 40–50.'] });
    const passed = await ok<{ id: string; result: string }>(
      post(
        `/tenant/projects/${projectId}/checklists`,
        {
          templateId,
          siteId,
          inspectionId: ir1,
          doneOn: '2026-08-01',
          location: 'Footing F3',
          answers: [{ answer: 'yes' }, { answer: 45 }, { answer: '' }],
        },
        worker,
      ),
    );
    expect(passed.result).toBe('passed');
    // A photo of it (a 1×1 PNG).
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const boundary = '----qa' + Math.random().toString(16).slice(2);
    const up = await app.inject({
      method: 'POST',
      url: `/api/tenant/quality/photos?checklistId=${passed.id}&caption=Cover%20blocks`,
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f3.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { ...worker, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(up.statusCode).toBe(200);
    const photo = await get(`/tenant/quality/photos/${up.json<{ id: string }>().id}`, manager);
    expect(photo.headers['content-type']).toBe('image/png');

    // Cubes: M25 at 28 days, 26.5/24/25 passes; 21/21.5/22 (mean 21.5 under 22) fails and raises an NCR.
    const cube = (cubes: number[], ref: string) =>
      post(
        `/tenant/projects/${projectId}/tests`,
        {
          kind: 'cube',
          sampleRef: ref,
          location: 'Footing F3',
          sampledOn: '2026-07-04',
          testedOn: '2026-08-01',
          spec: { grade: 'M25' },
          results: { age: 28, cubes },
        },
        worker,
      );
    expect(await ok(cube([26.5, 24, 25], 'C-11'))).toMatchObject({
      number: 'QT-001',
      outcome: 'passed',
      ncr: null,
    });
    const failed = await ok<{ number: string; ncr: string }>(cube([21, 21.5, 22], 'C-12'));
    expect(failed).toMatchObject({ number: 'QT-002', outcome: 'failed', ncr: 'NCR-002' });
    expect(
      await ok(
        post(
          `/tenant/projects/${projectId}/tests`,
          {
            kind: 'slump',
            sampledOn: '2026-08-01',
            testedOn: '2026-08-01',
            spec: { slump: 100 },
            results: { slump: 80 },
          },
          worker,
        ),
      ),
    ).toMatchObject({ number: 'QT-003', outcome: 'passed' });
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/tests`,
          {
            kind: 'steel',
            sampledOn: '2026-08-01',
            testedOn: '2026-08-02',
            spec: { grade: 'Fe999' },
            results: { yield: 500, tensile: 600, elongation: 14 },
          },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'bad_test' });

    // NCR-001 came from the rejected inspection, NCR-002 from the cubes.
    const reg = await ok<{
      ncrs: { id: string; number: string; source: string; status: string }[];
    }>(get(`/tenant/projects/${projectId}/quality`, manager));
    expect(reg.ncrs.map((n) => [n.number, n.source, n.status])).toEqual([
      ['NCR-002', 'test', 'open'],
      ['NCR-001', 'inspection', 'open'],
    ]);
    const n2 = reg.ncrs[0]!.id;
    const n1 = reg.ncrs[1]!.id;
    // The site records the cause and the action; a manager verifies and closes it (not the one who acted).
    let n = await ok<{ rowVersion: number }>(get(`/tenant/ncrs/${n2}`, worker));
    expect(
      (await put(`/tenant/ncrs/${n2}`, { done: true, rowVersion: n.rowVersion }, worker)).json(),
    ).toMatchObject({ code: 'action_needed' });
    await ok(
      put(
        `/tenant/ncrs/${n2}`,
        {
          rootCause: 'Water added at site',
          correctiveAction: 'Cores taken: 24.1; slump checked each truck',
          responsible: 'Site engineer',
          done: true,
          rowVersion: n.rowVersion,
        },
        worker,
      ),
    );
    expect(
      (await post(`/tenant/ncrs/${n2}/close`, { note: 'Cores accepted' }, worker)).statusCode,
    ).toBe(403);
    expect(
      await ok(post(`/tenant/ncrs/${n2}/close`, { note: 'Cores accepted' }, manager)),
    ).toMatchObject({ status: 'closed', closedBy: 'suresh' });
    n = await ok<{ rowVersion: number }>(get(`/tenant/ncrs/${n1}`, manager));
    await ok(
      put(
        `/tenant/ncrs/${n1}`,
        {
          rootCause: 'Survey error',
          correctiveAction: 'Re-levelled',
          done: true,
          rowVersion: n.rowVersion,
        },
        manager,
      ),
    );
    expect((await post(`/tenant/ncrs/${n1}/close`, {}, manager)).json()).toMatchObject({
      code: 'own_action',
    });
  });

  it('keeps snags and requires an approved make before ordering', async () => {
    const snag = await ok<{ id: string }>(
      post(
        `/tenant/projects/${projectId}/snags`,
        { area: 'Room 101', description: 'Skirting tile chipped' },
        worker,
      ),
    );
    expect(
      (await put(`/tenant/snags/${snag.id}`, { status: 'closed', rowVersion: 1 }, worker)).json(),
    ).toMatchObject({ code: 'not_fixed' });
    await ok(put(`/tenant/snags/${snag.id}`, { status: 'fixed', rowVersion: 1 }, worker));
    const reg = await ok<{ snags: { status: string }[] }>(
      put(`/tenant/snags/${snag.id}`, { status: 'closed', rowVersion: 2 }, manager),
    );
    expect(reg.snags.map((s) => s.status)).toEqual(['closed']);

    // Waterproofing compound only in an approved make: the order is refused, then goes through once one is approved.
    const wp = (
      await ok<{ id: string }>(
        post('/tenant/resources', {
          code: 'WPC',
          name: 'Waterproofing compound',
          kind: 'material',
          unit: 'kg',
          rate: '120',
          effectiveFrom: '2026-01-01',
        }),
      )
    ).id;
    await ok(put(`/tenant/projects/${projectId}/make-required/${wp}`, { required: true }, manager));
    const vendor = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Akola Chemicals',
          isClient: false,
          isVendor: true,
          gstin: '27AAACA1111C1Z5',
        }),
      )
    ).id;
    const po = await ok<{ open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: vendor,
          siteId,
          deliverBy: '2026-09-30',
          paymentTerms: '30 days',
          lines: [
            {
              resourceId: wp,
              description: 'Waterproofing compound',
              unit: 'kg',
              qty: '200',
              rate: '118',
              gstPct: '18',
            },
          ],
        },
        manager,
      ),
    );
    expect(
      (
        await post(
          `/tenant/order-revisions/${po.open.id}/submit`,
          { rowVersion: po.open.rowVersion },
          manager,
        )
      ).json(),
    ).toMatchObject({
      code: 'make_not_approved',
      message: 'No approved make yet for WPC Waterproofing compound.',
    });
    const sub = await ok<{ id: string }>(
      post(
        `/tenant/projects/${projectId}/material-approvals`,
        { resourceId: wp, make: 'Dr. Fixit LW+', sampleRef: 'S-07' },
        worker,
      ),
    );
    expect(
      (await post(`/tenant/material-approvals/${sub.id}/decide`, { status: 'approved' }, worker))
        .statusCode,
    ).toBe(403);
    await ok(
      post(
        `/tenant/material-approvals/${sub.id}/decide`,
        { status: 'approved', comments: 'As per spec' },
        manager,
      ),
    );
    expect(
      await ok(
        post(
          `/tenant/order-revisions/${po.open.id}/submit`,
          { rowVersion: po.open.rowVersion },
          manager,
        ),
      ),
    ).toMatchObject({
      status: 'issued',
    });
  });
});
