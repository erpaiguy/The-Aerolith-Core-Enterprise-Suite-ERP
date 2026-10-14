// The things that happen once or twice on a job rather than every day: drawings and their revisions, RFIs and
// transmittals, variations, risks, an extension of time and a claim, incidents, snags at handover, the hospital's MEP
// coordination; and the company's own development, Sai Residency, from RERA registration to its bookings.
import { type Ctx, type ProjectState, as, bump, on, step } from './ctx.js';
import { siteTeam } from './people.js';
import { type Day, addDays, addMonths, diffDays, minDay, money } from './util.js';

const pdf = (title: string) =>
  Buffer.from(`%PDF-1.4\n% ${title}\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n`);
const at = (ps: ProjectState, frac: number): Day =>
  addDays(ps.plan.start, Math.round(diffDays(ps.end, ps.plan.start) * frac));

/** Scheduled once a project exists (called from history.ts when the project is set up). */
export function scheduleProjectExtras(c: Ctx, ps: ProjectState) {
  const key = ps.plan.key;
  const suresh = () => as(c, 'suresh');
  const when = (d: Day, order: number, label: string, f: () => Promise<unknown>) => {
    if (d <= c.today) c.sched.at(d, order, `${label} ${key}`, () => step(c, label, f));
  };

  // Drawings received from the client's architect, revised as the job goes on.
  when(addDays(ps.plan.start, -3), 40, 'drawings', async () => {
    await step(c, 'standard folders', () =>
      c.s.post(`/tenant/projects/${ps.id}/folders/standard`, {}, suresh()),
    );
    const sheets: [string, string, string][] = [
      ['A-101', 'Ground floor plan', 'architectural'],
      ['A-102', 'First floor plan', 'architectural'],
      ['A-201', 'Elevations and sections', 'architectural'],
      ['S-101', 'Foundation layout and details', 'structural'],
      ['S-201', 'Column and beam schedule', 'structural'],
      ['E-101', 'Electrical layout', 'electrical'],
    ];
    for (const [number, title, discipline] of sheets) {
      const dwg = await c.s.post<{ id: string }>(
        `/tenant/projects/${ps.id}/drawings`,
        { number, title, discipline },
        suresh(),
      );
      const rev = async (r: string, purpose: string, d: Day) =>
        c.s.upload(
          `/tenant/drawings/${dwg.id}/revisions?revision=${r}&purpose=${purpose}&receivedFrom=${encodeURIComponent("Client's architect")}&receivedOn=${d}`,
          suresh(),
          `${number} ${title} rev ${r}.pdf`,
          'application/pdf',
          pdf(`${ps.plan.name} ${number} ${title} rev ${r}`),
        );
      const d0 = minDay(addDays(ps.plan.start, -3), c.today);
      await rev('0', 'construction', d0);
      bump(c, 'drawing revisions');
      if (c.r.chance(0.5)) {
        const d1 = at(ps, c.r.between(0.15, 0.5));
        if (d1 <= c.today)
          c.sched.at(d1, 40, 'drawing revision', () =>
            step(c, 'drawing revision', () => rev('1', 'construction', d1)),
          );
      }
    }
    c.paths.push(`/projects/${ps.id}/documents`);
  });

  // RFIs to the client's engineer.
  for (const [frac, subject, question] of [
    [
      0.12,
      'Founding level at grid C',
      'Hard strata met 0.6 m above the founding level shown. Confirm we may found at the strata met.',
    ],
    [
      0.45,
      'Lintel level over the corridor windows',
      'The elevation and plan differ by 150 mm on lintel level. Which governs?',
    ],
  ] as const)
    when(at(ps, frac), 41, 'RFI', async () => {
      const assignee = c.users.suresh!.id;
      const rfi = await c.s.post<{ id: string }>(
        `/tenant/projects/${ps.id}/rfis`,
        {
          subject,
          question,
          location: ps.plan.site,
          reference: `RFI/${key.toUpperCase()}`,
          assignedTo: assignee,
          dueDays: 7,
        },
        author(c, ps),
      );
      const ans = at(ps, frac + 0.02);
      if (ans <= c.today)
        c.sched.at(ans, 41, 'RFI answer', () =>
          step(c, 'RFI answer', async () => {
            await c.s.post(
              `/tenant/rfis/${rfi.id}/answer`,
              {
                answer:
                  "Engineer's reply received: proceed as proposed; record the levels jointly.",
              },
              suresh(),
            );
            await c.s.post(
              `/tenant/rfis/${rfi.id}/outcome`,
              { outcome: 'none', close: true },
              suresh(),
            );
          }),
        );
      bump(c, 'RFIs');
    });

  // Variations: extra work ordered by the client.
  const vo = (
    frac: number,
    title: string,
    lines: { code: string; description: string; unit: string; qty: string; rate: string }[],
    decision: 'approved' | 'rejected' | null,
  ) =>
    when(at(ps, frac), 42, 'variation', async () => {
      const v = await c.s.post<{ id: string; rowVersion: number }>(
        `/tenant/projects/${ps.id}/variations`,
        {
          title,
          source: 'client_instruction',
          instructionRef: `EI/${key.toUpperCase()}/${c.r.int(10, 40)}`,
          reason: "Client's engineer's instruction on site.",
          days: c.r.int(0, 15),
          lines: lines.map((l) => ({ kind: 'new', ...l })),
        },
        suresh(),
      );
      const sub = await c.s.post<{ rowVersion: number }>(
        `/tenant/variations/${v.id}/submit`,
        { rowVersion: v.rowVersion },
        suresh(),
      );
      bump(c, 'variations');
      if (!decision) return;
      const d = at(ps, frac + 0.06);
      if (d > c.today) return;
      c.sched.at(d, 42, 'variation decision', () =>
        step(c, 'variation decision', () =>
          c.s.post(
            `/tenant/variations/${v.id}/client`,
            {
              decision,
              reference: `${decision === 'approved' ? 'Approval' : 'Rejection'} letter ${c.r.int(100, 999)}`,
              date: d,
              lines: [],
              rowVersion: sub.rowVersion,
            },
            as(c, 'priya'),
          ),
        ),
      );
    });
  if (['p3', 'p6', 'p7', 'p5'].includes(key))
    vo(
      0.35,
      'Additional toilet block',
      [
        {
          code: 'VO1.1',
          description: 'Toilet block: RCC, masonry and finishes, complete',
          unit: 'sqm',
          qty: '42',
          rate: '18500',
        },
        {
          code: 'VO1.2',
          description: 'Sanitary fittings and plumbing for the added toilets',
          unit: 'LS',
          qty: '1',
          rate: '185000',
        },
      ],
      'approved',
    );
  if (['p6', 'p4'].includes(key))
    vo(
      0.55,
      'Granite instead of vitrified tiles in the entrance lobby',
      [
        {
          code: 'VO2.1',
          description: 'Extra over for 18 mm granite flooring',
          unit: 'sqm',
          qty: '85',
          rate: '1450',
        },
      ],
      key === 'p6' ? 'rejected' : 'approved',
    );
  if (['p9', 'p8'].includes(key))
    vo(
      0.25,
      'Ramp and handrails for accessibility',
      [
        {
          code: 'VO1.1',
          description: 'RCC ramp with SS handrails, complete',
          unit: 'sqm',
          qty: '60',
          rate: '9800',
        },
      ],
      key === 'p8' ? 'approved' : null,
    );

  // Risks on the register.
  when(addDays(ps.plan.start, 5), 43, 'risks', async () => {
    for (const r of [
      {
        category: 'commercial',
        event: 'Steel prices rise more than 10% during the job',
        effect: 'Margin falls; no price variation clause',
        probability: 3,
        impact: 3,
        costImpact: money(Math.round(ps.contractValue * 0.012)),
      },
      {
        category: 'schedule',
        event: 'Monsoon stops concreting for weeks',
        effect: 'Completion slips',
        probability: 4,
        impact: 2,
        costImpact: money(Math.round(ps.contractValue * 0.004)),
        timeImpact: 20,
      },
      {
        category: 'site',
        event: 'Labour shortage at harvest and festival time',
        effect: 'Output drops for two to three weeks',
        probability: 3,
        impact: 2,
        costImpact: '0',
        timeImpact: 10,
      },
    ])
      await c.s.post(
        `/tenant/projects/${ps.id}/risks`,
        { ...r, cause: 'Market and season', status: 'open' },
        suresh(),
      );
    bump(c, 'risks', 3);
  });

  // The court annexe ran late through the monsoon: an extension of time and a prolongation claim.
  if (key === 'p5' && ps.contractId)
    when('2026-08-05', 44, 'EOT', async () => {
      await c.s.post(
        `/tenant/contracts/${ps.contractId}/notices`,
        {
          direction: 'sent',
          subject:
            'Delay due to unseasonal rain and late drawings: notice of claim for extension of time',
          clause: 'Cl. 15',
          dated: '2026-07-20',
          reference: `DIPL/${key}/EOT`,
          replyBy: '2026-08-04',
        },
        as(c, 'priya'),
      );
      const reg = await c.s.post<{ eots: { id: string; number: string }[] }>(
        `/tenant/contracts/${ps.contractId}/eots`,
        { from: '2026-06-15', to: '2026-07-31', daysClaimed: 30 },
        as(c, 'priya'),
      );
      const eot = reg.eots[reg.eots.length - 1]!;
      await c.s.post(`/tenant/eots/${eot.id}`, { action: 'submit' }, as(c, 'priya'));
      await c.s.post(
        `/tenant/eots/${eot.id}`,
        { action: 'decide', daysGranted: 25, reference: 'EE/PWD/EOT/112', date: '2026-08-20' },
        as(c, 'priya'),
      );
      const cl = await c.s.post<{ claims: { id: string }[] }>(
        `/tenant/contracts/${ps.contractId}/claims`,
        {
          kind: 'prolongation',
          title: 'Site overheads for the extended period',
          amount: '420000',
          evidence: 'Daily reports June-July 2026; rain register; drawing issue log',
          eotId: eot.id,
        },
        as(c, 'priya'),
      );
      const claim = cl.claims[cl.claims.length - 1]!;
      await c.s.post(
        `/tenant/claims/${claim.id}/status`,
        { status: 'submitted', settledAmount: null, date: null },
        as(c, 'priya'),
      );
      await c.s.post(
        `/tenant/claims/${claim.id}/status`,
        { status: 'negotiation', settledAmount: null, date: null },
        as(c, 'priya'),
      );
    });

  // Incidents: a near miss on most jobs, a first-aid case, and one lost-time injury.
  when(at(ps, 0.3), 45, 'incident', async () => {
    const lost = key === 'p3';
    const d = at(ps, 0.3);
    const inc = await c.s.post<{ id: string }>(
      `/tenant/projects/${ps.id}/incidents`,
      {
        siteId: ps.siteId,
        occurredAt: `${d}T11:20:00+05:30`,
        kind: lost ? 'lost_time' : c.r.pick(['near_miss', 'first_aid']),
        location: 'First floor slab edge',
        description: lost
          ? 'A helper slipped from the scaffold platform (1.5 m) and fractured his wrist.'
          : 'A loose plank fell from the scaffold; nobody below. Area was barricaded.',
        ...(lost ? { injuredName: 'Bhimrao Gaikwad' } : {}),
        daysLost: lost ? 21 : 0,
      },
      author(c, ps),
    );
    bump(c, 'incidents');
    const qa = as(c, d >= '2025-03-17' ? 'rahul' : 'suresh');
    await c.s.post(
      `/tenant/incidents/${inc.id}/investigation`,
      {
        rootCause: 'Scaffold platform not fully boarded; toe board missing.',
        daysLost: lost ? 21 : undefined,
        actions: [
          {
            action: 'Board every platform fully and fix toe boards',
            owner: 'Site engineer',
            dueOn: addDays(d, 3),
          },
          {
            action: 'Daily scaffold tag check by the supervisor',
            owner: 'Safety officer',
            dueOn: addDays(d, 7),
          },
        ],
      },
      qa,
    );
    const full = await c.s.get<{ actions: { id: string }[] }>(`/tenant/incidents/${inc.id}`, qa);
    for (const a of full.actions)
      await c.s.post(`/tenant/incident-actions/${a.id}/done`, { doneOn: addDays(d, 4) }, qa);
    await c.s.post(`/tenant/incidents/${inc.id}/close`, {}, as(c, 'suresh'));
  });

  // Snags at handover, put right.
  if (ps.plan.finished)
    when(addDays(ps.plan.finished, -12), 46, 'snags', async () => {
      for (const [area, description] of [
        ['Ground floor toilets', 'Two floor traps choked with mortar'],
        ['First floor corridor', 'Paint touch-up at the switchboards'],
        ['Staircase', 'Handrail joint not ground smooth'],
        ['Terrace', 'Ponding near the rain-water outlet'],
        ['Main entrance', 'Door closer not adjusted'],
      ]) {
        const s = await c.s.post<{ id: string; rowVersion: number }>(
          `/tenant/projects/${ps.id}/snags`,
          { area, description },
          author(c, ps),
        );
        await c.s.put(
          `/tenant/snags/${s.id}`,
          { status: 'fixed', rowVersion: s.rowVersion ?? 1 },
          author(c, ps),
        );
        await c.s.put(
          `/tenant/snags/${s.id}`,
          { status: 'closed', rowVersion: (s.rowVersion ?? 1) + 1 },
          suresh(),
        );
      }
      bump(c, 'snags', 5);
    });

  // The hospital: MEP equipment and coordination issues.
  if (key === 'p9')
    when('2026-08-18', 47, 'MEP', async () => {
      for (const [tag, system, description] of [
        ['AHU-01', 'hvac', 'Air handling unit, OPD waiting hall'],
        ['DB-GF', 'electrical', 'Main distribution board, ground floor'],
        ['FHC-01', 'fire', 'Fire hose cabinet, staircase 1'],
        ['OHT-PMP', 'plumbing', 'Overhead tank transfer pump set'],
      ] as const)
        await c.s.post(
          `/tenant/projects/${ps.id}/mep/equipment`,
          { tag, system, description, capacity: '', location: 'OPD block', make: '' },
          suresh(),
        );
      const issue = await c.s.post<{ issues?: { id: string }[] }>(
        `/tenant/projects/${ps.id}/mep/issues`,
        {
          systems: ['hvac', 'electrical'],
          location: 'First floor corridor ceiling',
          drawingRef: 'M-101 / E-101',
          description:
            'AHU duct clashes with the cable tray at grid D; ceiling height short by 120 mm.',
          raisedOn: '2026-08-18',
        },
        suresh(),
      );
      void issue;
    });
}

