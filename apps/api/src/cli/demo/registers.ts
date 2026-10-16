// The registers a job keeps beside its main work (docs/wave7-plan.md, wave 7d): monthly progress meetings with their
// actions, the client's letters and the answers, the documents the project waits for, its inspection and test plan,
// safety walks and what they found, and the site's petty-cash imprest. For the company: recurring rent and AMC
// entries, and the joining and exit checklists of its staff.
import { type Ctx, type ProjectState, as, bump, step } from './ctx.js';
import { siteTeam } from './people.js';
import { PARTIES, STAFF } from './plan.js';
import {
  type Day,
  addDays,
  addMonths,
  diffDays,
  firstOfMonth,
  lastOfMonth,
  minDay,
  money,
} from './util.js';

const at = (ps: ProjectState, frac: number): Day =>
  addDays(ps.plan.start, Math.round(diffDays(ps.end, ps.plan.start) * frac));

/** Scheduled once a project exists (called from projects.ts beside the other extras). */
export function scheduleProjectRegisters(c: Ctx, ps: ProjectState) {
  const key = ps.plan.key;
  const suresh = () => as(c, 'suresh');
  const when = (d: Day, order: number, label: string, f: () => Promise<unknown>) => {
    if (d <= c.today) c.sched.at(d, order, `${label} ${key}`, () => step(c, label, f));
  };
  // The site engineer (on the team, signing in) owns the site's actions and holds its imprest.
  const engineer = () => siteTeam(key).find((u) => ps.team.includes(u) && c.users[u]) ?? 'suresh';
  const lastDay = minDay(ps.end, c.today);
  const client = PARTIES.find((p) => p.key === ps.plan.client)?.name ?? 'The client';

  // --- 7d.3 the documents the project waits for ---
  when(addDays(ps.plan.start, -2), 45, 'expected documents', async () => {
    const list: [string, string, string, string, number][] = [
      [
        'ARC-GA',
        'General arrangement drawings, approved for construction',
        'drawing',
        "Client's architect",
        0.02,
      ],
      [
        'STR-FDN',
        'Foundation drawings and bar bending schedule',
        'drawing',
        'Structural consultant',
        0.04,
      ],
      ['SOIL', 'Soil investigation report', 'report', client, 0.03],
      ['MS-RCC', 'Method statement: RCC work', 'method_statement', 'Our planning cell', 0.06],
      ['MIX-M25', 'M25 design mix approval', 'approval', 'Testing laboratory', 0.08],
      [
        'TC-STEEL',
        'Mill test certificates for reinforcement',
        'test_certificate',
        'Shinde Steel Traders',
        0.12,
      ],
      ['STR-SUP', 'Superstructure drawings', 'drawing', 'Structural consultant', 0.2],
      ['MEP-LAY', 'Electrical and plumbing layouts', 'drawing', "Client's architect", 0.35],
      ['FIN-SCH', 'Finishes schedule', 'specification', "Client's architect", 0.55],
      ['OC-APP', 'Occupancy certificate application', 'approval', client, 0.95],
    ];
    const plan = list.map(([code, title, category, fromParty, frac]) => ({
      code,
      title,
      category,
      fromParty,
      plannedOn: at(ps, frac),
    }));
    const made = await c.s.post<{ rows: { id: string; code: string; plannedOn: string }[] }>(
      `/tenant/projects/${ps.id}/expected-documents`,
      { items: plan },
      suresh(),
    );
    bump(c, 'expected documents', made.rows.length);
    c.paths.push(`/projects/${ps.id}/document-list`);
    for (const row of made.rows) {
      // Most come within a fortnight either side of their date; one in seven not at all (yet).
      if (c.r.chance(0.15)) continue;
      const on = addDays(row.plannedOn, Math.round(c.r.between(-5, 21)));
      if (on > lastDay) continue;
      c.sched.at(on, 45, `document received ${key}`, () =>
        step(c, 'document received', () =>
          c.s.post(
            `/tenant/expected-documents/${row.id}/received`,
            { receivedOn: on, note: on > row.plannedOn ? 'Came after the date asked' : '' },
            as(c, engineer()),
          ),
        ),
      );
    }
  });

  // --- 7d.4 the inspection and test plan, set by the lead before the work starts ---
  when(addDays(ps.plan.start, 1), 46, 'inspection and test plan', async () => {
    const { templates } = await c.s.get<{ templates: { id: string; name: string }[] }>(
      `/tenant/projects/${ps.id}/itp`,
      suresh(),
    );
    const tpl = (word: string) =>
      templates.find((t) => t.name.toLowerCase().includes(word))?.id ?? null;
    const lines: [string, string, string | null, string | null, string, boolean][] = [
      ['Excavation and foundation bed', 'before', null, 'soil', 'Each footing', true],
      ['PCC below footings', 'during', null, 'slump', 'Each pour', false],
      [
        'RCC: shuttering and reinforcement',
        'before',
        tpl('concret') ?? tpl('rcc'),
        'steel',
        'Each pour; steel each lot',
        true,
      ],
      ['RCC: concreting', 'during', null, 'cube', 'Six cubes per 50 m³', true],
      [
        'Brick masonry',
        'during',
        tpl('masonry') ?? tpl('brick'),
        'brick',
        'Each lot of bricks',
        false,
      ],
    ];
    for (const [activity, stage, checklistTemplateId, testKind, frequency, holdPoint] of lines)
      await c.s.post(
        `/tenant/projects/${ps.id}/itp`,
        {
          activity,
          stage,
          checklistTemplateId,
          testKind,
          frequency,
          holdPoint,
          responsible: 'QA engineer',
        },
        suresh(),
      );
    bump(c, 'ITP lines', lines.length);
    c.paths.push(`/projects/${ps.id}/itp`);
  });

  // --- monthly: the progress meeting (7d.1) and a safety walk (7d.5) ---
  for (let m = firstOfMonth(addMonths(ps.plan.start, 1)); m <= lastDay; m = addMonths(m, 1)) {
    const held = addDays(m, 4);
    if (held > lastDay) break;
    when(held, 47, 'progress meeting', async () => {
      const owner = c.users[engineer()]!.id;
      const actions = [
        {
          description: 'Send the look-ahead for the next four weeks',
          ownerId: owner,
          dueOn: addDays(held, 5),
        },
        {
          description: 'Close the open snags on the last pour',
          ownerId: owner,
          dueOn: addDays(held, 10),
        },
      ];
      const mtg = await c.s.post<{ id: string; actions: { id: string; dueOn: string }[] }>(
        `/tenant/projects/${ps.id}/meetings`,
        {
          title: `Monthly progress review, ${held.slice(0, 7)}`,
          heldOn: held,
          place: 'Site office',
          attendees: `Suresh Patil (PM), site engineer, ${client}'s engineer`,
          minutes:
            'Progress against the programme reviewed; material and labour for next month agreed.',
          decisions: 'Keep two shifts on the critical activity until it is back on programme.',
          actions,
        },
        suresh(),
      );
      bump(c, 'meetings');
      c.paths.push(`/projects/${ps.id}/meetings`);
      for (const a of mtg.actions) {
        // Most are done a day or two after their date; the last month's may still be open.
        const done = addDays(a.dueOn, Math.round(c.r.between(-2, 4)));
        if (done <= minDay(lastDay, addDays(c.today, -3)))
          c.sched.at(done, 47, `action done ${key}`, () =>
            step(c, 'meeting action done', () =>
              c.s.post(`/tenant/meeting-actions/${a.id}/done`, { note: 'Done' }, as(c, engineer())),
            ),
          );
      }
    });

    const walked = addDays(m, 12);
    if (walked > lastDay) continue;
    when(walked, 48, 'site walk', async () => {
      const owner = c.users[engineer()]!.id;
      const seen: [string, 'low' | 'medium' | 'high', string][] = [
        ['Edge protection missing at the slab edge', 'high', 'Fix guard rails before work resumes'],
        ['Workers without helmets near the hoist', 'medium', 'Brief the gang; issue helmets'],
        ['Debris on the stair', 'low', 'Clear and keep a bin on each floor'],
        ['Loose wiring at the mixer', 'high', 'Electrician to make safe today'],
        ['Scaffold ties missing on the east face', 'medium', 'Tie in before the next lift'],
      ];
      const n = Math.round(c.r.between(1, 3));
      const findings = Array.from(
        { length: n },
        () => seen[Math.floor(c.r.between(0, seen.length))]!,
      )
        .filter((f, i, all) => all.findIndex((g) => g[0] === f[0]) === i)
        .map(([observation, severity, action]) => ({
          observation,
          severity,
          action,
          ownerId: owner,
          dueOn: addDays(walked, severity === 'high' ? 1 : 7),
        }));
      const walk = await c.s.post<{ findings: { id: string; dueOn: string }[] }>(
        `/tenant/projects/${ps.id}/site-walks`,
        { walkedOn: walked, area: 'Whole site', walkedBy: 'Rahul Ingole (safety)', findings },
        as(c, ps.team.includes('rahul') ? 'rahul' : 'suresh'),
      );
      bump(c, 'site walks');
      c.paths.push(`/projects/${ps.id}/site-walks`);
      for (const f of walk.findings) {
        const closed = addDays(f.dueOn, Math.round(c.r.between(0, 3)));
        if (closed <= minDay(lastDay, addDays(c.today, -2)))
          c.sched.at(closed, 48, `finding closed ${key}`, () =>
            step(c, 'safety finding closed', () =>
              c.s.post(
                `/tenant/walk-findings/${f.id}/close`,
                { closedOn: closed, closure: 'Put right and checked' },
                as(c, engineer()),
              ),
            ),
          );
      }
    });
  }

  // --- 7d.2 the client's letters ---
  when(addDays(ps.plan.start, -1), 49, 'letters', async () => {
    await c.s.post(
      `/tenant/projects/${ps.id}/letters`,
      {
        direction: 'out',
        letterDate: addDays(ps.plan.start, -1),
        party: client,
        subject: 'Acceptance of the work order and start of work',
        summary: 'We accept the work order and will start on site on the agreed date.',
      },
      suresh(),
    );
    bump(c, 'letters');
    c.paths.push(`/projects/${ps.id}/letters`);
  });
  const nudge = at(ps, 0.4);
  when(nudge, 49, 'client letter', async () => {
    const got = await c.s.post<{ letters: { id: string; number: string }[] }>(
      `/tenant/projects/${ps.id}/letters`,
      {
        direction: 'in',
        letterDate: nudge,
        party: client,
        reference: `${ps.plan.key.toUpperCase()}/EE/${nudge.slice(5, 7)}`,
        subject: 'Progress of the work against the programme',
        summary: 'Asks for a recovery plan for the activities behind programme.',
        replyBy: addDays(nudge, 7),
      },
      suresh(),
    );
    const letter = got.letters.find((l) => l.number.startsWith('IN-'))!;
    const answered = addDays(nudge, Math.round(c.r.between(3, 9)));
    if (answered <= lastDay)
      c.sched.at(answered, 49, `letter answered ${key}`, () =>
        step(c, 'letter answered', () =>
          c.s.post(
            `/tenant/projects/${ps.id}/letters`,
            {
              direction: 'out',
              letterDate: answered,
              party: client,
              subject: 'Re: Progress of the work against the programme',
              summary: 'Recovery plan with a second shift on the critical activities.',
              replyTo: letter.id,
            },
            suresh(),
          ),
        ),
      );
  });

  // --- 7d.6 the site's petty-cash imprest ---
  const opened = addDays(ps.plan.start, 3);
  when(opened, 50, 'imprest', async () => {
    const holder = engineer();
    const kavita = as(c, 'kavita');
    const imp = await c.s.post<{ id: string; moneyLedgers: { id: string; name: string }[] }>(
      `/tenant/projects/${ps.id}/imprests`,
      { custodianId: c.users[holder]!.id, purpose: 'Site petty cash', floatLimit: '50000' },
      kavita,
    );
    bump(c, 'imprests');
    c.paths.push(`/projects/${ps.id}/imprest`);
    const post = (path: string, body: object, h = kavita) =>
      c.s.post(`/tenant/imprests/${imp.id}/${path}`, body, h);
    await post('advances', {
      date: opened,
      amount: '30000',
      accountId: c.bank,
      reference: 'Opening float',
    });
    const heads: [string, string, number, number][] = [
      ['site_overheads', 'Tea, water and site stationery', 300, 1800],
      ['fuel', 'Diesel for the generator', 1500, 4500],
      ['power_and_water', 'Water tanker', 800, 2400],
      ['site_overheads', 'Local transport', 200, 1200],
    ];
    let inHand = 30000;
    for (let m = firstOfMonth(opened); m <= lastDay; m = addMonths(m, 1)) {
      const end = minDay(lastOfMonth(m), lastDay);
      let spent = 0;
      for (
        let d = maxOf(m, addDays(opened, 1));
        d <= end;
        d = addDays(d, Math.round(c.r.between(3, 7)))
      ) {
        const [head, what, lo, hi] = heads[Math.floor(c.r.between(0, heads.length))]!;
        const amount = Math.round(c.r.between(lo, hi) / 10) * 10;
        if (spent + amount > inHand - 500) break;
        spent += amount;
        const on = d;
        c.sched.at(on, 50, `imprest spend ${key}`, () =>
          step(c, 'imprest spend', () =>
            post(
              'expenses',
              {
                date: on,
                amount: money(amount),
                accountId: c.acc[head],
                description: what,
                reference: `Bill ${on.slice(5)}`,
              },
              as(c, holder),
            ),
          ),
        );
      }
      // Accounts settles at the month's end and tops the float back up while the job runs.
      if (end === lastOfMonth(m) && end < c.today) {
        const top = spent;
        inHand = inHand - spent + (end < ps.end ? top : 0);
        c.sched.at(end, 51, `imprest settled ${key}`, () =>
          step(c, 'imprest settled', async () => {
            if (spent > 0) await post('settle', { date: end });
            if (end < ps.end && top > 0)
              await post('advances', {
                date: end,
                amount: money(top),
                accountId: c.bank,
                reference: 'Top-up',
              });
          }),
        );
      }
    }
    // A finished job's float is squared: the last spends settled, the rest taken back, and closed.
    if (ps.plan.finished && addDays(ps.end, 10) <= c.today) {
      const close = addDays(ps.end, 10);
      c.sched.at(close, 52, `imprest closed ${key}`, () =>
        step(c, 'imprest closed', async () => {
          await post('settle', { date: close }).catch(() => undefined);
          const now = await c.s.get<{ totals: { balance: string } }>(
            `/tenant/imprests/${imp.id}`,
            kavita,
          );
          await post('take-back', {
            date: close,
            amount: now.totals.balance,
            accountId: c.bank,
            reference: 'Float returned',
            close: true,
          });
        }),
      );
    }
  });
}

