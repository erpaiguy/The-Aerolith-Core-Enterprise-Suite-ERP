// Winning work and doing it: CRM leads, tenders priced from the rate analyses, bids, results; won tenders become
// projects with the tender's BOQs, a WBS, a programme, contracts, work orders and a cost baseline; each month the work
// done is measured, billed to the client and certified, the subcontractors' work measured and billed, and payments
// come in; finished projects are closed out and their retention released after the defects period.
import { type Ctx, type ItemState, type ProjectState, as, bump, on, pause, step } from './ctx.js';
import { scheduleProjectExtras } from './extras.js';
import { scheduleProjectRegisters } from './registers.js';
import { isWorkDay, siteTeam } from './people.js';
import {
  ANALYSES,
  BOQ_ITEMS,
  BOQ_SECTIONS,
  OTHER_LEADS,
  OTHER_TENDERS,
  PARTIES,
  PROJECTS,
  type ProjectPlan,
  RESOURCES,
} from './plan.js';
import {
  type Day,
  OVER_BUDGET_REASON,
  addDays,
  addMonths,
  diffDays,
  lastOfMonth,
  minDay,
  money,
  qty4,
  sCurve,
} from './util.js';

const iso = (d: Day, time = '15:00') => `${d}T${time}:00+05:30`;
const partyName = (key: string) => PARTIES.find((p) => p.key === key)!.name;

/** An analysis' rate on a day, worked out the way the app does (resource rates, then overheads and profit). */
function analysisRate(c: Ctx, code: string, d: Day): number {
  const a = ANALYSES.find((x) => x.code === code)!;
  let cost = 0;
  for (const l of a.lines) cost += l[0] === 'LS' ? l[1] : l[1] * c.res[l[0]]!.rate(d);
  return (cost / a.outputQty) * 1.2 * 1.15;
}

/** Progress of an item (0..1) on a day. */
export function itemDone(ps: ProjectState, item: { window: [number, number] }, d: Day): number {
  const total = diffDays(ps.end, ps.plan.start);
  const t = diffDays(d, ps.plan.start) / total;
  const [a, b] = item.window;
  return t >= b ? 1 : sCurve((t - a) / (b - a));
}

/** Value of the work a project does between two days (at contract rates). */
export function workValue(ps: ProjectState, from: Day, to: Day): number {
  let v = 0;
  for (const it of ps.items)
    v += (itemDone(ps, it, to) - itemDone(ps, it, from)) * it.qty * it.rate;
  return v;
}

export const activeOn = (ps: ProjectState, d: Day) =>
  d >= ps.plan.start && d <= minDay(ps.end, ps.plan.finished ?? ps.end) && d <= ps.end;

// --- CRM and tenders ---------------------------------------------------------------------------------------------

async function criteria(c: Ctx, score: (key: string) => number) {
  const s = await c.s.get<{ criteria: { key: string; weight: number }[] }>(
    '/tenant/tender-settings',
    c.admin,
  );
  return s.criteria.map((k) => ({ key: k.key, weight: k.weight, score: score(k.key) }));
}

interface TenderSpec {
  title: string;
  client: string;
  location: string;
  value: number;
  published: Day;
  due: Day;
  source: string;
  lead?: ProjectPlan['lead'];
}

/** A tender from the day it is published to the day it is ready to submit (BOQ priced, scenario chosen). */
async function openTender(
  c: Ctx,
  t: TenderSpec,
): Promise<{ id: string; boqId: string; bid: number } | undefined> {
  const priya = as(c, 'priya');
  let tenderId: string;
  if (t.lead) {
    // The opportunity came through the CRM first and was converted to a tender when the notice came out.
    on(t.lead.on);
    const lead = await c.s.post<{ id: string; rowVersion: number }>(
      '/tenant/crm/leads',
      {
        title: t.title,
        partyId: c.party[t.client],
        source: t.lead.source,
        segment: 'buildings',
        location: t.location,
        value: String(t.value),
        expectedMonth: t.published.slice(0, 7),
        notes: 'Budget provision confirmed by the client.',
      },
      priya,
    );
    await c.s.post(
      `/tenant/crm/leads/${lead.id}/interactions`,
      {
        kind: 'meeting',
        happenedAt: iso(t.lead.on, '10:15'),
        summary: `Met the client's engineer about ${t.title}; scope and budget discussed.`,
        followUpOn: null,
      },
      priya,
    );
    on(addDays(t.lead.on, 6));
    await c.s.post(
      `/tenant/crm/leads/${lead.id}/interactions`,
      {
        kind: 'site_visit',
        happenedAt: iso(addDays(t.lead.on, 6), '10:00'),
        summary: 'Site visit with Suresh: soil looks hard murum, access road fine.',
        followUpOn: null,
      },
      priya,
    );
    await c.s.post(`/tenant/crm/leads/${lead.id}/stage`, { stage: 'qualified' }, priya);
    on(t.published);
    const converted = await c.s.post<{ tenderId: string }>(
      `/tenant/crm/leads/${lead.id}/convert`,
      {},
      priya,
    );
    tenderId = converted.tenderId;
    const cur = await c.s.get<{ rowVersion: number }>(`/tenant/tenders/${tenderId}`, priya);
    await c.s.post(
      `/tenant/tenders/${tenderId}`,
      {
        rowVersion: cur.rowVersion,
        clientRef: `${t.client.toUpperCase()}/WORKS/${t.published.slice(0, 4)}/${c.r.int(10, 99)}`,
        publishedOn: t.published,
        submissionDueAt: iso(t.due),
        openingAt: iso(addDays(t.due, 1), '11:00'),
        prebidAt: iso(addDays(t.published, 6), '12:00'),
        emdAmount: money(Math.round(t.value * 0.01)),
        tenderFee: '5900',
        bidValidityDays: 120,
      },
      priya,
    );
  } else {
    on(t.published);
    const made = await c.s.post<{ id: string }>(
      '/tenant/tenders',
      {
        title: t.title,
        clientId: c.party[t.client],
        clientRef: `${t.client.toUpperCase()}/WORKS/${t.published.slice(0, 4)}/${c.r.int(10, 99)}`,
        source: t.source,
        vertical: 'buildings',
        location: t.location,
        estimatedValue: money(t.value),
        emdAmount: money(Math.round(t.value * 0.01)),
        tenderFee: '5900',
        publishedOn: t.published,
        prebidAt: iso(addDays(t.published, 6), '12:00'),
        submissionDueAt: iso(t.due),
        openingAt: iso(addDays(t.due, 1), '11:00'),
        bidValidityDays: 120,
        description: `Construction of ${t.title.toLowerCase()} including civil, finishing and services works.`,
      },
      priya,
    );
    tenderId = made.id;
  }
  bump(c, 'tenders');
  c.paths.push(`/tenders/${tenderId}`);
  await c.s.post(`/tenant/tenders/${tenderId}/status`, { to: 'evaluating' }, priya);
  await step(c, 'tender checklist', () =>
    c.s.post(`/tenant/tenders/${tenderId}/checklist/standard`, {}, priya),
  );
  return { id: tenderId, ...(await priceTender(c, tenderId, t)) };
}