const author = (c: Ctx, ps: ProjectState) =>
  as(c, siteTeam(ps.plan.key).find((u) => c.users[u]) ?? 'suresh');

/** Sai Residency, Akola: the company's own residential development, registered with MahaRERA in 2026. */
export function scheduleRealEstate(c: Ctx) {
  if ('2026-03-10' > c.today) return;
  c.sched.at('2026-03-10', 30, 'Sai Residency', async () => {
    const priya = as(c, 'priya');
    on('2026-03-10');
    await c.s.get(`/tenant/accounts/map?entityId=${c.entityId}`, c.admin);
    const p = await c.s.post<{ id: string; rowVersion: number }>(
      '/tenant/projects',
      {
        name: 'Sai Residency, Akola',
        location: 'Gorakshan Road, Akola',
        startOn: '2026-04-01',
        plannedFinishOn: '2028-03-31',
        description: 'Own development: G+8 residential tower A, 32 flats, MahaRERA registered.',
      },
      priya,
    );
    await c.s.post(
      `/tenant/projects/${p.id}/sites`,
      { name: 'Sai Residency site', stateCode: '27', address: 'Gorakshan Road, Akola' },
      priya,
    );
    // Construction began on 1 April 2026.
    if ('2026-04-01' <= c.today)
      c.sched.at('2026-04-01', 16, 'Sai Residency starts', () =>
        step(c, 'Sai Residency starts', async () => {
          const cur = await c.s.get<{ rowVersion: number }>(`/tenant/projects/${p.id}`, priya);
          await c.s.post(
            `/tenant/projects/${p.id}/status`,
            { rowVersion: cur.rowVersion, status: 'active' },
            priya,
          );
        }),
      );
    const base = `/tenant/projects/${p.id}/sales`;
    await c.s.post(
      `${base}/setup`,
      {
        reraNumber: 'P52100067890',
        registeredOn: '2026-03-28',
        completionOn: '2028-03-31',
        collectionAccountId: c.acc.rera_collection,
        designatedAccountId: c.acc.rera_designated,
      },
      priya,
    );
    const towers = await c.s.post<{ towers: { id: string }[] }>(
      `${base}/towers`,
      { name: 'A', floors: 8 },
      priya,
    );
    const towerA = towers.towers[0]!.id;
    const units = [];
    for (let f = 1; f <= 8; f++)
      for (const [n, sqm] of [
        ['01', '62'],
        ['02', '48'],
        ['03', '48'],
        ['04', '62'],
      ] as const)
        units.push({
          floor: f,
          number: `${f}${n}`,
          kind: 'flat',
          carpetSqm: sqm,
          ratePerSqm: String(56000 + f * 500),
          parking: sqm === '62' ? '250000' : '0',
          charges: '120000',
          gstPct: '5',
        });
    const made = await c.s.post<{ units: { id: string; number: string }[] }>(
      `/tenant/sales/towers/${towerA}/units`,
      { units },
      priya,
    );
    await c.s.post(
      `${base}/plan`,
      {
        stages: [
          { name: 'On booking', pct: '10', trigger: 'booking' },
          { name: 'On agreement', pct: '20', trigger: 'agreement' },
          { name: 'Plinth', pct: '30', trigger: 'milestone', towerId: towerA },
          { name: 'Possession', pct: '40', trigger: 'milestone' },
        ],
      },
      priya,
    );
    const buyers = [
      'Anil Kulkarni',
      'Sneha Deshpande',
      'Rajesh Bhutada',
      'Vaishali Wankhade',
      'Amit Agrawal',
      'Pradnya Thakare',
      'Sameer Pathan',
      'Nilesh Gawande',
      'Kirti Joshi',
      'Mangesh Raut',
      'Swati Bhagat',
      'Yogesh Malpani',
      'Rupali Ingle',
      'Harshal Mundada',
    ];
    let d: Day = '2026-04-06';
    for (const [i, buyer] of buyers.entries()) {
      d = addDays(d, c.r.int(8, 14));
      if (d > c.today) break;
      const unit = made.units[i * 2 + (i % 2)]!;
      const bookOn = d;
      c.sched.at(bookOn, 30, 'booking', () =>
        step(c, 'booking', async () => {
          on(bookOn);
          const b = await c.s.post<{ id: string; totals?: { due?: string } }>(
            `/tenant/sales/units/${unit.id}/book`,
            {
              buyer: {
                name: buyer,
                phone: `98${c.r.int(10000000, 99999999)}`,
                pan: `${'ABCDE'[i % 5]}${'FGHJK'[i % 5]}KPK${String(1000 + i)}${'LMNPQ'[i % 5]}`.slice(
                  0,
                  10,
                ),
                email: `${buyer.split(' ')[0]!.toLowerCase()}@demo.in`,
                address: 'Akola',
              },
              bookedOn: bookOn,
            },
            priya,
          );
          bump(c, 'flat bookings');
          const view = await c.s.get<{
            demands?: { amount: string }[];
            due?: string;
            totals?: Record<string, string>;
          }>(`/tenant/sales/bookings/${b.id}`, priya);
          const due =
            Number(view.totals?.due ?? 0) ||
            Math.round(Number((view as { value?: string }).value ?? 4_000_000) * 0.1);
          const pay1 = addDays(bookOn, 2);
          if (pay1 <= c.today)
            c.sched.at(pay1, 31, 'booking receipt', () =>
              step(c, 'booking receipt', () =>
                c.s.post(
                  `/tenant/sales/bookings/${b.id}/receipts`,
                  {
                    on: pay1,
                    amount: money(due),
                    mode: 'upi',
                    reference: `UPI/${pay1.replaceAll('-', '')}${i}`,
                  },
                  priya,
                ),
              ),
            );
          const agr = addDays(bookOn, c.r.int(15, 28));
          if (agr <= c.today)
            c.sched.at(agr, 31, 'agreement', () =>
              step(c, 'agreement', async () => {
                await c.s.post(
                  `/tenant/sales/bookings/${b.id}/agreement`,
                  { on: agr, number: `AKL-1-${c.r.int(1000, 9999)}-2026` },
                  priya,
                );
                const v2 = await c.s.get<{ totals?: Record<string, string> }>(
                  `/tenant/sales/bookings/${b.id}`,
                  priya,
                );
                const owed = Number(v2.totals?.due ?? 0);
                const pay2 = addDays(agr, c.r.int(5, 20));
                if (owed > 0 && pay2 <= c.today)
                  c.sched.at(pay2, 31, 'agreement receipt', () =>
                    step(c, 'agreement receipt', () =>
                      c.s.post(
                        `/tenant/sales/bookings/${b.id}/receipts`,
                        {
                          on: pay2,
                          amount: money(owed),
                          mode: c.r.pick(['neft', 'rtgs', 'loan']),
                          reference: `NEFT/${pay2.replaceAll('-', '')}${i}`,
                        },
                        priya,
                      ),
                    ),
                  );
              }),
            );
        }),
      );
    }
    // 70% of collections go to the RERA designated account each month.
    for (let m = '2026-05-05'; m <= c.today; m = addMonths(m, 1)) {
      const day = m;
      c.sched.at(day, 32, 'RERA deposit', () =>
        step(c, 'RERA deposit', async () => {
          const r = await c.s.get<{ toDeposit?: string; pendingDeposit?: string }>(
            `/tenant/projects/${p.id}/sales/rera`,
            priya,
          );
          const amount = Number(r.toDeposit ?? r.pendingDeposit ?? 0);
          if (amount > 1)
            await c.s.post(
              `/tenant/projects/${p.id}/sales/rera`,
              { kind: 'deposit', on: day, amount: money(amount) },
              priya,
            );
        }),
      );
    }
    c.paths.push(`/projects/${p.id}`);
  });
}

