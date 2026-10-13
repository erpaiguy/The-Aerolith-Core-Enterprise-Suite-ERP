// The demo company's records (see demo-seed.ts): a mid-size Vidarbha contractor that also develops one residential
// project. Each part goes through the API's routes as the person who would do it, so permissions and numbering are
// exercised as in use. Kept small enough to read: a handful of records per screen.
import type { Seeder } from './demo-seed.js';

type H = Record<string, string>;
const DEMO_STAFF_PASSWORD = 'Site-Office-Demo-26';
const DEMO_PORTAL_PASSWORD = 'Portal-Demo-2026';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const daysAgo = (n: number) =>
  new Date(Date.now() + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
const month = (ahead: number) => {
  const d = new Date(Date.now() + 330 * 60_000);
  d.setUTCMonth(d.getUTCMonth() + ahead);
  return d.toISOString().slice(0, 7);
};

export interface SeedResult {
  staff: { username: string; role: string; what: string }[];
  portal: { email: string; kind: string; party: string }[];
  apiKey: string;
  paths: string[];
}

/** One step of the demo; a failure is reported with the step's name and the rest carries on. */
async function step<T>(s: Seeder, name: string, f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f();
  } catch (err) {
    s.note(`(skipped: ${name}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)})`);
    s.failures.push(name);
    return undefined;
  }
}