async function priceTender(c: Ctx, tenderId: string, t: TenderSpec) {
  const priya = as(c, 'priya');
  const day = addDays(t.published, 3);
  on(day);
  await c.s.post(
    `/tenant/tenders/${tenderId}/decision`,
    {
      criteria: await criteria(c, (k) => (k === 'competition' ? 3 : k === 'margin' ? 3 : 4)),
      decision: 'bid',
      reason: 'Fits our size and district; client pays on time.',
    },
    priya,
  );
  await c.s.post(
    `/tenant/tenders/${tenderId}/securities`,
    {
      purpose: 'emd',
      form: 'online',
      amount: money(Math.round(t.value * 0.01)),
      bank: 'HDFC Bank',
      instrumentNo: `EMD${day.replaceAll('-', '')}${c.r.int(100, 999)}`,
      issuedOn: day,
      validUntil: addDays(t.due, 180),
      status: 'submitted',
    },
    priya,
  );
  const boq = await c.s.post<{ id: string; rowVersion: number }>(
    `/tenant/tenders/${tenderId}/boqs`,
    { name: 'Civil and building services' },
    priya,
  );
  await c.s.post(
    `/tenant/boqs/${boq.id}`,
    { rowVersion: boq.rowVersion, rateDate: t.published },
    priya,
  );
  // Quantities are scaled so the estimate lands near the tender's value.
  const share = BOQ_ITEMS.reduce((s, i) => s + (i.share ?? 0), 0);
  const base = BOQ_ITEMS.filter((i) => i.analysis).reduce(
    (s, i) => s + i.qty * analysisRate(c, i.analysis!, t.published),
    0,
  );
  const scale = (t.value * (1 - share)) / 1.0 / base;
  const ops: Record<string, unknown>[] = [];
  let afterSection: string | null = null;
  for (const [code, name] of BOQ_SECTIONS) {
    const sid = `ts${code}`;
    ops.push({
      op: 'insert',
      tempId: sid,
      parentId: null,
      afterId: afterSection,
      type: 'section',
      code,
      description: name,
    });
    afterSection = sid;
    let after: string | null = null;
    for (const it of BOQ_ITEMS.filter((i) => i.section === code)) {
      const tid = `ti${it.code.replace('.', '_')}`;
      ops.push(
        it.analysis
          ? {
              op: 'insert',
              tempId: tid,
              parentId: sid,
              afterId: after,
              type: 'item',
              code: it.code,
              rateAnalysisId: c.ana[it.analysis],
              qty: qty4(Math.round(it.qty * scale * 10) / 10),
            }
          : {
              op: 'insert',
              tempId: tid,
              parentId: sid,
              afterId: after,
              type: 'item',
              code: it.code,
              description: it.description,
              unit: it.unit,
              qty: '1',
              rate: money(Math.round(t.value * it.share!)),
              kind: it.provisional ? 'provisional' : 'normal',
            },
      );
      after = tid;
    }
  }
  await c.s.post(`/tenant/boqs/${boq.id}/changes`, { ops }, priya);
  await c.s.post(
    `/tenant/boqs/${boq.id}/scenarios`,
    {
      name: 'Bid',
      markups: [
        { kind: 'contingency', label: 'Contingency', basis: 'base', pct: '2' },
        { kind: 'discount', label: 'Rounding discount', basis: 'running', pct: '0.5' },
      ],
      gstPct: '18',
      gstMode: 'add',
    },
    priya,
  );
  const sum = await c.s.get<{ beforeGst: string }>(
    `/tenant/tenders/${tenderId}/bid-summary`,
    priya,
  );
  return { boqId: boq.id, bid: Number(sum.beforeGst) };
}

async function submitTender(c: Ctx, tenderId: string, due: Day, bid: number) {
  const priya = as(c, 'priya');
  on(addDays(due, -1), 16);
  const work = await c.s.get<{ checklist: { id: string; rowVersion: number; status: string }[] }>(
    `/tenant/tenders/${tenderId}/work`,
    priya,
  );
  for (const item of work.checklist)
    if (item.status === 'pending')
      await step(c, 'checklist ready', () =>
        c.s.post(
          `/tenant/checklist/${item.id}`,
          { status: 'ready', rowVersion: item.rowVersion },
          priya,
        ),
      );
  await c.s.post(
    `/tenant/tenders/${tenderId}/submissions`,
    {
      submittedAt: iso(addDays(due, -1), '16:40'),
      mode: 'portal',
      reference: `MAHATENDERS/${due.replaceAll('-', '')}/${c.r.int(1000, 9999)}`,
      bidValue: money(bid),
      notes: 'Technical and financial envelopes uploaded; EMD paid online.',
    },
    priya,
  );
}

