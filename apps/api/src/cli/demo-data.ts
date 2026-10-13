// The demo company (see demo-seed.ts): Deshmukh Infra Pvt Ltd, a Washim building contractor. Its history from January
// 2024 to today is replayed through the API (cli/demo/history.ts); then today's open items are added: the portals'
// users with something waiting for each, a steel enquiry on the open tender, a transmittal to the client, approval
// rules with requests waiting, a permit to work, and the public API key.
import type { Sql } from 'postgres';
import type { Seeder } from './demo-seed.js';
import { type Ctx, as, step } from './demo/ctx.js';
import { seedHistory } from './demo/history.js';
import { STAFF } from './demo/plan.js';
import { addDays, money, rupees } from './demo/util.js';

type H = Record<string, string>;
const DEMO_PORTAL_PASSWORD = 'Portal-Demo-2026';

export interface SeedResult {
  staff: { username: string; role: string; what: string; active: boolean }[];
  portal: { email: string; kind: string; party: string }[];
  apiKey: string;
  paths: string[];
}

export async function seedCompany(
  s: Seeder,
  db: Sql,
  ctx: { admin: H; entitlement: string; tenantId: string; licenceId: string },
): Promise<SeedResult> {
  const { c, labour } = await seedHistory(s, db, ctx);
  const today = c.today;
  const p7 = c.projects.p7;
  const paths = [...c.paths];

  // --- portals: one of each kind, each with something to do ---
  const portal: SeedResult['portal'] = [];
  const invite = async (key: string, kind: string, email: string, name: string, party: string) => {
    const inv = await s.post<{ token: string }>(
      '/tenant/portal-users',
      { partyId: c.party[key], kind, email, name },
      as(c, 'suresh'),
    );
    await s.post('/portal/auth/accept', { tenant: ctx.tenantId, token: inv.token, password: DEMO_PORTAL_PASSWORD }, {});
    portal.push({ email, kind, party });
  };
  await step(c, 'portal users', async () => {
    await invite('steel', 'vendor', 'sales@shinde-steel.demo', 'Anil Shinde', 'Shinde Steel Traders');
    await invite('kale', 'subcontractor', 'site@kale.demo', 'Ramesh Kale', 'Kale Constructions');
    await invite('zp', 'client', 'ee.works@zpwashim.demo', 'Executive Engineer', 'Zilla Parishad Washim');
  });
  if (p7) {
    // A steel order to Shinde for the Washim school, issued today and waiting for their acknowledgement.
    await step(c, 'steel order', async () => {
      const o = await s.post<{ open: { id: string; rowVersion: number } }>(
        `/tenant/projects/${p7.id}/orders`,
        {
          kind: 'purchase',
          partyId: c.party.steel,
          siteId: p7.siteId,
          deliverBy: addDays(today, 5),
          lines: [{ resourceId: c.res['M-STL']!.id, description: 'TMT bars Fe 500D', unit: 't', qty: '6', rate: money(c.res['M-STL']!.rate(today)), gstPct: '18' }],
        },
        as(c, 'imran'),
      );
      const po = await s.post<{ id: string }>(`/tenant/order-revisions/${o.open.id}/submit`, { rowVersion: o.open.rowVersion }, as(c, 'imran'));
      paths.push(`/orders/${po.id}`);
    });
    // Kale sends this week's plaster measurement from the portal.
    const wo = p7.wo.kale;
    const plaster = p7.items.find((i) => i.code === '4.1');
    if (wo && plaster && wo.lines['4.1'])
      await step(c, 'portal measurement', async () => {
        const kale = await s.post<{ accessToken: string }>('/portal/auth/login', { tenant: ctx.tenantId, email: 'site@kale.demo', password: DEMO_PORTAL_PASSWORD }, {});
        const room = plaster.qty - (plaster.woMeasured.kale ?? 0);
        await s.post(
          `/portal/orders/${wo.id}/measurements`,
          { measuredOn: addDays(today, -1), lines: [{ lineKey: wo.lines['4.1'], qty: String(Math.max(1, Math.min(120, Math.floor(room / 2)))), description: 'First floor, east wing' }] },
          { authorization: `Bearer ${kale.accessToken}` },
        );
      });
    // Two drawings for approval sent to the client today (the client acknowledges them on the portal).
    await step(c, 'transmittal', async () => {
      const pdf = (t: string) => Buffer.from(`%PDF-1.4\n% ${t}\n%%EOF\n`);
      const a = await s.upload<{ document: { id: string } }>(`/tenant/projects/${p7.id}/documents/upload`, as(c, 'suresh'), 'A-301 Revised toilet block plan.pdf', 'application/pdf', pdf('toilet block'));
      const b = await s.upload<{ document: { id: string } }>(`/tenant/projects/${p7.id}/documents/upload`, as(c, 'suresh'), 'S-301 Toilet block footing details.pdf', 'application/pdf', pdf('footings'));
      const t = await s.post<{ id: string }>(
        `/tenant/projects/${p7.id}/transmittals`,
        { subject: 'Revised drawings for approval', recipient: 'Executive Engineer, ZP Washim', partyId: c.party.zp, purpose: 'review', responseDays: 7, items: [{ documentId: a.document.id, copies: 2 }, { documentId: b.document.id }] },
        as(c, 'suresh'),
      );
      await s.post(`/tenant/transmittals/${t.id}/issue`, {}, as(c, 'suresh'));
    });
  }
  // A steel enquiry out on the open tender (Shinde quotes it on the portal).
  await step(c, 'tender RFQ', async () => {
    const list = await s.get<{ items: { id: string; title: string }[] }>('/tenant/tenders?status=open', as(c, 'priya'));
    const tender = list.items.find((t) => t.title === 'Primary health centre, Risod');
    if (!tender) return;
    const rfq = await s.post<{ id: string }>(`/tenant/tenders/${tender.id}/rfqs`, { title: 'Reinforcement steel', kind: 'material', dueOn: addDays(today, 10) }, as(c, 'priya'));
    for (const [description, unit] of [['TMT bars Fe 500D, 8-16 mm', 't'], ['Binding wire', 'kg']])
      await s.post(`/tenant/rfqs/${rfq.id}/lines`, { free: { description, unit } }, as(c, 'priya'));
    await s.post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: c.party.steel }, as(c, 'priya'));
    await s.post(`/tenant/rfqs/${rfq.id}/vendors/${c.party.steel}`, { status: 'sent' }, as(c, 'priya'));
    paths.push(`/rfqs/${rfq.id}`);
  });

  // --- approvals from today on: big orders and leave need a second person ---
  await step(c, 'approval rules', async () => {
    await s.post('/tenant/approval-rules/purchase_order', { rules: [{ minAmount: '500000.00', approver: 'manager', label: 'Orders of ₹5 lakh and more' }] }, c.admin);
    await s.post('/tenant/approval-rules/leave_application', { rules: [{ minAmount: '0.00', approver: 'designation', designationId: (await s.get<{ id: string; name: string }[]>('/tenant/hr/designations', c.admin)).find((d) => d.name === 'HR and admin executive')!.id, label: 'HR' }] }, c.admin);
  });
  const p9 = c.projects.p9;
  if (p9)
    await step(c, 'order waiting for approval', async () => {
      const o = await s.post<{ open: { id: string; rowVersion: number } }>(
        `/tenant/projects/${p9.id}/orders`,
        { kind: 'purchase', partyId: c.party.cement, siteId: p9.siteId, deliverBy: addDays(today, 7), lines: [{ resourceId: c.res['M-CEM']!.id, description: 'Cement OPC 53 grade', unit: 'bag', qty: '1800', rate: money(c.res['M-CEM']!.rate(today)), gstPct: '28' }] },
        as(c, 'imran'),
      );
      await s.post(`/tenant/order-revisions/${o.open.id}/submit`, { rowVersion: o.open.rowVersion }, as(c, 'imran'));
    });
  await step(c, 'leave waiting for approval', async () => {
    const types = await s.get<{ id: string; code: string }[]>('/tenant/hr/leave-types', c.admin);
    let from = addDays(today, 9);
    if (new Date(`${from}T00:00:00Z`).getUTCDay() === 0) from = addDays(from, 1);
    await s.post('/tenant/hr/leave', { employeeId: null, leaveTypeId: types.find((t) => t.code === 'CL')!.id, from, to: from, halfDay: false, reason: "Sister's engagement" }, as(c, 'raju'));
  });
  // A permit to work at height on the hospital job: one issued for today, one waiting.
  if (p9)
    await step(c, 'permits', async () => {
      const now = Date.now();
      const iso = (t: number) => new Date(t + 330 * 60_000).toISOString().slice(0, 19) + '+05:30';
      const p1 = await s.post<{ id: string }>(`/tenant/projects/${p9.id}/permits`, { siteId: p9.siteId, kind: 'height', location: 'OPD block, second floor slab edge', work: 'Fixing edge protection and shuttering at the slab edge', validFrom: iso(now - 3_600_000), validTo: iso(now + 7 * 3_600_000) }, as(c, 'raju'));
      await s.post(`/tenant/permits/${p1.id}/issue`, { confirmed: [true, true, true, true] }, as(c, 'rahul'));
      await s.post(`/tenant/projects/${p9.id}/permits`, { siteId: p9.siteId, kind: 'hot_work', location: 'Staircase 1', work: 'Welding the staircase railing', validFrom: iso(now + 3_600_000), validTo: iso(now + 6 * 3_600_000) }, as(c, 'raju'));
    });

  // --- the public API ---
  const apiKey =
    (await step(c, 'API key', async () =>
      (await s.post<{ key: string }>('/tenant/integrations/api-keys', { name: 'Demo key', scopes: ['reports:read', 'tally'] }, c.admin)).key,
    )) ?? '';

  // People who left can no longer sign in.
  for (const p of STAFF.filter((x) => x.left && x.left.on < today))
    await step(c, 'deactivate leaver', () => s.post(`/tenant/users/${c.users[p.username]!.id}/deactivate`, {}, c.admin));

  summarise(s, c, labour.hired);
  return {
    staff: STAFF.map((p) => ({ username: p.username, role: p.role, what: p.what, active: !(p.left && p.left.on < today) })),
    portal,
    apiKey,
    paths: [...new Set(paths)],
  };
}