export async function seedCompany(
  s: Seeder,
  ctx: { admin: H; entitlement: string; tenantId: string; licenceId: string },
): Promise<SeedResult> {
  const { admin } = ctx;
  const paths: string[] = [];

  // --- people ---
  const staff = async (username: string, displayName: string, role: 'manager' | 'worker') => {
    const created = await s.post<{ id: string; temporaryPassword: string }>(
      '/tenant/users',
      { username, displayName, role },
      admin,
    );
    const login = (password: string) =>
      s.post<{ accessToken: string }>(
        '/auth/login',
        { entitlementToken: ctx.entitlement, identifier: username, password, client: 'desktop' },
        {},
      );
    const first = await login(created.temporaryPassword);
    await s.post(
      '/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: DEMO_STAFF_PASSWORD },
      { authorization: `Bearer ${first.accessToken}` },
    );
    return {
      id: created.id,
      h: { authorization: `Bearer ${(await login(DEMO_STAFF_PASSWORD)).accessToken}` },
    };
  };
  const suresh = await staff('suresh', 'Suresh Patil', 'manager');
  const priya = await staff('priya', 'Priya Kulkarni', 'manager');
  const raju = await staff('raju', 'Raju Wankhede', 'worker');
  const meena = await staff('meena', 'Meena Joshi', 'worker');
  s.note(
    'Staff: 2 managers (Suresh: projects and purchase; Priya: estimation, sales, accounts), 2 site workers',
  );

  // --- the company ---
  const company = (
    await s.get<{ companies: { id: string; rowVersion: number }[] }>('/tenant/companies', admin)
  ).companies[0]!;
  await s.post(
    `/tenant/companies/${company.id}`,
    {
      name: 'Deshmukh Infra Pvt Ltd',
      gstin: '27AAACD1234K1Z5',
      booksFrom: '2026-04-01',
      rowVersion: company.rowVersion,
    },
    admin,
  );
  const entityId = company.id;

  // --- parties ---
  const party = async (name: string, roles: Record<string, unknown>) =>
    (await s.post<{ id: string }>('/tenant/parties', { name, isClient: false, ...roles }, admin))
      .id;
  const zp = await party('Zilla Parishad Washim', {
    isClient: true,
    gstin: '27AAALZ0123P1ZK',
    email: 'ee.works@zpwashim.demo',
  });
  const sanstha = await party('Shivaji Shikshan Sanstha', {
    isClient: true,
    email: 'office@sss.demo',
  });
  const shinde = await party('Shinde Steel Traders', {
    isVendor: true,
    gstin: '27ABCPS4321L1Z9',
    email: 'sales@shinde-steel.demo',
  });
  const vidarbha = await party('Vidarbha Cement Traders', {
    isVendor: true,
    gstin: '27AAACV1234F1Z5',
    email: 'orders@vct.demo',
  });
  const kale = await party('Kale Constructions', {
    isVendor: true,
    isSubcontractor: true,
    gstin: '27ABCPK1234L1Z5',
    pan: 'ABCPK1234L',
    email: 'site@kale.demo',
  });
  s.note('Parties: 2 clients, 2 suppliers, 1 subcontractor');

  // --- CRM ---
  await step(s, 'CRM leads', async () => {
    const leads = [
      [
        'Hostel block for the engineering college',
        'Shivaji Shikshan Sanstha',
        'referral',
        '42000000',
      ],
      ['Primary health centre, Risod', 'Zilla Parishad Washim', 'repeat_client', '18500000'],
      ['Showroom fit-out, Akola', 'Auto Plaza Motors', 'website', '6500000'],
    ];
    for (const [title, organisation, source, value] of leads)
      await s.post(
        '/tenant/crm/leads',
        {
          title,
          organisation,
          source,
          segment: 'buildings',
          location: 'Vidarbha',
          value,
          expectedMonth: month(2),
        },
        priya.h,
      );
    s.note('CRM: 3 leads (open the CRM pipeline)');
  });

  // --- the contracting project: Washim school ---
  const project = await s.post<{ id: string }>(
    '/tenant/projects',
    { name: 'Zilla Parishad School, Washim', clientId: zp },
    suresh.h,
  );
  const projectId = project.id;
  paths.push(`/projects/${projectId}`);
  const site = (
    await s.post<{ sites: { id: string }[] }>(
      `/tenant/projects/${projectId}/sites`,
      { name: 'Washim main site', stateCode: '27' },
      suresh.h,
    )
  ).sites[0]!.id;
  for (const [u, role] of [
    [raju, 'member'],
    [meena, 'member'],
    [priya, 'member'],
  ] as const)
    await s.post(`/tenant/projects/${projectId}/team`, { userId: u.id, role }, suresh.h);
  s.note('Project: Zilla Parishad School, Washim (client ZP Washim), one site, team of 4');

  // A purchase order for cement and steel, issued, and part of it received.
  const po = await step(s, 'purchase order', async () => {
    const o = await s.post<{ open: { id: string; rowVersion: number } }>(
      `/tenant/projects/${projectId}/orders`,
      {
        kind: 'purchase',
        partyId: vidarbha,
        siteId: site,
        lines: [
          {
            description: 'Cement OPC 53 grade',
            unit: 'bag',
            qty: '400',
            rate: '390',
            gstPct: '28',
          },
          { description: 'River sand', unit: 'cum', qty: '60', rate: '2100', gstPct: '5' },
        ],
      },
      suresh.h,
    );
    const issued = await s.post<{
      id: string;
      number: string;
      inForce: { lines: { lineKey: string }[] };
    }>(`/tenant/order-revisions/${o.open.id}/submit`, { rowVersion: o.open.rowVersion }, suresh.h);
    paths.push(`/orders/${issued.id}`);
    return issued;
  });
  if (po)
    await step(s, 'goods receipt', async () => {
      const r = await s.post<{ id: string }>(
        `/tenant/orders/${po.id}/receipts`,
        {
          receivedOn: daysAgo(2),
          challanNo: 'VCT/DC/441',
          vehicleNo: 'MH37 T 1234',
          siteId: site,
          lines: [
            { lineKey: po.inForce.lines[0]!.lineKey, qty: '200' },
            { lineKey: po.inForce.lines[1]!.lineKey, qty: '20' },
          ],
        },
        raju.h,
      );
      paths.push(`/receipts/${r.id}`);
      s.note(
        `Purchase order ${po.number} to Vidarbha Cement, issued; 200 bags and 20 cum received`,
      );
    });

  // A steel order to Shinde, issued and waiting for their acknowledgement on the vendor portal.
  await step(s, 'steel order', async () => {
    const o = await s.post<{ open: { id: string; rowVersion: number } }>(
      `/tenant/projects/${projectId}/orders`,
      {
        kind: 'purchase',
        partyId: shinde,
        siteId: site,
        lines: [
          { description: 'TMT bars Fe 500D', unit: 't', qty: '12', rate: '61500', gstPct: '18' },
        ],
      },
      suresh.h,
    );
    await s.post(
      `/tenant/order-revisions/${o.open.id}/submit`,
      { rowVersion: o.open.rowVersion },
      suresh.h,
    );
    s.note('Purchase order to Shinde Steel, issued: Shinde can acknowledge it on the portal');
  });

  // A work order for brickwork to Kale, issued, with a measurement in the book.
  const wo = await step(s, 'work order', async () => {
    const o = await s.post<{ open: { id: string; rowVersion: number } }>(
      `/tenant/projects/${projectId}/orders`,
      {
        kind: 'work',
        partyId: kale,
        siteId: site,
        lines: [
          {
            description: 'Brickwork 230 mm in CM 1:6',
            unit: 'cum',
            qty: '180',
            rate: '4500',
            gstPct: '18',
          },
          {
            description: 'Internal plaster 12 mm',
            unit: 'sqm',
            qty: '2400',
            rate: '250',
            gstPct: '18',
          },
        ],
      },
      suresh.h,
    );
    const issued = await s.post<{
      id: string;
      number: string;
      inForce: { lines: { lineKey: string }[] };
    }>(`/tenant/order-revisions/${o.open.id}/submit`, { rowVersion: o.open.rowVersion }, suresh.h);
    await s.post(
      `/tenant/work-orders/${issued.id}/measurements`,
      {
        lineKey: issued.inForce.lines[0]!.lineKey,
        measuredOn: daysAgo(3),
        qty: '42.5',
        description: 'Ground floor walls',
      },
      suresh.h,
    );
    paths.push(`/orders/${issued.id}`);
    s.note(`Work order ${issued.number} to Kale Constructions, 42.5 cum of brickwork measured`);
    return issued;
  });

  // --- a tender with an RFQ out to Shinde (who can quote on the portal) ---
  await step(s, 'tender and RFQ', async () => {
    const tender = await s.post<{ id: string }>(
      '/tenant/tenders',
      { title: 'Primary health centre, Risod' },
      priya.h,
    );
    paths.push(`/tenders/${tender.id}`);
    const rfq = await s.post<{ id: string }>(
      `/tenant/tenders/${tender.id}/rfqs`,
      { title: 'Reinforcement steel', kind: 'material', dueOn: daysAgo(-14) },
      priya.h,
    );
    for (const [description, unit] of [
      ['TMT bars Fe 500D, 8-16 mm', 't'],
      ['Binding wire', 'kg'],
    ])
      await s.post(`/tenant/rfqs/${rfq.id}/lines`, { free: { description, unit } }, priya.h);
    await s.post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: shinde }, priya.h);
    await s.post(`/tenant/rfqs/${rfq.id}/vendors/${shinde}`, { status: 'sent' }, priya.h);
    paths.push(`/rfqs/${rfq.id}`);
    s.note(
      'Tender: Primary health centre, Risod, with an RFQ for steel sent to Shinde (quote it on the portal)',
    );
  });

  // --- portals: one of each kind ---
  const portal: SeedResult['portal'] = [];
  const invite = async (
    partyId: string,
    kind: string,
    email: string,
    name: string,
    partyName: string,
  ) => {
    const inv = await s.post<{ token: string }>(
      '/tenant/portal-users',
      { partyId, kind, email, name },
      suresh.h,
    );
    await s.post(
      '/portal/auth/accept',
      { tenant: ctx.tenantId, token: inv.token, password: DEMO_PORTAL_PASSWORD },
      {},
    );
    portal.push({ email, kind, party: partyName });
  };
  await step(s, 'portal users', async () => {
    await invite(
      shinde,
      'vendor',
      'sales@shinde-steel.demo',
      'Anil Shinde',
      'Shinde Steel Traders',
    );
    await invite(kale, 'subcontractor', 'site@kale.demo', 'Ramesh Kale', 'Kale Constructions');
    await invite(
      zp,
      'client',
      'ee.works@zpwashim.demo',
      'Executive Engineer',
      'Zilla Parishad Washim',
    );
    s.note('Portal users: Shinde (vendor), Kale (subcontractor), ZP Washim (client)');
  });
  if (wo)
    await step(s, 'portal measurement', async () => {
      const kaleLogin = await s.post<{ accessToken: string }>(
        '/portal/auth/login',
        { tenant: ctx.tenantId, email: 'site@kale.demo', password: DEMO_PORTAL_PASSWORD },
        {},
      );
      await s.post(
        `/portal/orders/${wo.id}/measurements`,
        {
          measuredOn: daysAgo(1),
          lines: [
            { lineKey: wo.inForce.lines[1]!.lineKey, qty: '310', description: 'First floor' },
          ],
        },
        { authorization: `Bearer ${kaleLogin.accessToken}` },
      );
      s.note('Kale sent a plaster measurement from the portal: waiting under Portal submissions');
    });

  // --- reports and the API ---
  await step(s, 'saved report', async () => {
    await s.post(
      '/tenant/reports/saved',
      {
        name: 'Purchase orders by vendor',
        spec: {
          view: 'purchase_orders',
          fields: [],
          groupBy: ['vendor'],
          aggregates: [{ field: 'value', fn: 'sum' }],
        },
        chart: { kind: 'bar', label: 'vendor', value: 'sum_value' },
        sharedWith: 'everyone',
      },
      suresh.h,
    );
    s.note('Report builder: a shared report "Purchase orders by vendor"');
  });
  const apiKey =
    (await step(
      s,
      'API key',
      async () =>
        (
          await s.post<{ key: string }>(
            '/tenant/integrations/api-keys',
            { name: 'Demo key', scopes: ['reports:read', 'tally'] },
            admin,
          )
        ).key,
    )) ?? '';

  const more = await seedMore(s, {
    admin,
    suresh: suresh.h,
    priya: priya.h,
    raju: raju.h,
    meena: meena.h,
    entityId,
    projectId,
    site,
    zp,
    sanstha,
    paths,
  });

  return {
    staff: [
      { username: 'suresh', role: 'manager', what: 'project manager: projects, purchase, site' },
      { username: 'priya', role: 'manager', what: 'estimation, CRM, sales and RERA, accounts' },
      { username: 'raju', role: 'worker', what: 'site engineer on the Washim school' },
      { username: 'meena', role: 'worker', what: 'site supervisor on the Washim school' },
    ],
    portal,
    apiKey,
    paths: [...paths, ...more],
  };
}