/** Company-level things: company risks, cash-flow overheads, a few shared reports. */
export function scheduleCompany(c: Ctx) {
  c.sched.at('2024-02-01', 50, 'company setup', () =>
    step(c, 'company setup', async () => {
      await c.s.post(
        `/tenant/accounts/cash-flow/${c.entityId}/overheads`,
        { amount: '450000' },
        as(c, 'suresh'),
      );
      for (const r of [
        {
          category: 'commercial',
          event: 'A government client delays payments beyond 90 days',
          effect: 'Working capital squeezed; supplier credit at risk',
          probability: 3,
          impact: 4,
          costImpact: '600000',
        },
        {
          category: 'regulatory',
          event: 'GST rate on works contracts changes mid-contract',
          effect: 'Tax cost not recoverable on old contracts',
          probability: 2,
          impact: 3,
          costImpact: '250000',
        },
      ])
        await c.s.post(
          '/tenant/risks',
          { ...r, cause: 'External', status: 'open' },
          as(c, 'suresh'),
        );
    }),
  );
  if ('2026-09-01' <= c.today)
    c.sched.at('2026-09-01', 50, 'saved reports', () =>
      step(c, 'saved reports', async () => {
        for (const [name, spec, chart] of [
          [
            'Purchase orders by vendor',
            {
              view: 'purchase_orders',
              fields: [],
              groupBy: ['vendor'],
              aggregates: [{ field: 'value', fn: 'sum' }],
            },
            { kind: 'bar', label: 'vendor', value: 'sum_value' },
          ],
          [
            'Client bills by project',
            {
              view: 'client_bills',
              fields: [],
              groupBy: ['project'],
              aggregates: [{ field: 'net', fn: 'sum' }],
            },
            { kind: 'bar', label: 'project', value: 'sum_net' },
          ],
          [
            'Vendor bills by vendor',
            {
              view: 'vendor_bills',
              fields: [],
              groupBy: ['vendor'],
              aggregates: [{ field: 'total', fn: 'sum' }],
            },
            { kind: 'pie', label: 'vendor', value: 'sum_total' },
          ],
        ] as const)
          await step(c, 'saved report', () =>
            c.s.post(
              '/tenant/reports/saved',
              { name, spec, chart, sharedWith: 'everyone' },
              as(c, 'suresh'),
            ),
          );
      }),
    );
}

export { addMonths };
