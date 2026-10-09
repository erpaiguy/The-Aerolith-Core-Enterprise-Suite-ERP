// Tender management detail in a real tenant database (docs/wave1-plan.md step 8): pre-bid queries, addenda that move
// the due date, EMD and bank guarantees with their reminders, the checklist (and who may tick it), submission with
// the BOQ freeze, the opening, the result, the agenda and the win/loss analysis.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { CHECKLIST_TEMPLATE, DEFAULT_CRITERIA, financialYear } from '../src/tender/tender-rules.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);
const DAY = 86_400_000;

interface Work {
  queries: { id: string; seq: number; status: string; sentOn: string | null; rowVersion: number }[];
  addenda: {
    id: string;
    ref: string;
    acknowledged: boolean;
    dueAfter: string | null;
    rowVersion: number;
  }[];
  securities: {
    id: string;
    status: string;
    shortOfValidity: boolean;
    returnedOn: string | null;
    rowVersion: number;
  }[];
  checklist: {
    id: string;
    title: string;
    status: string;
    required: boolean;
    assignee: string | null;
    rowVersion: number;
  }[];
  submissions: { kind: string; bidValue: string | null }[];
  bids: { name: string | null; us: boolean; rank: number | null; quotedValue: string | null }[];
  opening: { bidders: number; ourRank: number | null; aboveL1Pct: number | null } | null;
  bidValidityEnd: string | null;
  readiness: {
    checklistRequired: number;
    checklistPending: string[];
    addendaUnacknowledged: number;
    emdRequired: boolean;
    emdCovered: boolean;
    queriesUnanswered: number;
  };
}