const maxOf = (a: Day, b: Day): Day => (a > b ? a : b);

/** The company's own: recurring entries from April 2025, and joining and exit checklists for its staff. */
export function scheduleCompanyRegisters(c: Ctx) {
  const kavita = () => as(c, 'kavita');
  const pooja = () => as(c, 'pooja');
  const from = '2025-04-01';
  if (from <= c.today)
    c.sched.at(from, 55, 'recurring entries', () =>
      step(c, 'recurring entries', async () => {
        const landlordAmc = await c.s.post<{ id: string }>(
          '/tenant/parties',
          {
            name: 'Mahalaxmi Electricals and Lifts',
            isClient: false,
            isVendor: true,
            isSubcontractor: false,
            isCompetitor: false,
            gstin: '27AAKFM4321Q1Z8',
          },
          c.admin,
        );
        await c.s.post(
          '/tenant/accounts/recurring',
          {
            entityId: c.entityId,
            kind: 'voucher',
            name: 'Head office rent',
            frequency: 'monthly',
            dayOfMonth: 5,
            startsOn: from,
            voucher: {
              type: 'payment',
              narration: 'Head office rent, Washim',
              reference: 'Lease HO/2025',
              lines: [
                { accountId: c.acc.rent, debit: '45000' },
                { accountId: c.bank, credit: '45000' },
              ],
            },
          },
          kavita(),
        );
        await c.s.post(
          '/tenant/accounts/recurring',
          {
            entityId: c.entityId,
            kind: 'bill',
            name: 'Lift and generator AMC',
            frequency: 'quarterly',
            dayOfMonth: 10,
            startsOn: from,
            bill: {
              partyId: landlordAmc.id,
              narration: 'Quarterly maintenance of the office lift and generator',
              dueDays: 15,
              lines: [
                {
                  accountId: c.acc.office_expenses,
                  description: 'AMC for the quarter',
                  qty: '1',
                  rate: '18000',
                  gstPct: '18',
                },
              ],
            },
          },
          kavita(),
        );
        bump(c, 'recurring entries', 2);
        c.paths.push('/accounts/recurring');
      }),
    );
  // Each month accounts posts what is due, but the month still running is left in the list.
  for (let m = from; m < firstOfMonth(c.today); m = addMonths(m, 1)) {
    const d = addDays(m, 14);
    c.sched.at(d, 56, 'recurring posted', () =>
      step(c, 'recurring posted', async () => {
        const r = await c.s.get<{
          drafts: { id: string; kind: string; status: string; dueOn: string }[];
        }>(`/tenant/accounts/recurring?entityId=${c.entityId}`, kavita());
        for (const draft of r.drafts.filter((x) => x.status === 'due')) {
          if (draft.kind === 'voucher' && c.r.chance(0.05)) {
            await c.s.post(
              `/tenant/accounts/recurring-drafts/${draft.id}/skip`,
              { note: 'Paid in advance last month' },
              kavita(),
            );
            continue;
          }
          await c.s.post(
            `/tenant/accounts/recurring-drafts/${draft.id}/post`,
            { billNo: draft.kind === 'bill' ? `MEL/${draft.dueOn.slice(0, 7)}` : null },
            kavita(),
          );
          bump(c, 'recurring entries posted');
        }
      }),
    );
  }

  // Joining checklists: started the day after each person joins, worked through in their first fortnight.
  for (const p of STAFF) {
    const start = addDays(p.joinedOn, 1);
    if (start > c.today) continue;
    c.sched.at(start, 57, `joining checklist ${p.code}`, () =>
      step(c, 'joining checklist', async () => {
        const e = c.emp[p.code];
        if (!e) return;
        const list = await c.s.post<{
          joining: { steps: { id: string; key: string; auto: boolean }[] };
        }>(
          `/tenant/hr/employees/${e.id}/checklists`,
          { kind: 'joining' },
          start >= '2024-04-16' ? pooja() : c.admin,
        );
        bump(c, 'joining checklists');
        for (const s of list.joining.steps.filter((x) => !x.auto)) {
          const on = addDays(p.joinedOn, Math.round(c.r.between(0, 14)));
          if (on > c.today || (s.key === 'id_card_ppe' && c.r.chance(0.1))) continue;
          c.sched.at(on > start ? on : start, 58, `joining step ${p.code}`, () =>
            step(c, 'joining step', () =>
              c.s.post(
                `/tenant/hr/checklist-steps/${s.id}`,
                { done: true, doneOn: on, note: '' },
                on >= '2024-04-16' ? pooja() : c.admin,
              ),
            ),
          );
        }
      }),
    );
    // Leavers: the exit checklist when the last day is entered; its steps through the notice period.
    if (p.left) {
      const left = p.left;
      const begun = addDays(firstOfMonth(left.on), 1);
      if (begun > c.today) continue;
      c.sched.at(begun, 57, `exit checklist ${p.code}`, () =>
        step(c, 'exit checklist', async () => {
          const e = c.emp[p.code]!;
          const list = await c.s.post<{
            exit: { steps: { id: string; key: string; auto: boolean }[] };
          }>(`/tenant/hr/employees/${e.id}/checklists`, { kind: 'exit' }, pooja());
          for (const s of list.exit.steps.filter((x) => !x.auto)) {
            const on =
              s.key === 'resignation'
                ? begun
                : addDays(left.on, s.key === 'relieving_letter' ? 7 : 0);
            if (on > c.today) continue;
            c.sched.at(on, 58, `exit step ${p.code}`, () =>
              step(c, 'exit step', () =>
                c.s.post(
                  `/tenant/hr/checklist-steps/${s.id}`,
                  { done: true, doneOn: on, note: '' },
                  pooja(),
                ),
              ),
            );
          }
        }),
      );
    }
  }
}