function summarise(s: Seeder, c: Ctx, hired: Record<string, number>) {
  const n = (k: string) => c.counts[k] ?? 0;
  s.note(`Company: Deshmukh Infra Pvt Ltd, Washim, books from 1 January 2024, ₹1 crore of share capital`);
  s.note(`Staff: ${STAFF.length} engaged since 2024, ${STAFF.filter((p) => !p.left).length} on the rolls today (2 resigned, 1 terminated); ${n('payroll runs')} monthly payroll runs`);
  s.note(`Labour: ${Object.values(hired).reduce((a, b) => a + b, 0)} workers engaged through 3 labour contractors (${n('workers left')} have left); ${n('muster marks')} muster marks; ${n('wage sheets')} wage sheets`);
  s.note(`Projects: ${n('projects')} won by tender, ${n('projects completed')} completed; ${n('tenders')} tenders priced, ${n('leads')} other CRM leads; Sai Residency (own development, MahaRERA), ${n('flat bookings')} flats booked`);
  s.note(`Site: ${n('daily reports')} daily reports, ${n('measurements')} measurements, ${n('machine log sheets')} machine log sheets, ${n('quality tests')} quality tests, ${n('inspections')} inspections, ${n('toolbox talks')} toolbox talks, ${n('incidents')} incidents`);
  s.note(`Purchase: ${n('requisitions')} requisitions, ${n('purchase orders')} purchase orders, ${n('goods receipts')} goods receipts, ${n('store issues')} store issues`);
  s.note(`Money: ${n('RA bills')} RA bills to clients, ${n('client receipts')} receipts, ${n('supplier bills')} supplier bills, ${n('payment runs')} payment runs, ${n('fixed assets')} fixed assets; FY 2023-24 to ${n('years closed') ? 'the last' : 'no'} closed year closed`);
  const fails = [...c.failures.entries()];
  if (fails.length) {
    s.note(`(${fails.reduce((a, [, f]) => a + f.count, 0)} steps did not go through; see the log above)`);
    for (const [k, f] of fails) s.failures.push(`${k} x${f.count}`);
  }
  void rupees;
}