async function openBids(
  c: Ctx,
  tenderId: string,
  due: Day,
  ours: number,
  others: [string, number][],
) {
  on(addDays(due, 1), 15);
  await c.s.post(
    `/tenant/tenders/${tenderId}/bids`,
    {
      bids: [
        { us: true, quotedValue: money(ours), qualified: true, notes: '' },
        ...others.map(([k, f]) => ({
          us: false,
          partyId: c.party[k],
          quotedValue: money(Math.round(ours * f)),
          qualified: true,
          notes: '',
        })),
      ],
    },
    as(c, 'priya'),
  );
}

export function scheduleTenders(c: Ctx) {
  // Tenders that did not become projects.
  for (const t of OTHER_TENDERS) {
    if (t.published > c.today) continue;
    c.sched.at(t.published, 20, `tender ${t.title}`, async () => {
      if (t.outcome === 'evaluating') {
        on(t.published);
        const made = await c.s.post<{ id: string }>(
          '/tenant/tenders',
          {
            title: t.title,
            clientId: c.party[t.client],
            source: 'public_portal',
            vertical: 'buildings',
            location: t.location,
            estimatedValue: money(t.value),
            emdAmount: money(Math.round(t.value * 0.01)),
            publishedOn: t.published,
            submissionDueAt: iso(t.due),
            openingAt: iso(addDays(t.due, 1), '11:00'),
            bidValidityDays: 120,
          },
          as(c, 'priya'),
        );
        await c.s.post(`/tenant/tenders/${made.id}/status`, { to: 'evaluating' }, as(c, 'priya'));
        c.paths.push(`/tenders/${made.id}`);
        return;
      }
      if (t.outcome === 'no_bid') {
        on(t.published);
        const made = await c.s.post<{ id: string }>(
          '/tenant/tenders',
          {
            title: t.title,
            clientId: c.party[t.client],
            source: 'public_portal',
            vertical: 'buildings',
            location: t.location,
            estimatedValue: money(t.value),
            publishedOn: t.published,
            submissionDueAt: iso(t.due),
          },
          as(c, 'priya'),
        );
        on(addDays(t.published, 4));
        await c.s.post(
          `/tenant/tenders/${made.id}/decision`,
          {
            criteria: await criteria(c, (k) =>
              k === 'resources' || k === 'strategic_fit' ? 2 : 3,
            ),
            decision: 'no_bid',
            reason: 'Beyond our current working capital and bid capacity.',
          },
          as(c, 'priya'),
        );
        return;
      }
      const opened = await openTender(c, { ...t, source: 'public_portal' });
      if (!opened || t.outcome === 'bidding') return;
      const due = t.due;
      if (due > c.today) return;
      c.sched.at(addDays(due, -1), 20, `submit ${t.title}`, async () => {
        await submitTender(c, opened.id, due, opened.bid);
        if (addDays(due, 1) <= c.today)
          await openBids(c, opened.id, due, opened.bid, [
            [t.winner ?? 'c1', 1 / (t.ourFactor ?? 1.03)],
            [t.winner === 'c2' ? 'c3' : 'c2', 1.06],
          ]);
        if (t.outcome !== 'lost' || !t.result || t.result > c.today) return;
        c.sched.at(t.result, 20, `result ${t.title}`, async () => {
          on(t.result!);
          await c.s.post(
            `/tenant/tenders/${opened.id}/result`,
            {
              outcome: 'lost',
              on: t.result,
              category: t.category ?? 'price',
              reason:
                t.category === 'technical'
                  ? 'Our similar-work certificate was found short.'
                  : t.category === 'qualification'
                    ? 'Turnover criterion: our turnover was then below the threshold.'
                    : `L2; ${partyName(t.winner!)} quoted ${Math.round(((t.ourFactor ?? 1.03) - 1) * 100)}% below us.`,
              value: money(Math.round(opened.bid / (t.ourFactor ?? 1.03))),
              winnerId: c.party[t.winner!],
            },
            as(c, 'priya'),
          );
        });
      });
    });
  }
  // Leads that never became tenders, and the open pipeline.
  for (const l of OTHER_LEADS) {
    if (l.on > c.today) continue;
    c.sched.at(l.on, 25, `lead ${l.title}`, async () => {
      const priya = as(c, 'priya');
      on(l.on);
      const lead = await c.s.post<{ id: string }>(
        '/tenant/crm/leads',
        {
          title: l.title,
          organisation: l.organisation,
          source: l.source,
          segment: l.segment,
          location: 'Vidarbha',
          value: l.value,
          expectedMonth: l.expected,
        },
        priya,
      );
      bump(c, 'leads');
      const steps: [string, string][] = [
        ['call', 'First call: requirement noted, asked for drawings.'],
        ['meeting', 'Presented our completed projects and capacity.'],
        ['site_visit', 'Visited the site with Suresh; rough quantities taken.'],
      ];
      let d = l.on;
      for (const [kind, summary] of steps.slice(0, l.end === 'new' ? 1 : 3)) {
        d = minDay(addDays(d, c.r.int(3, 12)), c.today);
        on(d);
        await c.s.post(
          `/tenant/crm/leads/${lead.id}/interactions`,
          { kind, happenedAt: iso(d, '10:00'), summary, followUpOn: null },
          priya,
        );
      }
      const path: Record<string, string[]> = {
        lost: ['qualified', 'proposal', 'lost'],
        dropped: ['dropped'],
        qualified: ['qualified'],
        proposal: ['qualified', 'proposal'],
        negotiation: ['qualified', 'proposal', 'negotiation'],
        new: [],
      };
      for (const stage of path[l.end]!)
        await c.s.post(
          `/tenant/crm/leads/${lead.id}/stage`,
          {
            stage,
            reason:
              stage === 'lost'
                ? 'Client went with a design-build firm from Nagpur.'
                : stage === 'dropped'
                  ? 'Client postponed the project indefinitely.'
                  : undefined,
          },
          priya,
        );
      // Open leads carry a follow-up in the coming days.
      if (
        ['qualified', 'proposal', 'negotiation', 'new'].includes(l.end) &&
        diffDays(c.today, d) < 40
      ) {
        c.sched.at(c.today, 5, 'lead follow-up', async () => {
          await c.s.post(
            `/tenant/crm/leads/${lead.id}/interactions`,
            {
              kind: 'call',
              happenedAt: new Date(Date.now() - 3_600_000).toISOString(),
              summary: 'Called to check the decision timeline.',
              followUpOn: addDays(c.today, c.r.int(2, 9)),
              followUp: 'Send the revised offer',
            },
            priya,
          );
        });
      }
    });
  }
  // The projects' tenders.
  for (const p of PROJECTS) {
    if (p.published > c.today) continue;
    c.sched.at(p.published, 20, `tender ${p.key}`, async () => {
      const opened = await openTender(c, {
        title: p.name,
        client: p.client,
        location: p.location,
        value: p.value,
        published: p.published,
        due: p.submitted,
        source: p.lead ? 'other' : p.client === 'zp' ? 'repeat_client' : 'public_portal',
        lead: p.lead,
      });
      if (!opened) return;
      c.sched.at(addDays(p.submitted, -1), 20, `submit ${p.key}`, async () => {
        await submitTender(c, opened.id, p.submitted, opened.bid);
        await openBids(c, opened.id, p.submitted, opened.bid, p.competitors);
      });
      c.sched.at(p.result, 20, `award ${p.key}`, async () => {
        on(p.result);
        await c.s.post(
          `/tenant/tenders/${opened.id}/result`,
          {
            outcome: 'won',
            on: p.result,
            category: null,
            reason: 'L1; technically qualified.',
            value: money(opened.bid),
          },
          as(c, 'priya'),
        );
        await setUpProject(c, p, opened.id, opened.bid);
      });
    });
  }
}

