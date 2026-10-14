// Project registers in a real tenant database (docs/wave7-plan.md steps 7d.1–7d.4): minutes with actions owned by
// the team and closed by them; letters in and out, numbered, answered and closed; the master document list with its
// late flags; the inspection and test plan against the quality records; safety walks with findings owned and closed;
// a site imprest advanced, spent, settled in the books and squared; recurring vouchers and bills drafted when due;
// joining and exit checklists, partly answered by the records; the company dashboard over them. All kept to the team.
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

describe.skipIf(!controlUrl || !adminUrl)('project registers (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let lata: { id: string; headers: Record<string, string> };
  let projectId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-mtg-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'mtg-admin@example.in');
    // Five people: more than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    lata = await staff('lata', 'worker');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('records minutes with actions for the team, closed by their owners and in their work', async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    interface Meeting {
      id: string;
      number: string;
      actions: { id: string; description: string; owner: string; status: string }[];
    }
    // An action for someone off the team is refused; someone off the team cannot record.
    const body = {
      title: 'Site progress review',
      heldOn: '2026-10-05',
      place: 'Site office',
      attendees: 'Suresh (PM), Raju (engineer), client EE',
      minutes: 'Slab 2 behind by a week.',
      decisions: 'Night shift for slab 2.',
      actions: [
        { description: 'Arrange lights for night work', ownerId: workerId, dueOn: '2026-10-08' },
      ],
    };
    expect(
      (await post(`/tenant/projects/${projectId}/meetings`, body, lata.headers)).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/meetings`,
          {
            ...body,
            actions: [{ ...body.actions[0], ownerId: lata.id }],
          },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_on_project' });
    const m = await ok<Meeting>(post(`/tenant/projects/${projectId}/meetings`, body, manager));
    expect(m.number).toBe('MOM-001');
    expect(m.actions.map((a) => [a.description, a.owner, a.status])).toEqual([
      ['Arrange lights for night work', 'raju', 'open'],
    ]);
    // In Raju's work until done; Lata (off the team) cannot close it; Raju does.
    let work = await ok<{ actions: { count: number } }>(get('/tenant/my-work', worker));
    expect(work.actions.count).toBe(1);
    expect(
      (await post(`/tenant/meeting-actions/${m.actions[0]!.id}/done`, {}, lata.headers)).statusCode,
    ).toBe(404);
    const done = await ok<Meeting>(
      post(`/tenant/meeting-actions/${m.actions[0]!.id}/done`, { note: 'Fitted' }, worker),
    );
    expect(done.actions[0]!.status).toBe('done');
    work = await ok<{ actions: { count: number } }>(get('/tenant/my-work', worker));
    expect(work.actions.count).toBe(0);
    expect(
      (
        await ok<{ meetings: { open: number }[] }>(
          get(`/tenant/projects/${projectId}/meetings`, worker),
        )
      ).meetings,
    ).toEqual([expect.objectContaining({ open: 0 })]);
  });

  it('keeps letters in and out, numbered, answered and closed', async () => {
    interface Letters {
      letters: {
        id: string;
        number: string;
        status: string;
        answeredBy: string | null;
        replyToNumber: string | null;
      }[];
    }
    const inbound = await ok<Letters>(
      post(
        `/tenant/projects/${projectId}/letters`,
        {
          direction: 'in',
          letterDate: '2026-10-06',
          party: 'Executive Engineer, PWD Washim',
          reference: 'EE/WSM/2026/411',
          subject: 'Slow progress on slab 2',
          replyBy: '2026-10-10',
        },
        worker,
      ),
    );
    const letter = inbound.letters[0]!;
    expect([letter.number, letter.status]).toEqual(['IN-001', 'open']);
    const after = await ok<Letters>(
      post(
        `/tenant/projects/${projectId}/letters`,
        {
          direction: 'out',
          letterDate: '2026-10-08',
          party: 'Executive Engineer, PWD Washim',
          subject: 'Re: Slow progress on slab 2',
          replyTo: letter.id,
        },
        manager,
      ),
    );
    const byNo = Object.fromEntries(after.letters.map((l) => [l.number, l]));
    expect(byNo['OUT-001']).toMatchObject({ replyToNumber: 'IN-001' });
    expect(byNo['IN-001']).toMatchObject({ status: 'closed', answeredBy: 'OUT-001' });
    const ins = await ok<Letters>(
      get(`/tenant/projects/${projectId}/letters?direction=in`, worker),
    );
    expect(ins.letters.map((l) => l.number)).toEqual(['IN-001']);
    expect((await get(`/tenant/projects/${projectId}/letters`, lata.headers)).statusCode).toBe(404);
  });

  it('lists the documents a project expects, flags the late ones and marks them received', async () => {
    interface Mdl {
      rows: {
        id: string;
        code: string;
        late: boolean;
        receivedOn: string | null;
        daysLate: number;
      }[];
      totals: { expected: number; received: number; late: number; receivedLate: number };
    }
    const url = `/tenant/projects/${projectId}/expected-documents`;
    const items = [
      {
        code: 'STR-101',
        title: 'Footing layout',
        fromParty: 'Structural consultant',
        plannedOn: '2026-01-10',
      },
      {
        code: 'ARC-201',
        title: 'Ground floor plan',
        category: 'drawing',
        fromParty: 'Architect',
        plannedOn: '2099-01-10',
      },
    ];
    expect((await post(url, { items }, lata.headers)).statusCode).toBe(404);
    expect((await post(url, { items: [items[0], items[0]] }, worker)).json()).toMatchObject({
      code: 'duplicate_code',
    });
    let mdl = await ok<Mdl>(post(url, { items }, worker));
    expect(mdl.totals).toEqual({ expected: 2, received: 0, late: 1, receivedLate: 0 });
    expect((await post(url, { items: [items[0]] }, manager)).statusCode).toBe(409);
    const late = mdl.rows.find((r) => r.code === 'STR-101')!;
    expect(late.late).toBe(true);
    mdl = await ok<Mdl>(
      post(`/tenant/expected-documents/${late.id}/received`, { receivedOn: '2026-01-15' }, worker),
    );
    expect(mdl.rows.find((r) => r.code === 'STR-101')).toMatchObject({
      receivedOn: '2026-01-15',
      late: false,
      daysLate: 5,
    });
    expect(mdl.totals).toEqual({ expected: 2, received: 1, late: 0, receivedLate: 1 });
    expect((await get(url, lata.headers)).statusCode).toBe(404);
  });

  it('sets an inspection and test plan and counts what the quality records show done', async () => {
    const tpl = await ok<{ id: string; name: string }[]>(
      post(
        '/tenant/quality/checklist-templates',
        {
          name: 'Pour card',
          workType: 'RCC',
          items: [{ text: 'Shuttering checked', kind: 'yes_no' }],
        },
        manager,
      ),
    );
    const templateId = tpl.find((x) => x.name === 'Pour card')!.id;
    interface Itp {
      lines: {
        id: string;
        activity: string;
        checklistsDone: number;
        checklistsFailed: number;
        testsDone: number;
      }[];
      mayEdit: boolean;
    }
    const url = `/tenant/projects/${projectId}/itp`;
    const line = {
      activity: 'Slab concreting',
      checklistTemplateId: templateId,
      testKind: 'cube',
      frequency: 'Each pour',
      holdPoint: true,
      responsible: 'QA engineer',
    };
    // The lead sets the plan; a member reads it.
    expect((await post(url, line, worker)).statusCode).toBe(403);
    expect((await post(url, { activity: 'Nothing' }, manager)).json()).toMatchObject({
      code: 'nothing_to_check',
    });
    await ok(post(url, line, manager));
    await ok(
      post(
        `/tenant/projects/${projectId}/checklists`,
        { templateId, doneOn: '2026-10-07', location: 'Slab 2', answers: [{ answer: 'no' }] },
        worker,
      ),
    );
    const plan = await ok<Itp>(get(url, worker));
    expect(plan.mayEdit).toBe(false);
    expect(plan.lines).toEqual([
      expect.objectContaining({
        activity: 'Slab concreting',
        checklistsDone: 1,
        checklistsFailed: 1,
        testsDone: 0,
      }),
    ]);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/tenant/itp-lines/${plan.lines[0]!.id}`,
          headers: worker,
        })
      ).statusCode,
    ).toBe(403);
    const gone = await ok<Itp>(
      app.inject({
        method: 'DELETE',
        url: `/api/tenant/itp-lines/${plan.lines[0]!.id}`,
        headers: manager,
      }),
    );
    expect(gone.lines).toEqual([]);
  });

  it("records a site walk whose findings wait in their owners' work until closed", async () => {
    interface Walk {
      id: string;
      number: string;
      status: string;
      findings: { id: string; severity: string; owner: string; status: string; closure: string }[];
    }
    const url = `/tenant/projects/${projectId}/site-walks`;
    const body = {
      walkedOn: '2026-10-09',
      area: 'Slab 2 and scaffolds',
      walkedBy: 'Safety officer',
      findings: [
        {
          observation: 'Edge protection missing at slab 2',
          severity: 'high',
          action: 'Fix guard rails',
          ownerId: workerId,
          dueOn: '2026-10-10',
        },
        { observation: 'Debris on stair', severity: 'low', ownerId: workerId, dueOn: '2026-10-12' },
      ],
    };
    expect((await post(url, body, lata.headers)).statusCode).toBe(404);
    expect(
      (
        await post(url, { ...body, findings: [{ ...body.findings[0], ownerId: lata.id }] }, manager)
      ).json(),
    ).toMatchObject({ code: 'not_on_project' });
    const w = await ok<Walk>(post(url, body, manager));
    expect([w.number, w.status]).toEqual(['SW-001', 'open']);
    expect(w.findings.map((f) => [f.severity, f.owner, f.status])).toEqual([
      ['high', 'raju', 'open'],
      ['low', 'raju', 'open'],
    ]);
    let work = await ok<{ findings: { count: number } }>(get('/tenant/my-work', worker));
    expect(work.findings.count).toBe(2);
    const close = (id: string, h: Record<string, string>) =>
      post(
        `/tenant/walk-findings/${id}/close`,
        { closedOn: '2026-10-10', closure: 'Rails fixed' },
        h,
      );
    expect((await close(w.findings[0]!.id, lata.headers)).statusCode).toBe(404);
    await ok(close(w.findings[0]!.id, worker));
    const last = await ok<Walk>(close(w.findings[1]!.id, manager));
    expect(last.status).toBe('closed');
    expect(last.findings[0]).toMatchObject({ status: 'closed', closure: 'Rails fixed' });
    work = await ok<{ findings: { count: number } }>(get('/tenant/my-work', worker));
    expect(work.findings.count).toBe(0);
    expect(
      (await ok<{ walks: { open: number; findings: number }[] }>(get(url, worker))).walks,
    ).toEqual([expect.objectContaining({ open: 0, findings: 2 })]);
  });

  it('advances a site imprest, takes its spends into the books and squares it', async () => {
    interface Imprest {
      id: string;
      status: string;
      totals: { advanced: string; spent: string; unsettled: string; balance: string };
      entries: { kind: string; amount: string; voucher: string | null; settled: boolean }[];
      moneyLedgers: { id: string; name: string }[];
      expenseLedgers: { id: string; name: string }[];
      maySpend: boolean;
    }
    // Accounts opens it for Raju, on the team; Lata (off the team) cannot hold one.
    const url = `/tenant/projects/${projectId}/imprests`;
    expect((await post(url, { custodianId: lata.id }, t.admin)).json()).toMatchObject({
      code: 'not_on_project',
    });
    expect((await post(url, { custodianId: workerId }, worker)).statusCode).toBe(403);
    let imp = await ok<Imprest>(post(url, { custodianId: workerId, floatLimit: '20000' }, t.admin));
    const cash = imp.moneyLedgers.find((l) => l.name === 'Cash in hand')!.id;
    const overheads = imp.expenseLedgers.find((l) => l.name === 'Site overheads')!.id;
    const at = (path: string, body: object, h: Record<string, string> = t.admin) =>
      post(`/tenant/imprests/${imp.id}/${path}`, body, h);
    expect(
      (await at('advances', { date: '2026-10-01', amount: '25000', accountId: cash })).json(),
    ).toMatchObject({ code: 'over_limit' });
    imp = await ok<Imprest>(
      at('advances', { date: '2026-10-01', amount: '15000', accountId: cash }),
    );
    expect(imp.entries[0]).toMatchObject({ kind: 'advance', voucher: expect.any(String) });
    // Raju spends; not more than he holds; not into a bank ledger.
    const spend = { date: '2026-10-03', accountId: overheads, description: 'Tea and water' };
    expect((await at('expenses', { ...spend, amount: '16000' }, worker)).json()).toMatchObject({
      code: 'over_balance',
    });
    expect(
      (await at('expenses', { ...spend, amount: '100', accountId: cash }, worker)).json(),
    ).toMatchObject({ code: 'not_expense' });
    await ok(at('expenses', { ...spend, amount: '1200.50', reference: 'Bill 14' }, worker));
    imp = await ok<Imprest>(
      at('expenses', { ...spend, amount: '800', description: 'Nails' }, worker),
    );
    expect(imp.totals).toMatchObject({
      spent: '2000.50',
      unsettled: '2000.50',
      balance: '12999.50',
    });
    // Only accounts settles; the settlement is one journal for both spends.
    expect((await at('settle', { date: '2026-10-05' }, worker)).statusCode).toBe(403);
    imp = await ok<Imprest>(at('settle', { date: '2026-10-05' }));
    const spent = imp.entries.filter((e) => e.kind === 'expense');
    expect(spent.every((e) => e.settled && e.voucher === spent[0]!.voucher)).toBe(true);
    expect(imp.totals.unsettled).toBe('0.00');
    // Not closed while money is in hand; taking the rest back closes it.
    expect((await at('take-back', { date: '2026-10-06', close: true })).json()).toMatchObject({
      code: 'not_squared',
    });
    imp = await ok<Imprest>(
      at('take-back', { date: '2026-10-06', amount: '12999.50', accountId: cash, close: true }),
    );
    expect([imp.status, imp.totals.balance]).toEqual(['closed', '0.00']);
    expect((await get(url, lata.headers)).statusCode).toBe(404);
  });

  it('drafts recurring vouchers and bills on their due days, for accounts to post or skip', async () => {
    const entityId = (await ok<{ companies: { id: string }[] }>(get('/tenant/companies')))
      .companies[0]!.id;
    const chart = await ok<{ accounts: { id: string; systemKey: string | null }[] }>(
      get('/tenant/accounts/chart'),
    );
    const acct = (k: string) => chart.accounts.find((a) => a.systemKey === k)!.id;
    const supplier = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Shree Gurudatta Estates',
          isClient: false,
          isVendor: true,
        }),
      )
    ).id;
    const firstOf = (back: number) => {
      const d = new Date(Date.now() + 330 * 60_000);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1))
        .toISOString()
        .slice(0, 10);
    };
    const url = '/tenant/accounts/recurring';
    expect(
      (
        await post(url, {
          entityId,
          kind: 'voucher',
          name: 'Bad',
          startsOn: firstOf(0),
          voucher: {
            type: 'payment',
            lines: [
              { accountId: acct('site_overheads'), debit: '100', projectId },
              { accountId: acct('cash'), credit: '90' },
            ],
          },
        })
      ).json(),
    ).toMatchObject({ code: 'unbalanced' });
    await ok(
      post(url, {
        entityId,
        kind: 'voucher',
        name: 'Site security',
        startsOn: firstOf(2),
        voucher: {
          type: 'payment',
          narration: 'Security agency',
          lines: [
            { accountId: acct('site_overheads'), debit: '18000', projectId },
            { accountId: acct('cash'), credit: '18000' },
          ],
        },
      }),
    );
    interface Recurring {
      templates: { name: string; due: number; amount: string; next: string | null }[];
      drafts: {
        id: string;
        name: string;
        dueOn: string;
        status: string;
        voucher: string | null;
        bill: string | null;
      }[];
    }
    let r = await ok<Recurring>(
      post(url, {
        entityId,
        kind: 'bill',
        name: 'Site office rent',
        frequency: 'yearly',
        startsOn: firstOf(0),
        bill: {
          partyId: supplier,
          projectId,
          lines: [
            { accountId: acct('site_overheads'), projectId, qty: '1', rate: '50000', gstPct: '18' },
          ],
        },
      }),
    );
    expect(r.templates.map((t) => [t.name, t.due, t.amount])).toEqual([
      ['Site office rent', 1, '50000.00'],
      ['Site security', 3, '18000.00'],
    ]);
    // Workers do not see the books; listing again drafts nothing twice.
    expect((await get(`${url}?entityId=${entityId}`, worker)).statusCode).toBe(403);
    r = await ok<Recurring>(get(`${url}?entityId=${entityId}`));
    expect(r.drafts.filter((d) => d.status === 'due')).toHaveLength(4);
    const security = r.drafts
      .filter((d) => d.name === 'Site security')
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
    const rent = r.drafts.find((d) => d.name === 'Site office rent')!;
    r = await ok<Recurring>(post(`/tenant/accounts/recurring-drafts/${security[0]!.id}/post`, {}));
    expect(r.drafts.find((d) => d.id === security[0]!.id)).toMatchObject({
      status: 'posted',
      voucher: expect.any(String),
    });
    expect(
      (await post(`/tenant/accounts/recurring-drafts/${security[0]!.id}/post`, {})).statusCode,
    ).toBe(409);
    await ok(
      post(`/tenant/accounts/recurring-drafts/${security[1]!.id}/skip`, { note: 'Paid by client' }),
    );
    expect(
      (await post(`/tenant/accounts/recurring-drafts/${rent.id}/post`, {})).json(),
    ).toMatchObject({
      code: 'bill_no',
    });
    r = await ok<Recurring>(
      post(`/tenant/accounts/recurring-drafts/${rent.id}/post`, { billNo: 'GE/RENT/1' }),
    );
    expect(r.drafts.find((d) => d.id === rent.id)).toMatchObject({
      status: 'posted',
      bill: 'GE/RENT/1',
    });
    expect(r.templates.find((t) => t.name === 'Site security')!.due).toBe(1);
  });

  it('keeps joining and exit checklists, the records answering their own steps', async () => {
    const entityId = (await ok<{ companies: { id: string }[] }>(get('/tenant/companies')))
      .companies[0]!.id;
    const emp = await ok<{ id: string }>(
      post('/tenant/hr/employees', {
        entityId,
        kind: 'staff',
        joinedOn: '2026-09-01',
        code: 'E901',
        name: 'Raju Wankhede',
        pan: 'ABCPW1234K',
        userId: workerId,
      }),
    );
    interface Lists {
      joining: {
        done: number;
        complete: boolean;
        steps: { id: string; key: string; auto: boolean; done: boolean }[];
      } | null;
      exit: { done: number; steps: { id: string; key: string; done: boolean }[] } | null;
    }
    const url = `/tenant/hr/employees/${emp.id}/checklists`;
    expect((await post(url, { kind: 'joining' }, worker)).statusCode).toBe(403);
    let c = await ok<Lists>(post(url, { kind: 'joining' }));
    expect((await post(url, { kind: 'joining' })).statusCode).toBe(409);
    const step = (k: string) => c.joining!.steps.find((s) => s.key === k)!;
    // PAN and the sign-in are on the record; the bank and UAN are not.
    expect([step('pan').done, step('sign_in').done, step('bank').done]).toEqual([
      true,
      true,
      false,
    ]);
    expect(c.joining!.done).toBe(2);
    expect(
      (await post(`/tenant/hr/checklist-steps/${step('pan').id}`, { done: false })).json(),
    ).toMatchObject({
      code: 'from_the_records',
    });
    c = await ok<Lists>(
      post(`/tenant/hr/checklist-steps/${step('induction').id}`, {
        done: true,
        note: 'Safety film shown',
      }),
    );
    expect(step('induction').done).toBe(true);
    expect(c.exit).toBeNull();
    c = await ok<Lists>(post(url, { kind: 'exit' }));
    expect(c.exit!.steps.find((s) => s.key === 'sign_in_closed')!.done).toBe(false);
    expect(c.exit!.steps.find((s) => s.key === 'settlement')!.done).toBe(false);
  });

  it("puts the company's order book, margin, cash, receivables, tenders and incidents on one page", async () => {
    const entityId = (await ok<{ companies: { id: string }[] }>(get('/tenant/companies')))
      .companies[0]!.id;
    const url = `/tenant/company-dashboard?entityId=${entityId}`;
    expect((await get(url, worker)).statusCode).toBe(403);
    const d = await ok<{
      fy: string;
      margin: { project: { id: string }; cost: string; revenue: string }[];
      cash: { ledgers: { name: string; balance: string }[]; total: string; guarantees: string };
      revenue: { months: { month: string; plan: string; actual: string | null }[] };
      receivablesOver90: { total: string };
      tendersDue: unknown[];
      incidents: { total: number };
    }>(get(url));
    expect(d.revenue.months).toHaveLength(12);
    // The imprest's spends and the security voucher are costs booked to the project.
    expect(Number(d.margin.find((m) => m.project.id === projectId)!.cost)).toBeGreaterThan(0);
    // Cash: 15,000 out to the imprest, 12,999.50 back, 18,000 paid for security.
    expect(d.cash.ledgers.find((l) => l.name === 'Cash in hand')!.balance).toBe('-20000.50');
    expect([d.receivablesOver90.total, d.tendersDue, d.incidents.total]).toEqual(['0.00', [], 0]);
  });
});