/** Estimation, billing, site, stores, documents, people and real estate. */
async function seedMore(
  s: Seeder,
  c: {
    admin: H;
    suresh: H;
    priya: H;
    raju: H;
    meena: H;
    entityId: string;
    projectId: string;
    site: string;
    zp: string;
    sanstha: string;
    paths: string[];
  },
): Promise<string[]> {
  const paths: string[] = [];
  const { projectId } = c;

  // --- a tender BOQ ---
  await step(s, 'tender BOQ', async () => {
    const tender = await s.post<{ id: string }>(
      '/tenant/tenders',
      { title: 'Hostel block, Amravati' },
      c.priya,
    );
    const boq = await s.post<{ id: string }>(
      `/tenant/tenders/${tender.id}/boqs`,
      { name: 'Civil' },
      c.priya,
    );
    await s.post(
      `/tenant/boqs/${boq.id}/changes`,
      {
        ops: [
          {
            op: 'insert',
            tempId: 'tA',
            parentId: null,
            afterId: null,
            type: 'section',
            code: '1',
            description: 'Earthwork',
          },
          {
            op: 'insert',
            tempId: 'ta1',
            parentId: 'tA',
            afterId: null,
            type: 'item',
            code: '1.1',
            description: 'Excavation in ordinary soil',
            unit: 'cum',
            qty: '850',
            rate: '320',
          },
          {
            op: 'insert',
            tempId: 'tB',
            parentId: null,
            afterId: 'tA',
            type: 'section',
            code: '2',
            description: 'Concrete',
          },
          {
            op: 'insert',
            tempId: 'tb1',
            parentId: 'tB',
            afterId: null,
            type: 'item',
            code: '2.1',
            description: 'PCC M15',
            unit: 'cum',
            qty: '120',
            rate: '5600',
          },
          {
            op: 'insert',
            tempId: 'tb2',
            parentId: 'tB',
            afterId: 'tb1',
            type: 'item',
            code: '2.2',
            description: 'RCC M25 in columns and beams',
            unit: 'cum',
            qty: '310',
            rate: '7800',
          },
          {
            op: 'insert',
            tempId: 'tC',
            parentId: null,
            afterId: 'tB',
            type: 'section',
            code: '3',
            description: 'Finishes',
          },
          {
            op: 'insert',
            tempId: 'tc1',
            parentId: 'tC',
            afterId: null,
            type: 'item',
            code: '3.1',
            description: 'Internal plaster 12 mm',
            unit: 'sqm',
            qty: '5200',
            rate: '210',
          },
          {
            op: 'insert',
            tempId: 'tc2',
            parentId: 'tC',
            afterId: 'tc1',
            type: 'item',
            code: '3.2',
            description: 'Vitrified tile flooring',
            unit: 'sqm',
            qty: '1800',
            rate: '1150',
          },
        ],
      },
      c.priya,
    );
    paths.push(`/tenders/${tender.id}`, `/boqs/${boq.id}`);
    s.note('Tender: Hostel block, Amravati, with a priced Civil BOQ of 5 items');
  });

  // --- the school's contract BOQ, measured work and an RA bill submitted to ZP ---
  await step(s, 'contract BOQ and RA bill', async () => {
    const boq = await s.post<{ id: string }>(
      `/tenant/projects/${projectId}/boqs`,
      { name: 'Contract', kind: 'contract' },
      c.suresh,
    );
    const made = await s.post<{ idMap: Record<string, string> }>(
      `/tenant/boqs/${boq.id}/changes`,
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
          {
            op: 'insert',
            tempId: 't1',
            parentId: 'tA',
            afterId: null,
            type: 'item',
            code: 'A.1',
            description: 'Excavation in ordinary soil',
            unit: 'cum',
            qty: '600',
            rate: '350',
          },
          {
            op: 'insert',
            tempId: 't2',
            parentId: 'tA',
            afterId: 't1',
            type: 'item',
            code: 'A.2',
            description: 'PCC M15',
            unit: 'cum',
            qty: '80',
            rate: '5600',
          },
          {
            op: 'insert',
            tempId: 't3',
            parentId: 'tA',
            afterId: 't2',
            type: 'item',
            code: 'A.3',
            description: 'Brick masonry in CM 1:6',
            unit: 'cum',
            qty: '180',
            rate: '6200',
          },
        ],
      },
      c.suresh,
    );
    await s.post(
      `/tenant/boqs/${boq.id}/lines/${made.idMap.t1}/progress`,
      { measuredOn: daysAgo(20), qty: '420' },
      c.suresh,
    );
    await s.post(
      `/tenant/boqs/${boq.id}/lines/${made.idMap.t2}/progress`,
      { measuredOn: daysAgo(12), qty: '35' },
      c.suresh,
    );
    await s.post(
      `/tenant/projects/${projectId}/bill-terms`,
      { rowVersion: null, gstPct: '18', retentionPct: '5', retentionCap: '500000' },
      c.suresh,
    );
    const bill = await s.post<{ id: string; rowVersion: number }>(
      `/tenant/projects/${projectId}/client-bills`,
      { upto: daysAgo(5) },
      c.suresh,
    );
    await s.post(
      `/tenant/client-bills/${bill.id}/submit`,
      { rowVersion: bill.rowVersion },
      c.suresh,
    );
    paths.push(`/boqs/${boq.id}`, `/client-bills/${bill.id}`);
    s.note(
      'Washim school: contract BOQ, work measured, RA bill 1 submitted to ZP (the client sees it on the portal)',
    );
  });

  // --- today's daily report, with a photo ---
  await step(s, 'daily report', async () => {
    let r = await s.post<{ id: string; rowVersion: number }>(
      `/tenant/projects/${projectId}/daily-reports`,
      { siteId: c.site, reportDate: today() },
      c.raju,
    );
    r = await s.post<{ id: string; rowVersion: number }>(
      `/tenant/daily-reports/${r.id}`,
      {
        rowVersion: r.rowVersion,
        weatherAm: 'clear',
        weatherPm: 'cloudy',
        manpower: [
          { trade: 'Mason', headcount: 8 },
          { trade: 'Helper', headcount: 14 },
          { trade: 'Bar bender', headcount: 4 },
        ],
        equipment: [
          {
            name: 'Concrete mixer',
            ownership: 'own',
            hoursWorked: '7',
            hoursIdle: '1',
            idleReason: 'No power',
          },
        ],
        work: [{ description: 'Brickwork, first floor, grid A-C', qty: '12', unit: 'cum' }],
        hindrances: [
          {
            cause: 'power_water',
            description: 'MSEB shutdown 11-12',
            hours: '1',
            account: 'neutral',
          },
        ],
        safety: 'Toolbox talk on scaffolding',
      },
      c.raju,
    );
    // A tiny real JPEG (1x1, grey).
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      'base64',
    );
    await s.upload(
      `/tenant/daily-reports/${r.id}/photos?caption=${encodeURIComponent('First floor walls')}`,
      c.raju,
      'site.jpg',
      'image/jpeg',
      jpeg,
    );
    paths.push(`/daily-reports/${r.id}`, `/projects/${projectId}/daily-reports`);
    s.note(
      "Today's daily report for the Washim site, with manpower, equipment, a hindrance and a photo",
    );
  });

  // --- stores: cement as a stocked material, received and issued to work ---
  await step(s, 'stores', async () => {
    await s.post(
      `/tenant/projects/${projectId}/wbs`,
      { code: 'SUB', name: 'Substructure' },
      c.suresh,
    );
    await s.post(
      `/tenant/projects/${projectId}/wbs`,
      { code: 'SUP', name: 'Superstructure' },
      c.suresh,
    );
    const cement = await s.post<{ id: string }>(
      '/tenant/resources',
      {
        code: 'CEM',
        name: 'Cement OPC 53',
        kind: 'material',
        unit: 'bag',
        rate: '400',
        effectiveFrom: '2026-01-01',
      },
      c.suresh,
    );
    const store = await s.post<{ id: string }>(
      `/tenant/projects/${projectId}/stores`,
      { siteId: c.site, name: 'Main store' },
      c.suresh,
    );
    const vendors = await s.get<{ id: string; name: string }[]>(
      '/tenant/parties?kind=vendor',
      c.suresh,
    );
    const vct = vendors.find((v) => v.name === 'Vidarbha Cement Traders')!.id;
    const o = await s.post<{ open: { id: string; rowVersion: number } }>(
      `/tenant/projects/${projectId}/orders`,
      {
        kind: 'purchase',
        partyId: vct,
        siteId: c.site,
        lines: [
          {
            resourceId: cement.id,
            description: 'Cement OPC 53',
            unit: 'bag',
            qty: '300',
            rate: '385',
            gstPct: '28',
          },
        ],
      },
      c.suresh,
    );
    const po = await s.post<{ id: string; progress: { lineKey: string; outstanding: string }[] }>(
      `/tenant/order-revisions/${o.open.id}/submit`,
      { rowVersion: o.open.rowVersion },
      c.suresh,
    );
    await s.post(
      `/tenant/orders/${po.id}/receipts`,
      {
        receivedOn: daysAgo(6),
        challanNo: 'VCT/DC/452',
        storeId: store.id,
        lines: po.progress.map((l) => ({ lineKey: l.lineKey, qty: l.outstanding })),
      },
      c.raju,
    );
    await s.post(
      `/tenant/stores/${store.id}/issues`,
      {
        issuedOn: daysAgo(4),
        wbsCode: 'SUB',
        issuedTo: 'Ramesh (mason gang)',
        lines: [{ resourceId: cement.id, qty: '120' }],
      },
      c.raju,
    );
    paths.push(`/stores/${store.id}`);
    s.note('Stores: Main store, 300 bags of cement received, 120 issued to the substructure');
  });

  // --- documents, and a transmittal to ZP (the client acknowledges it on the portal) ---
  await step(s, 'documents and transmittal', async () => {
    const pdf = (title: string) => Buffer.from(`%PDF-1.4\n% ${title}\n%%EOF\n`);
    const a = await s.upload<{ document: { id: string } }>(
      `/tenant/projects/${projectId}/documents/upload`,
      c.suresh,
      'A-101 Ground floor plan.pdf',
      'application/pdf',
      pdf('plan'),
    );
    const b = await s.upload<{ document: { id: string } }>(
      `/tenant/projects/${projectId}/documents/upload`,
      c.suresh,
      'S-201 Footing details.pdf',
      'application/pdf',
      pdf('footings'),
    );
    const t = await s.post<{ id: string }>(
      `/tenant/projects/${projectId}/transmittals`,
      {
        subject: 'Revised drawings for approval',
        recipient: 'Executive Engineer, ZP Washim',
        partyId: c.zp,
        purpose: 'review',
        responseDays: 7,
        items: [{ documentId: a.document.id, copies: 2 }, { documentId: b.document.id }],
      },
      c.suresh,
    );
    await s.post(`/tenant/transmittals/${t.id}/issue`, {}, c.suresh);
    paths.push(`/projects/${projectId}/documents`);
    s.note(
      'Documents: 2 drawings; transmittal TR-001 to ZP Washim for review (answer it on the client portal)',
    );
  });

  // --- people: employees deployed to the site, today's attendance ---
  await step(s, 'HR and attendance', async () => {
    const users = await s.get<{ id: string; username: string }[]>('/tenant/users', c.admin);
    const raju = users.find((u) => u.username === 'raju')!.id;
    const keeper = await s.post<{ id: string }>(
      '/tenant/hr/designations',
      { name: 'Time keeper', permissions: ['hr.view'] },
      c.admin,
    );
    const engineer = await s.post<{ id: string }>(
      '/tenant/hr/designations',
      { name: 'Site engineer' },
      c.admin,
    );
    await s.post(
      '/tenant/hr/calendars',
      { entityId: c.entityId, name: 'Sites', workWeek: 63, isDefault: true },
      c.admin,
    );
    const e1 = await s.post<{ id: string }>(
      '/tenant/hr/employees',
      {
        entityId: c.entityId,
        kind: 'staff',
        joinedOn: '2025-06-01',
        code: 'E001',
        name: 'Raju Wankhede',
        designationId: keeper.id,
        userId: raju,
        pan: 'BKLPW4321M',
      },
      c.admin,
    );
    const e2 = await s.post<{ id: string }>(
      '/tenant/hr/employees',
      {
        entityId: c.entityId,
        kind: 'worker',
        joinedOn: '2026-04-01',
        code: 'E002',
        name: 'Ganesh Pawar',
        designationId: engineer.id,
      },
      c.admin,
    );
    for (const e of [e1.id, e2.id])
      await s.post(
        `/tenant/hr/employees/${e}/deployments`,
        { from: '2026-09-01', projectId, siteId: c.site },
        c.admin,
      );
    await s.post(
      `/tenant/hr/sites/${c.site}/attendance`,
      {
        date: daysAgo(1),
        marks: [
          { employeeId: e1.id, status: 'present', inTime: '09:00', outTime: '18:00' },
          { employeeId: e2.id, status: 'present', inTime: '08:30', outTime: '17:30' },
        ],
      },
      c.raju,
    );
    s.note("People: 2 employees deployed to the Washim site, yesterday's attendance marked");
  });

  // --- real estate: Sai Residency, Akola (MahaRERA) ---
  await step(s, 'real estate', async () => {
    const chart = await s.get<{
      accounts: { id: string; code: string; systemKey: string | null }[];
    }>('/tenant/accounts/chart', c.admin);
    const bankGroup = chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id;
    const bank = async (code: string, name: string) =>
      (
        await s.post<{ accounts: { id: string; code: string }[] }>(
          '/tenant/accounts/chart',
          { parentId: bankGroup, code, name, kind: 'bank' },
          c.admin,
        )
      ).accounts.find((a) => a.code === code)!.id;
    const collection = await bank('A4002', 'HDFC Collection 0012');
    const designated = await bank('A4003', 'HDFC RERA Designated 0013');
    await bank('A4004', 'SBI Operating 7781');
    const p = await s.post<{ id: string }>(
      '/tenant/projects',
      { name: 'Sai Residency, Akola' },
      c.priya,
    );
    const base = `/tenant/projects/${p.id}/sales`;
    await s.post(
      `${base}/setup`,
      {
        reraNumber: 'P52100067890',
        collectionAccountId: collection,
        designatedAccountId: designated,
      },
      c.priya,
    );
    const towers = await s.post<{ towers: { id: string }[] }>(
      `${base}/towers`,
      { name: 'A', floors: 8 },
      c.priya,
    );
    const towerA = towers.towers[0]!.id;
    const units = await s.post<{ units: { id: string; number: string }[] }>(
      `/tenant/sales/towers/${towerA}/units`,
      {
        units: [
          {
            floor: 1,
            number: '101',
            carpetSqm: '62',
            ratePerSqm: '58000',
            parking: '250000',
            charges: '120000',
          },
          { floor: 1, number: '102', carpetSqm: '48', ratePerSqm: '58000' },
          { floor: 2, number: '201', carpetSqm: '62', ratePerSqm: '59000', parking: '250000' },
          { floor: 2, number: '202', carpetSqm: '48', ratePerSqm: '59000' },
        ],
      },
      c.priya,
    );
    await s.post(
      `${base}/plan`,
      {
        stages: [
          { name: 'On booking', pct: '10', trigger: 'booking' },
          { name: 'On agreement', pct: '20', trigger: 'agreement' },
          { name: 'Plinth', pct: '30', trigger: 'milestone', towerId: towerA },
          { name: 'Possession', pct: '40', trigger: 'milestone' },
        ],
      },
      c.priya,
    );
    const u101 = units.units.find((u) => u.number === '101')!.id;
    const booking = await s.post<{ id: string; totals: { due?: string } }>(
      `/tenant/sales/units/${u101}/book`,
      {
        buyer: { name: 'Anil Kulkarni', phone: '9822012345', pan: 'ABCPK1234F' },
        bookedOn: daysAgo(30),
      },
      c.priya,
    );
    await s.post(
      `/tenant/sales/bookings/${booking.id}/receipts`,
      { on: daysAgo(25), amount: '400000', reference: 'UTR-HDFC-0001' },
      c.priya,
    );
    await s.post(
      `/tenant/sales/bookings/${booking.id}/agreement`,
      { on: daysAgo(15), number: 'AKL-1-1234-2026' },
      c.priya,
    );
    s.note(
      'Real estate: Sai Residency, Akola (MahaRERA P52100067890), tower A with 4 flats, flat 101 booked, agreement made',
    );
  });

  return paths;
}