// --- a won tender becomes a project ---------------------------------------------------------------------------------

async function setUpProject(c: Ctx, p: ProjectPlan, tenderId: string, bid: number) {
  const suresh = as(c, 'suresh');
  const day = addDays(p.result, 2);
  on(day);
  const proj = await c.s.post<{ id: string; rowVersion: number }>(
    `/tenant/tenders/${tenderId}/project`,
    {
      startOn: p.start,
      plannedFinishOn: p.plannedFinish,
      clientRef: `WO/${p.client.toUpperCase()}/${p.result.slice(0, 4)}/${c.r.int(100, 999)}`,
    },
    suresh,
  );
  const total = diffDays(p.plannedFinish, p.start) * (1 + p.slip);
  const end = p.finished ?? addDays(p.start, Math.round(total));
  const ps: ProjectState = {
    plan: p,
    id: proj.id,
    tenderId,
    rowVersion: proj.rowVersion,
    siteId: '',
    contractValue: bid,
    items: [],
    wbs: {},
    activities: {},
    wo: {},
    stock: {},
    onOrder: {},
    end,
    team: [],
    status: 'planned',
    bills: [],
    advanceLeft: 0,
  };
  c.projects[p.key] = ps;
  c.paths.push(`/projects/${proj.id}`, `/projects/${proj.id}/dashboard`);
  bump(c, 'projects');
  const withSite = await c.s.post<{ rowVersion: number; sites: { id: string; name: string }[] }>(
    `/tenant/projects/${proj.id}/sites`,
    { name: p.site, stateCode: '27', address: p.location },
    suresh,
  );
  ps.siteId = withSite.sites.find((s) => s.name === p.site)!.id;
  ps.rowVersion = withSite.rowVersion;
  for (const u of new Set([...siteTeam(p.key), 'priya', 'kavita', 'imran', 'rahul', 'pooja']))
    if (c.users[u]) {
      await step(c, 'team', () =>
        c.s.post(
          `/tenant/projects/${proj.id}/team`,
          { userId: c.users[u]!.id, role: 'member' },
          suresh,
        ),
      );
      ps.team.push(u);
    }

  // The tender's BOQs come across as the contract and the budget.
  await c.s.post(
    `/tenant/projects/${proj.id}/boqs/from-tender`,
    { matchContractValue: false },
    suresh,
  );
  for (let i = 0; i < 300; i++) {
    const st = await c.s.get<{ copy: { status: string; error?: string } | null }>(
      `/tenant/projects/${proj.id}/boqs/from-tender`,
      suresh,
    );
    if (st.copy?.status === 'done') break;
    if (st.copy?.status === 'failed') throw new Error(`BOQ copy failed: ${st.copy.error}`);
    await pause(100);
  }
  const boqs = await c.s.get<{ id: string; kind: string }[]>(
    `/tenant/projects/${proj.id}/boqs`,
    suresh,
  );
  ps.contractBoqId = boqs.find((b) => b.kind === 'contract')!.id;
  const budget = boqs.find((b) => b.kind === 'budget');
  if (budget) ps.budgetBoqId = budget.id;
  const rows = await c.s.get<{
    rows: {
      id: string;
      type: string;
      code: string | null;
      unit: string | null;
      qty: string | null;
      rate: string | null;
    }[];
  }>(`/tenant/boqs/${ps.contractBoqId}/rows?limit=500`, suresh);
  const keys = new Map(
    (
      await c.db<{ id: string; line_key: string }[]>`
        SELECT id::text, line_key::text FROM est.boq_node WHERE boq_id = ${ps.contractBoqId!}`
    ).map((r) => [r.id, r.line_key]),
  );
  for (const r of rows.rows) {
    if (r.type !== 'item' || !r.code) continue;
    const plan = BOQ_ITEMS.find((i) => i.code === r.code)!;
    const item: ItemState = {
      code: r.code,
      nodeId: r.id,
      lineKey: keys.get(r.id)!,
      unit: r.unit ?? 'LS',
      qty: Number(r.qty),
      rate: Number(r.rate),
      window: plan.window,
      measured: 0,
      woMeasured: {},
    };
    if (plan.analysis) item.analysis = plan.analysis;
    if (plan.labourRate) item.labourRate = plan.labourRate;
    ps.items.push(item);
  }
  c.paths.push(`/boqs/${ps.contractBoqId}`);

  // WBS from the BOQ sections, mapped to cost codes; the cost baseline.
  await step(c, 'wbs', async () => {
    await c.s.post(
      `/tenant/projects/${proj.id}/wbs/from-boq`,
      { boqId: ps.contractBoqId, depth: 1 },
      suresh,
    );
    const tree = await c.s.get<{ id: string; code: string }[]>(
      `/tenant/projects/${proj.id}/wbs`,
      suresh,
    );
    for (const w of tree) ps.wbs[w.code] = w.code;
  });
  await step(c, 'material budget', async () => {
    await c.s.post(`/tenant/projects/${proj.id}/material-budget/from-tender`, {}, suresh);
    const mb = await c.s.get<{ revisions: { id: string; status: string }[] }>(
      `/tenant/projects/${proj.id}/material-budget`,
      suresh,
    );
    const draft = mb.revisions.find((r) => r.status === 'draft');
    if (draft) {
      const b = await c.s.get<{ rowVersion: number }>(
        `/tenant/material-budgets/${draft.id}`,
        suresh,
      );
      await c.s.post(
        `/tenant/material-budgets/${draft.id}/submit`,
        { rowVersion: b.rowVersion },
        suresh,
      );
    }
  });
  await step(c, 'cost baseline', () =>
    c.s.post(`/tenant/projects/${proj.id}/cost-control/baseline`, {}, suresh),
  );
  await step(c, 'cash terms', () =>
    c.s.post(
      `/tenant/projects/${proj.id}/cash-terms`,
      {
        certifyDays: 15,
        clientPayDays: 45,
        supplierDays: 30,
        costDays: 30,
        clientTdsPct: '2.00',
        rowVersion: null,
      },
      suresh,
    ),
  );
  await step(c, 'bill terms', () =>
    c.s.post(
      `/tenant/projects/${proj.id}/bill-terms`,
      {
        rowVersion: null,
        gstPct: '18',
        retentionPct: String(p.retentionPct),
        retentionCap: money(Math.round(bid * 0.05)),
        advanceAmount: p.advancePct ? money(Math.round((bid * p.advancePct) / 100)) : '0',
        advanceRecoveryPct: p.advancePct ? '12' : '0',
        sac: '995411',
      },
      suresh,
    ),
  );
  ps.advanceLeft = p.advancePct ? Math.round((bid * p.advancePct) / 100) : 0;

  // The contract register: agreement, performance security, obligations.
  await step(c, 'contract', async () => {
    const signed = addDays(p.result, 8);
    on(signed);
    const reg = await c.s.post<{ id: string; securities: { id: string }[] }>(
      `/tenant/projects/${proj.id}/contracts`,
      {
        kind: 'client',
        reference: `AGR/${p.client.toUpperCase()}/${p.result.slice(0, 4)}/${c.r.int(10, 99)}`,
        title: `Agreement for ${p.name}`,
        value: money(bid),
        signedOn: signed,
        startOn: p.start,
        completionOn: p.plannedFinish,
        dlpMonths: 12,
        ldPctPerWeek: '0.5',
        ldCapPct: '10',
        paymentTerms:
          'Monthly RA bills; certification within 15 days; payment within 30 days of certification; 5% retention, released after the defects liability period.',
      },
      as(c, 'priya'),
    );
    ps.contractId = reg.id;
    await c.s.post(
      `/tenant/contracts/${reg.id}/securities`,
      {
        kind: 'performance',
        issuer: 'HDFC Bank, Washim',
        number: `BG/${signed.slice(0, 4)}/${c.r.int(1000, 9999)}`,
        amount: money(Math.round(bid * 0.03)),
        validUntil: addMonths(p.plannedFinish, 15),
        claimUntil: addMonths(p.plannedFinish, 16),
        notes: 'Performance bank guarantee, 3% of the contract value',
      },
      as(c, 'priya'),
    );
    for (const [title, clause, due] of [
      ['Contractor all-risk insurance policy to be submitted', 'Cl. 21', addDays(p.start, 15)],
      [
        'Labour licence and BOCW registration copies to the engineer',
        'Cl. 34',
        addDays(p.start, 20),
      ],
      ['Quality assurance plan for approval', 'Cl. 12', addDays(p.start, 30)],
    ] as const)
      await c.s.post(
        `/tenant/contracts/${reg.id}/obligations`,
        { title, clause, dueOn: due },
        as(c, 'priya'),
      );
  });

  // The programme: one activity per BOQ section, baselined, linked to the BOQ.
  await step(c, 'programme', async () => {
    const plan = await c.s.post<{ id: string; rowVersion: number; calendars: { id: string }[] }>(
      `/tenant/projects/${proj.id}/schedules`,
      { name: `${p.name}: construction programme`, startOn: p.start },
      suresh,
    );
    const dur = diffDays(p.plannedFinish, p.start);
    const ops: Record<string, unknown>[] = [];
    let after: string | null = null;
    for (const [code, name] of BOQ_SECTIONS) {
      const items = BOQ_ITEMS.filter((i) => i.section === code);
      const a = Math.min(...items.map((i) => i.window[0]));
      const b = Math.max(...items.map((i) => i.window[1]));
      const tid = `ta${code}`;
      ops.push({
        op: 'insert',
        tempId: tid,
        parentId: null,
        afterId: after,
        code: `A${code}0`,
        name,
        duration: Math.max(5, Math.round((b - a) * dur * (6 / 7))),
        constraint: a > 0 ? { type: 'SNET', date: addDays(p.start, Math.round(a * dur)) } : null,
      });
      after = tid;
    }
    const made = await c.s.post<{ idMap: Record<string, string>; plan: { rowVersion: number } }>(
      `/tenant/programmes/${plan.id}/changes`,
      { rowVersion: plan.rowVersion, ops },
      suresh,
    );
    ps.scheduleId = plan.id;
    for (const [code] of BOQ_SECTIONS) ps.activities[code] = made.idMap[`ta${code}`]!;
    await c.s.post(
      `/tenant/programmes/${plan.id}/baselines`,
      { name: 'Contract baseline' },
      suresh,
    );
    for (const [code] of BOQ_SECTIONS)
      await step(c, 'activity lines', () =>
        c.s.post(
          `/tenant/programmes/${plan.id}/activities/${ps.activities[code]}/lines`,
          { boqId: ps.contractBoqId, code },
          suresh,
        ),
      );
    c.paths.push(`/programmes/${plan.id}`);
  });

  // The project starts: active, a store, work orders to the labour contractors.
  c.sched.at(p.start, 15, `start ${p.key}`, async () => {
    on(p.start);
    const cur = await c.s.get<{ rowVersion: number }>(`/tenant/projects/${proj.id}`, suresh);
    const r = await c.s.post<{ rowVersion: number }>(
      `/tenant/projects/${proj.id}/status`,
      { rowVersion: cur.rowVersion, status: 'active' },
      suresh,
    );
    ps.rowVersion = r.rowVersion;
    ps.status = 'active';
    const store = await c.s.post<{ id: string }>(
      `/tenant/projects/${proj.id}/stores`,
      { siteId: ps.siteId, name: `${p.site} store` },
      as(c, 'imran'),
    );
    ps.storeId = store.id;
    for (const k of p.labour) await step(c, 'work order', () => workOrder(c, ps, k));
    if (ps.advanceLeft > 0)
      c.sched.at(addDays(p.start, 12), 30, `advance ${p.key}`, () =>
        c.s.post(
          '/tenant/accounts/client-receipts',
          {
            entityId: c.entityId,
            partyId: c.party[p.client],
            receivedOn: addDays(p.start, 12),
            bankAccountId: c.bank,
            amount: money(ps.advanceLeft),
            reference: `RTGS/${p.client.toUpperCase()}/ADV`,
            narration: `Mobilisation advance against bank guarantee: ${p.name}`,
            allocations: [
              { kind: 'advance', billId: null, projectId: ps.id, amount: money(ps.advanceLeft) },
            ],
          },
          as(c, 'kavita'),
        ),
      );
  });
  scheduleProjectMonths(c, ps);
  scheduleProjectExtras(c, ps);
  scheduleProjectRegisters(c, ps);
}