describe.skipIf(!controlUrl || !adminUrl)('tender management (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let tenderId: string;
  const due = new Date(Date.now() + 20 * DAY);

  const post = (url: string, payload: object = {}, headers: Record<string, string> = manager) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = manager) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.statusCode === 204 ? (undefined as T) : res.json<T>();
  };
  const work = (headers: Record<string, string> = manager) =>
    ok<Work>(get(`/tenant/tenders/${tenderId}/work`, headers));
  const reminders = (source: string) =>
    db<{ title: string; due_at: Date; read_at: Date | null; user_id: string }[]>`
      SELECT title, due_at, read_at, user_id FROM platform.notification WHERE source = ${source} ORDER BY due_at`;

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
      RATE_LIMIT_SCALE: '20',
      PUBLIC_API_URL: 'https://api.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'bids-admin@example.in');
    manager = await staff('kavita', 'manager');
    worker = await staff('sunil', 'worker');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    const people = await ok<{ id: string; displayName: string }[]>(get('/tenant/people'));
    workerId = people.find((p) => p.displayName === 'sunil')!.id;
    const tender = await ok<{ id: string }>(
      post('/tenant/tenders', {
        title: 'District court annexe, Amravati',
        estimatedValue: '45000000',
        emdAmount: '450000',
        submissionDueAt: due.toISOString(),
        queriesDueAt: new Date(Date.now() + 5 * DAY).toISOString(),
        bidValidityDays: 90,
      }),
    );
    tenderId = tender.id;
    await ok(post(`/tenant/tenders/${tenderId}/status`, { to: 'evaluating' }));
    await ok(
      post(`/tenant/tenders/${tenderId}/decision`, {
        criteria: DEFAULT_CRITERIA.map((c) => ({ key: c.key, weight: c.weight, score: 4 })),
        decision: 'bid',
      }),
    );
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('numbers pre-bid queries and follows them from draft to answered', async () => {
    const q1 = await ok<{ id: string; seq: number }>(
      post(`/tenant/tenders/${tenderId}/queries`, {
        reference: 'BOQ item 4.2',
        question: 'Is the RMC grade M25 or M30 for the raft?',
      }),
    );
    const q2 = await ok<{ id: string; seq: number }>(
      post(`/tenant/tenders/${tenderId}/queries`, {
        question: 'Can the completion period be 18 months?',
      }),
    );
    expect([q1.seq, q2.seq]).toEqual([1, 2]);
    expect(
      (await post(`/tenant/tenders/${tenderId}/queries`, { question: 'No' }, worker)).statusCode,
    ).toBe(403);

    let w = await work();
    const rv = (id: string) => w.queries.find((q) => q.id === id)!.rowVersion;
    // A draft cannot jump to answered, and an answer needs text.
    expect(
      (await post(`/tenant/queries/${q1.id}`, { rowVersion: rv(q1.id), status: 'answered' }))
        .statusCode,
    ).toBe(400);
    await ok(post(`/tenant/queries/${q1.id}`, { rowVersion: rv(q1.id), status: 'sent' }));
    w = await work();
    expect(w.queries[0]).toMatchObject({ status: 'sent' });
    expect(w.queries[0]!.sentOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(w.readiness.queriesUnanswered).toBe(1);
    // Sent queries are not reworded, nor deleted.
    const reword = await post(`/tenant/queries/${q1.id}`, {
      rowVersion: rv(q1.id),
      question: 'Changed?',
    });
    expect(reword.json()).toMatchObject({ code: 'query_sent' });
    expect((await post(`/tenant/queries/${q1.id}/delete`)).statusCode).toBe(409);
    const noAnswer = await post(`/tenant/queries/${q1.id}`, {
      rowVersion: rv(q1.id),
      status: 'answered',
    });
    expect(noAnswer.json()).toMatchObject({ code: 'answer_required' });
    await ok(
      post(`/tenant/queries/${q1.id}`, {
        rowVersion: rv(q1.id),
        status: 'answered',
        answer: 'M30, see corrigendum 1.',
      }),
    );
    expect(
      (await post(`/tenant/queries/${q1.id}`, { rowVersion: 1, answer: 'x' })).json(),
    ).toMatchObject({
      code: 'stale_row',
    });
    // Drafts may simply go.
    expect((await post(`/tenant/queries/${q2.id}/delete`)).statusCode).toBe(204);
    w = await work();
    expect(w.queries.map((q) => [q.seq, q.status])).toEqual([[1, 'answered']]);
    expect(w.readiness.queriesUnanswered).toBe(0);
  });

  it('records addenda; one that moves the submission date moves the tender and its reminders', async () => {
    const newDue = new Date(due.getTime() + 7 * DAY);
    await ok(
      post(`/tenant/tenders/${tenderId}/addenda`, {
        ref: 'Corrigendum 1',
        issuedOn: '2026-10-10',
        summary: 'Raft concrete grade revised to M30; BOQ items 4.2 and 4.3 revised.',
        affectsBoq: true,
        newSubmissionDueAt: newDue.toISOString(),
      }),
    );
    const tender = await ok<{
      submissionDueAt: string;
      events: { kind: string; data: Record<string, unknown> }[];
    }>(get(`/tenant/tenders/${tenderId}`));
    expect(new Date(tender.submissionDueAt).getTime()).toBe(newDue.getTime());
    expect(tender.events[0]).toMatchObject({ kind: 'addendum', data: { ref: 'Corrigendum 1' } });
    const due3 = (await reminders(`tender:${tenderId}`)).find((r) =>
      r.title.includes('due in 3 days'),
    )!;
    expect(due3.due_at.getTime()).toBe(newDue.getTime() - 3 * DAY);

    const dup = await post(`/tenant/tenders/${tenderId}/addenda`, {
      ref: 'corrigendum 1',
      issuedOn: '2026-10-11',
      summary: 'Same number again',
    });
    expect(dup.json()).toMatchObject({ code: 'addendum_ref_taken' });
    let w = await work();
    expect(w.addenda).toHaveLength(1);
    expect(w.addenda[0]!.dueAfter).not.toBeNull();
    expect(w.readiness.addendaUnacknowledged).toBe(1);
    await ok(
      post(`/tenant/addenda/${w.addenda[0]!.id}`, {
        rowVersion: w.addenda[0]!.rowVersion,
        acknowledged: true,
      }),
    );
    w = await work();
    expect(w.readiness.addendaUnacknowledged).toBe(0);
  });

  it('tracks the EMD bank guarantee: expiry reminders, and a warning when it runs out before the bid validity', async () => {
    let w = await work();
    expect(w.readiness).toMatchObject({ emdRequired: true, emdCovered: false });
    const end = w.bidValidityEnd!;
    const plus = (iso: string, days: number) =>
      new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
    const short = await ok<{ id: string }>(
      post(`/tenant/tenders/${tenderId}/securities`, {
        form: 'bank_guarantee',
        amount: '450000',
        bank: 'State Bank of India, Amravati',
        instrumentNo: 'BG/0042/26',
        issuedOn: plus(end, -100),
        validUntil: plus(end, -10),
        status: 'issued',
      }),
    );
    w = await work();
    expect(w.securities[0]).toMatchObject({ id: short.id, shortOfValidity: true });
    expect(w.readiness.emdCovered).toBe(true);
    const rs = await reminders(`security:${short.id}`);
    expect(rs.map((r) => r.title)).toEqual([
      expect.stringContaining('expires in 30 days'),
      expect.stringContaining('expires in 7 days'),
    ]);
    // 09:00 in India, 30 days before the expiry date.
    expect(rs[0]!.due_at.toISOString()).toBe(
      new Date(Date.parse(`${plus(end, -40)}T03:30:00Z`)).toISOString(),
    );
    // Extended: no longer short, and the reminders follow the new date.
    await ok(
      post(`/tenant/securities/${short.id}`, {
        rowVersion: w.securities[0]!.rowVersion,
        validUntil: plus(end, 45),
        status: 'submitted',
      }),
    );
    w = await work();
    expect(w.securities[0]).toMatchObject({ shortOfValidity: false, status: 'submitted' });
    expect((await reminders(`security:${short.id}`))[0]!.title).toContain(plus(end, 45));
    expect(
      (await post(`/tenant/tenders/${tenderId}/securities`, { form: 'fdr', amount: '1' }, worker))
        .statusCode,
    ).toBe(403);
  });

  it('adds the standard checklist once, lets the assignee tick their own item, and reminds them', async () => {
    const first = await ok<{ added: number }>(
      post(`/tenant/tenders/${tenderId}/checklist/standard`),
    );
    expect(first.added).toBe(CHECKLIST_TEMPLATE.length);
    expect(
      (await ok<{ added: number }>(post(`/tenant/tenders/${tenderId}/checklist/standard`))).added,
    ).toBe(0);
    const dueOn = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const mine = await ok<{ id: string }>(
      post(`/tenant/tenders/${tenderId}/checklist`, {
        title: 'Labour cess registration',
        assigneeId: workerId,
        dueOn,
      }),
    );
    expect((await reminders(`checklist:${mine.id}`)).map((r) => [r.user_id, r.title])).toEqual([
      [workerId, expect.stringContaining('Labour cess registration')],
    ]);
    let w = await work(worker);
    const item = w.checklist.find((c) => c.id === mine.id)!;
    expect(item.assignee).toBe('sunil');
    // The worker may report their own item ready, but not retitle it or tick someone else's.
    expect(
      (
        await post(
          `/tenant/checklist/${mine.id}`,
          { rowVersion: item.rowVersion, title: 'Renamed' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    const other = w.checklist.find((c) => c.title === 'PAN card')!;
    expect(
      (
        await post(
          `/tenant/checklist/${other.id}`,
          { rowVersion: other.rowVersion, status: 'ready' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    await ok(
      post(
        `/tenant/checklist/${mine.id}`,
        { rowVersion: item.rowVersion, status: 'ready' },
        worker,
      ),
    );
    expect(await reminders(`checklist:${mine.id}`)).toEqual([]);

    w = await work();
    const required = CHECKLIST_TEMPLATE.filter((c) => c.required).length + 1;
    expect(w.readiness.checklistRequired).toBe(required);
    expect(w.readiness.checklistPending).toHaveLength(required - 1);
    expect(w.readiness.checklistPending).not.toContain('Labour cess registration');
    const pan = w.checklist.find((c) => c.title === 'PAN card')!;
    await ok(
      post(`/tenant/checklist/${pan.id}`, { rowVersion: pan.rowVersion, status: 'not_applicable' }),
    );
    expect((await work()).readiness.checklistPending).not.toContain('PAN card');
    expect((await post(`/tenant/checklist/${pan.id}/delete`)).statusCode).toBe(204);
  });

  it('records the submission (freezing the BOQs) and a revised offer; bid values only for pricing roles', async () => {
    const boq = await ok<{ id: string }>(
      post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Civil' }),
    );
    const early = await post(`/tenant/tenders/${tenderId}/bids`, {
      bids: [{ us: true, quotedValue: '1' }],
    });
    expect(early.json()).toMatchObject({ code: 'not_opened' });
    const submitted = await ok<{ status: string }>(
      post(`/tenant/tenders/${tenderId}/submissions`, {
        submittedAt: new Date().toISOString(),
        mode: 'portal',
        reference: 'CPPP/ACK/77810',
        bidValue: '43950000',
      }),
    );
    expect(submitted.status).toBe('submitted');
    const v = await ok<{ current: { status: string } }>(get(`/tenant/boqs/${boq.id}/versions`));
    expect(v.current.status).toBe('submitted');
    // Deadline reminders stop once the bid is in.
    expect(
      await db`SELECT 1 FROM platform.notification WHERE source = ${`tender:${tenderId}`} AND due_at > now()`,
    ).toEqual([]);
    await ok(
      post(`/tenant/tenders/${tenderId}/submissions`, {
        submittedAt: new Date().toISOString(),
        mode: 'email',
        bidValue: '43500000',
        notes: 'After negotiation',
      }),
    );
    expect((await work()).submissions).toEqual([
      expect.objectContaining({ kind: 'original', bidValue: '43950000.00' }),
      expect.objectContaining({ kind: 'revised', bidValue: '43500000.00' }),
    ]);
    expect((await work(worker)).submissions.map((s) => s.bidValue)).toEqual([null, null]);
  });

  it('ranks the bids read out at the opening and adds new competitors to the party master', async () => {
    const res = await ok<Work>(
      post(`/tenant/tenders/${tenderId}/bids`, {
        bids: [
          { us: true, quotedValue: '43500000' },
          { name: 'Vidarbha Infracon', quotedValue: '41760000' },
          { name: 'Deccan Builders', quotedValue: '44100000' },
          { name: 'Sai Constructions', qualified: false },
        ],
      }),
    );
    expect(res.bids.map((b) => [b.us ? 'us' : b.name, b.rank])).toEqual([
      ['Vidarbha Infracon', 1],
      ['us', 2],
      ['Deccan Builders', 3],
      ['Sai Constructions', null],
    ]);
    expect(res.opening).toMatchObject({ bidders: 4, ourRank: 2, aboveL1Pct: 4.17 });
    const competitors = await ok<{ name: string }[]>(get('/tenant/parties?kind=competitor'));
    expect(competitors.map((c) => c.name)).toEqual([
      'Deccan Builders',
      'Sai Constructions',
      'Vidarbha Infracon',
    ]);
    const dup = await post(`/tenant/tenders/${tenderId}/bids`, {
      bids: [{ name: 'Deccan Builders' }, { name: 'deccan builders' }],
    });
    expect(dup.json()).toMatchObject({ code: 'duplicate_bidder' });
  });

  it('records a loss with who won and why, and asks for the EMD back', async () => {
    const lost = await ok<{ status: string; resultCategory: string; awardedTo: { name: string } }>(
      post(`/tenant/tenders/${tenderId}/result`, {
        outcome: 'lost',
        category: 'price',
        reason: 'L2, 4.2 % above L1',
        value: '41760000',
        winnerName: 'Vidarbha Infracon',
      }),
    );
    expect(lost).toMatchObject({
      status: 'lost',
      resultCategory: 'price',
      awardedTo: { name: 'Vidarbha Infracon' },
    });
    const w = await work();
    const back = await reminders(`security-return:${w.securities[0]!.id}`);
    expect(back).toHaveLength(1);
    expect(back[0]!.title).toContain('EMD');
    // The guarantee came back: the reminder is done.
    await ok(
      post(`/tenant/securities/${w.securities[0]!.id}`, {
        rowVersion: w.securities[0]!.rowVersion,
        status: 'returned',
      }),
    );
    expect((await reminders(`security-return:${w.securities[0]!.id}`))[0]!.read_at).not.toBeNull();
    expect((await work()).securities[0]!.returnedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('lists coming dates on the agenda', async () => {
    const open = await ok<{ id: string }>(
      post('/tenant/tenders', {
        title: 'ITI workshop, Wardha',
        submissionDueAt: new Date(Date.now() + 4 * DAY).toISOString(),
        prebidAt: new Date(Date.now() + 2 * DAY).toISOString(),
      }),
    );
    const far = await ok<{ id: string }>(
      post('/tenant/tenders', {
        title: 'Hostel, Nagpur',
        submissionDueAt: new Date(Date.now() + 90 * DAY).toISOString(),
      }),
    );
    const agenda = await ok<{ kind: string; tender: { id: string } }[]>(
      get('/tenant/tender-agenda?days=30', worker),
    );
    const kinds = (id: string) => agenda.filter((a) => a.tender.id === id).map((a) => a.kind);
    expect(kinds(open.id)).toEqual(['prebid', 'submission']);
    expect(kinds(far.id)).toEqual([]);
  });

  it('analyses wins and losses by financial year; only for pricing roles', async () => {
    expect((await get('/tenant/tender-analysis', worker)).statusCode).toBe(403);
    // A second tender, won against Deccan Builders.
    const won = await ok<{ id: string }>(
      post('/tenant/tenders', {
        title: 'PHC building, Achalpur',
        submissionDueAt: new Date().toISOString(),
      }),
    );
    await ok(post(`/tenant/tenders/${won.id}/status`, { to: 'evaluating' }));
    await ok(
      post(`/tenant/tenders/${won.id}/decision`, {
        criteria: DEFAULT_CRITERIA.map((c) => ({ key: c.key, weight: c.weight, score: 4 })),
        decision: 'bid',
      }),
    );
    await ok(
      post(`/tenant/tenders/${won.id}/submissions`, {
        submittedAt: new Date().toISOString(),
        mode: 'physical',
        bidValue: '12000000',
      }),
    );
    await ok(
      post(`/tenant/tenders/${won.id}/bids`, {
        bids: [
          { us: true, quotedValue: '12000000' },
          { name: 'Deccan Builders', quotedValue: '12600000' },
        ],
      }),
    );
    await ok(post(`/tenant/tenders/${won.id}/result`, { outcome: 'won', value: '11900000' }));

    const fy = financialYear(new Date());
    const a = await ok<{
      years: string[];
      totals: Record<string, unknown>;
      lossReasons: { category: string; count: number }[];
      position: Record<string, unknown>;
      competitors: {
        name: string;
        met: number;
        beatUs: number;
        weBeat: number;
        won: number;
        avgGapPct: number;
      }[];
    }>(get(`/tenant/tender-analysis?fy=${fy}`));
    expect(a.years).toEqual([fy]);
    expect(a.totals).toMatchObject({
      submitted: 2,
      won: 1,
      lost: 1,
      pending: 0,
      winRatePct: 50,
      bidValue: '55500000.00',
      wonValue: '11900000.00',
    });
    expect(a.lossReasons).toEqual([{ category: 'price', count: 1 }]);
    expect(a.position).toMatchObject({ opened: 2, l1: 1, avgAboveL1Pct: 4.17 });
    expect(a.competitors.find((c) => c.name === 'Deccan Builders')).toMatchObject({
      met: 2,
      beatUs: 0,
      weBeat: 2,
      won: 0,
    });
    expect(a.competitors.find((c) => c.name === 'Vidarbha Infracon')).toMatchObject({
      met: 1,
      beatUs: 1,
      won: 1,
      avgGapPct: -4,
    });
    expect((await get('/tenant/tender-analysis?fy=2019-20')).json()).toMatchObject({
      totals: { submitted: 0 },
    });
  });
});