async function workOrder(c: Ctx, ps: ProjectState, k: string) {
  const isMep = k === 'mep';
  const lines = ps.items
    .filter((i) => (isMep ? i.code === '5.1' || i.code === '5.2' : i.labourRate))
    .map((i) => ({
      key: i.code,
      description: isMep
        ? `${i.code === '5.1' ? 'Electrical' : 'Plumbing and sanitary'} works, supply and fixing (BOQ ${i.code})`
        : `Labour for BOQ ${i.code}: ${ANALYSES.find((a) => a.code === i.analysis)!.description.split(',')[0]}`,
      unit: i.unit,
      qty: qty4(i.qty),
      rate: money(isMep ? i.rate * 0.72 : i.labourRate!),
    }));
  if (!lines.length) return;
  const o = await c.s.post<{ id: string; open: { id: string; rowVersion: number } }>(
    `/tenant/projects/${ps.id}/orders`,
    {
      kind: 'work',
      partyId: c.party[k],
      siteId: ps.siteId,
      paymentTerms:
        'Monthly RA bills on joint measurement; 5% retention; TDS and 1% labour cess deducted.',
      lines: lines.map(({ key: _k, ...l }) => ({ ...l, gstPct: '18' })),
    },
    as(c, 'suresh'),
  );
  const issued = await c.s.post<{
    id: string;
    number: string;
    inForce: { lines: { lineKey: string; description: string }[] };
  }>(
    `/tenant/order-revisions/${o.open.id}/submit`,
    { rowVersion: o.open.rowVersion, overBudgetReason: OVER_BUDGET_REASON },
    as(c, 'suresh'),
  );
  const byCode: Record<string, string> = {};
  issued.inForce.lines.forEach((l, i) => (byCode[lines[i]!.key] = l.lineKey));
  ps.wo[k] = { id: issued.id, lines: byCode, number: issued.number };
  await c.s.put(
    `/tenant/work-orders/${issued.id}/subcontract-terms`,
    {
      retentionPct: '5',
      retentionCap: null,
      advanceRecoveryPct: '0',
      labourCessPct: '1',
      tdsSection: '194C',
    },
    as(c, 'suresh'),
  );
  c.paths.push(`/orders/${issued.id}`);
}

// --- every month on site: measure, bill, get paid ------------------------------------------------------------------

function scheduleProjectMonths(c: Ctx, ps: ProjectState) {
  const p = ps.plan;
  const last = minDay(ps.end, addDays(c.today, -1));
  for (let m = lastOfMonth(p.start); ; m = lastOfMonth(addDays(m, 1))) {
    const d = minDay(m, last);
    const final = d === ps.end;
    c.sched.at(d, 70, `measure ${p.key}`, () => measureMonth(c, ps, d));
    c.sched.at(d, 72, `programme ${p.key}`, () => updateProgramme(c, ps, d));
    // Bill the next working day; certified within two weeks; paid in four to seven.
    let billOn = addDays(d, 1);
    while (!isWorkDay(billOn)) billOn = addDays(billOn, 1);
    // A month still running is billed when it ends.
    if (billOn <= c.today && (d === m || final))
      c.sched.at(billOn, 30, `RA bill ${p.key}`, () => raBill(c, ps, d));
    let subOn = addDays(d, 3);
    if (subOn <= c.today)
      c.sched.at(subOn, 32, `subcontract bills ${p.key}`, () => subcontractBills(c, ps, d));
    subOn = addDays(d, 5);
    if (subOn <= c.today)
      c.sched.at(subOn, 60, `cost month ${p.key}`, () =>
        c.s.post(
          `/tenant/projects/${ps.id}/cost-control/months/${d.slice(0, 7)}/close`,
          {},
          as(c, 'suresh'),
        ),
      );
    if (final || d >= last) break;
  }
  if (p.finished && p.finished <= c.today)
    c.sched.at(p.finished, 75, `complete ${p.key}`, () => complete(c, ps));
}

async function measureMonth(c: Ctx, ps: ProjectState, d: Day) {
  const who = as(
    c,
    siteTeam(ps.plan.key).find((u) => c.users[u] && (u !== 'sachin' || d <= '2025-06-30')) ??
      'suresh',
  );
  for (const it of ps.items) {
    const target = Math.round(itemDone(ps, it, d) * it.qty * 100) / 100;
    const delta = Math.round((target - it.measured) * 100) / 100;
    if (delta <= 0) continue;
    const ok = await step(c, 'measurement', () =>
      c.s.post(
        `/tenant/boqs/${ps.contractBoqId}/lines/${it.nodeId}/progress`,
        {
          measuredOn: d,
          qty: qty4(delta),
          description: `Joint measurement with the client's engineer, ${d.slice(0, 7)}`,
        },
        who,
      ),
    );
    if (!ok) continue;
    it.measured = target;
    bump(c, 'measurements');
    // The labour contractor's book follows the same quantities.
    for (const [k, wo] of Object.entries(ps.wo)) {
      const lineKey = wo.lines[it.code];
      if (!lineKey) continue;
      const done = it.woMeasured[k] ?? 0;
      const woDelta = Math.round((target - done) * 10_000) / 10_000;
      if (woDelta <= 0) continue;
      const okWo = await step(c, 'work order measurement', () =>
        c.s.post(
          `/tenant/work-orders/${wo.id}/measurements`,
          {
            lineKey,
            measuredOn: d,
            qty: qty4(woDelta),
            description: `Measured with ${partyName(k)}'s supervisor`,
          },
          as(c, 'suresh'),
        ),
      );
      if (okWo) it.woMeasured[k] = target;
    }
  }
}

async function updateProgramme(c: Ctx, ps: ProjectState, d: Day) {
  if (!ps.scheduleId) return;
  const suresh = as(c, 'suresh');
  const plan = await c.s.get<{ rowVersion: number }>(`/tenant/programmes/${ps.scheduleId}`, suresh);
  const moved = await c.s.post<{ rowVersion: number }>(
    `/tenant/programmes/${ps.scheduleId}`,
    { rowVersion: plan.rowVersion, dataDate: d },
    suresh,
  );
  const ops: Record<string, unknown>[] = [];
  for (const [code] of BOQ_SECTIONS) {
    const items = ps.items.filter(
      (i) => BOQ_ITEMS.find((b) => b.code === i.code)?.section === code,
    );
    const done =
      items.reduce((s, i) => s + itemDone(ps, i, d) * i.qty * i.rate, 0) /
      Math.max(
        1,
        items.reduce((s, i) => s + i.qty * i.rate, 0),
      );
    if (done <= 0.001) continue;
    const a = Math.min(...items.map((i) => i.window[0]));
    const b = Math.max(...items.map((i) => i.window[1]));
    const total = diffDays(ps.end, ps.plan.start);
    const actualStart = minDay(addDays(ps.plan.start, Math.round(a * total)), d);
    const finished = done >= 0.999;
    ops.push({
      op: 'update',
      id: ps.activities[code],
      progress: {
        actualStart,
        actualFinish: finished ? minDay(addDays(ps.plan.start, Math.round(b * total)), d) : null,
        remaining: finished
          ? null
          : Math.max(1, Math.round((1 - done) * (b - a) * total * (6 / 7))),
      },
    });
  }
  if (ops.length)
    await c.s.post(
      `/tenant/programmes/${ps.scheduleId}/changes`,
      { rowVersion: moved.rowVersion, ops },
      suresh,
    );
}

async function raBill(c: Ctx, ps: ProjectState, upto: Day) {
  const suresh = as(c, 'suresh');
  const bill = await c.s.post<{
    id: string;
    rowVersion: number;
    figures?: { invoiceTotal: string };
  }>(`/tenant/projects/${ps.id}/client-bills`, { upto, siteId: ps.siteId }, suresh);
  const sub = await step(c, 'RA bill submit', () =>
    c.s.post<{ rowVersion: number }>(
      `/tenant/client-bills/${bill.id}/submit`,
      { rowVersion: bill.rowVersion },
      suresh,
    ),
  );
  if (!sub) {
    await c.s.post(
      `/tenant/client-bills/${bill.id}/cancel`,
      { reason: 'Nothing new to bill this month.' },
      suresh,
    );
    return;
  }
  ps.billedUpto = upto;
  c.paths.push(`/client-bills/${bill.id}`);
  bump(c, 'RA bills');
  const certOn = addDays(upto, c.r.int(9, 16));
  if (certOn > c.today) return; // still with the client's engineer
  c.sched.at(certOn, 35, `certify ${ps.plan.key}`, async () => {
    const certified = await c.s.post<{ certified: { net: string; taxable: string }; raNo: number }>(
      `/tenant/client-bills/${bill.id}/certify`,
      {
        rowVersion: sub.rowVersion,
        certifiedOn: certOn,
        clientRef: `CERT/${ps.plan.client.toUpperCase()}/${certOn.replaceAll('-', '')}`,
        lines: [],
      },
      as(c, 'suresh'),
    );
    const net = Number(certified.certified.net);
    const tds = Math.round(Number(certified.certified.taxable) * 0.02);
    const rec = { id: bill.id, net, tds, certifiedOn: certOn, received: false };
    ps.bills.push(rec);
    const payOn = addDays(certOn, c.r.int(24, 50));
    if (payOn > c.today || net <= 0) return;
    c.sched.at(payOn, 35, `receipt ${ps.plan.key}`, async () => {
      await c.s.post(
        '/tenant/accounts/client-receipts',
        {
          entityId: c.entityId,
          partyId: c.party[ps.plan.client],
          receivedOn: payOn,
          bankAccountId: c.bank,
          amount: money(net - tds),
          tds: money(tds),
          reference: `RTGS/${payOn.replaceAll('-', '')}/${c.r.int(100000, 999999)}`,
          narration: `RA bill ${certified.raNo}: ${ps.plan.name}`,
          allocations: [{ kind: 'bill', billId: bill.id, projectId: null, amount: money(net) }],
        },
        as(c, 'kavita'),
      );
      rec.received = true;
      bump(c, 'client receipts');
    });
  });
}

async function subcontractBills(c: Ctx, ps: ProjectState, upto: Day) {
  for (const [k, wo] of Object.entries(ps.wo)) {
    const bill = await step(c, 'subcontract bill', () =>
      c.s.post<{ id: string; rowVersion: number }>(
        `/tenant/work-orders/${wo.id}/subcontract-bills`,
        { upto },
        as(c, 'suresh'),
      ),
    );
    if (!bill) continue;
    const ok = await step(
      c,
      'subcontract bill submit',
      () =>
        c.s.post(
          `/tenant/subcontract-bills/${bill.id}/submit`,
          { rowVersion: bill.rowVersion },
          as(c, 'suresh'),
        ),
      /nothing_to_bill/,
    );
    if (!ok)
      await step(c, 'subcontract bill cancel', () =>
        c.s.post(
          `/tenant/subcontract-bills/${bill.id}/cancel`,
          { reason: 'Nothing measured this month.' },
          as(c, 'suresh'),
        ),
      );
    else bump(c, `subcontract bills (${k})`);
  }
}

async function complete(c: Ctx, ps: ProjectState) {
  const d = ps.plan.finished!;
  const suresh = as(c, 'suresh');
  on(d, 17);
  const cur = await c.s.get<{ rowVersion: number }>(`/tenant/projects/${ps.id}`, suresh);
  const r = await c.s.post<{ rowVersion: number }>(
    `/tenant/projects/${ps.id}`,
    { actualFinishOn: d, rowVersion: cur.rowVersion },
    suresh,
  );
  const done = await c.s.post<{ rowVersion: number }>(
    `/tenant/projects/${ps.id}/status`,
    { rowVersion: r.rowVersion, status: 'completed' },
    suresh,
  );
  ps.rowVersion = done.rowVersion;
  ps.status = 'completed';
  bump(c, 'projects completed');
  // Work orders closed after their final bills; the defects period runs a year, then the retention comes back.
  const closeOn = addDays(d, 9);
  if (closeOn <= c.today)
    c.sched.at(closeOn, 60, `close work orders ${ps.plan.key}`, async () => {
      for (const wo of Object.values(ps.wo))
        await step(c, 'close work order', () =>
          c.s.post(
            `/tenant/orders/${wo.id}/close`,
            { reason: 'Work complete and finally measured.' },
            suresh,
          ),
        );
    });
  const release = addDays(addMonths(d, 12), 20);
  if (release <= c.today)
    c.sched.at(release, 36, `retention ${ps.plan.key}`, async () => {
      const open = await c.s.get<{ projects: { id: string; retentionOpen: string }[] }>(
        `/tenant/accounts/open-items?entityId=${c.entityId}&partyId=${c.party[ps.plan.client]}`,
        as(c, 'kavita'),
      );
      const held = Number(open.projects.find((x) => x.id === ps.id)?.retentionOpen ?? 0);
      if (held > 0)
        await c.s.post(
          '/tenant/accounts/client-receipts',
          {
            entityId: c.entityId,
            partyId: c.party[ps.plan.client],
            receivedOn: release,
            bankAccountId: c.bank,
            amount: money(held),
            reference: `RTGS/RET/${release.replaceAll('-', '')}`,
            narration: `Retention released after the defects liability period: ${ps.plan.name}`,
            allocations: [
              { kind: 'retention', billId: null, projectId: ps.id, amount: money(held) },
            ],
          },
          as(c, 'kavita'),
        );
      for (const [k, wo] of Object.entries(ps.wo)) {
        const book = await c.s.get<{ retention: { held: string; released: string } | null }>(
          `/tenant/work-orders/${wo.id}/subcontract`,
          suresh,
        );
        const owed = Number(book.retention?.held ?? 0) - Number(book.retention?.released ?? 0);
        if (owed > 0)
          await step(c, 'subcontract retention', () =>
            c.s.post(
              `/tenant/work-orders/${wo.id}/retention-release`,
              { date: addDays(release, 5), amount: money(owed) },
              as(c, 'kavita'),
            ),
          );
        void k;
      }
      const now = await c.s.get<{ rowVersion: number }>(`/tenant/projects/${ps.id}`, suresh);
      await c.s.post(
        `/tenant/projects/${ps.id}/status`,
        { rowVersion: now.rowVersion, status: 'closed' },
        suresh,
      );
    });
}

export { RESOURCES };
