// A working day on every live site: the labour contractors' gangs sized each week, the muster, the daily report with
// manpower, machines, work and weather, machine log sheets, fortnightly requisitions and purchase orders, deliveries
// into the site store and the supplier's bill, weekly issues of material to the work, quality tests and inspections,
// toolbox talks and the odd incident.
import { type Ctx, type ProjectState, as, bump, step } from './ctx.js';
import { type Labour, isWorkDay, siteTeam } from './people.js';
import { itemDone, workValue } from './projects.js';
import { ANALYSES, BOQ_ITEMS, MACHINES, OFFICE_ASSETS, PARTIES, RESOURCES } from './plan.js';
import { type Day, addDays, diffDays, lastOfMonth, minDay, money, qty4, weekday } from './util.js';

const live = (ps: ProjectState, d: Day) =>
  ps.status === 'active' && d >= ps.plan.start && d <= ps.end;
const author = (c: Ctx, ps: ProjectState, d: Day) => {
  const who = siteTeam(ps.plan.key).find(
    (u) =>
      c.users[u] &&
      !(u === 'sachin' && d > '2025-06-30') &&
      !(u === 'vijay' && d > '2026-05-31') &&
      !(u === 'nikhil' && d < '2025-07-14') &&
      !(u === 'snehal' && d < '2026-01-05'),
  );
  return as(c, who ?? 'suresh');
};
const monsoon = (d: Day) => d.slice(5) >= '06-10' && d.slice(5) <= '09-30';

/** Material a project's work needs between two days, by resource code (from the rate analyses). */
function materialNeed(ps: ProjectState, from: Day, to: Day): Record<string, number> {
  const need: Record<string, number> = {};
  for (const it of ps.items) {
    if (!it.analysis) continue;
    const q = (itemDone(ps, it, to) - itemDone(ps, it, from)) * it.qty;
    if (q <= 0) continue;
    const a = ANALYSES.find((x) => x.code === it.analysis)!;
    for (const l of a.lines) {
      if (l[0] === 'LS') continue;
      const r = RESOURCES.find((x) => x.code === l[0])!;
      if (r.kind !== 'material' || !r.vendor) continue;
      need[l[0]] = (need[l[0]] ?? 0) + (q * l[1]) / a.outputQty;
    }
  }
  return need;
}
const roundUp = (code: string, q: number) => {
  const unit = RESOURCES.find((r) => r.code === code)!.unit;
  if (unit === 'nos') return Math.ceil(q / 500) * 500;
  if (unit === 'bag' || unit === 'kg' || unit === 'ltr') return Math.ceil(q / 10) * 10;
  if (unit === 't') return Math.ceil(q * 10) / 10;
  return Math.ceil(q);
};

export class Site {
  private machineAt: Record<string, string | null> = {};
  private machineId: Record<string, string> = {};
  private reading: Record<string, number> = {};
  private craneId?: string;
  private templates: Record<string, { id: string; items: number }> = {};

  constructor(
    private readonly c: Ctx,
    private readonly labour: Labour,
  ) {}

  /** Machines and office assets bought in the first months, with their bills; checklist templates. */
  scheduleSetup() {
    const c = this.c;
    for (const a of [
      ...OFFICE_ASSETS,
      ...MACHINES.map((m) => ({
        name: m.name,
        cost: m.cost,
        bought: m.bought,
        vendor: m.vendor,
        cls: m.cls,
        machine: m,
      })),
    ]) {
      c.sched.at(a.bought, 30, `asset ${a.name}`, async () => {
        const classes = await c.s.get<{ id: string; name: string; account: { id: string } }[]>(
          '/tenant/accounts/asset-classes',
          c.admin,
        );
        const cls = classes.find((x) => x.name === a.cls)!;
        const bill = await c.s.post<{ id: string; payable: string }>(
          '/tenant/accounts/vendor-bills',
          {
            entityId: c.entityId,
            partyId: c.party[a.vendor],
            orderId: null,
            projectId: null,
            billNo: `INV/${a.bought.slice(2, 4)}/${c.r.int(1000, 9999)}`,
            billDate: a.bought,
            dueDate: addDays(a.bought, 15),
            tdsSection: null,
            narration: `Purchase of ${a.name}`,
            lines: [
              {
                lineKey: null,
                accountId: cls.account.id,
                projectId: null,
                description: a.name,
                unit: 'nos',
                qty: '1',
                rate: money(a.cost),
                gstPct: '18',
              },
            ],
          },
          c.admin,
        );
        const asset = await c.s.post<{ id: string }>(
          '/tenant/accounts/assets',
          {
            entityId: c.entityId,
            name: a.name,
            classId: cls.id,
            source: 'bill',
            vendorBillId: bill.id,
            purchasedOn: a.bought,
            putToUseOn: addDays(a.bought, 2),
            cost: money(a.cost),
            serialNo: `SN-${c.r.int(100000, 999999)}`,
          },
          c.admin,
        );
        bump(c, 'fixed assets');
        const m = (a as { machine?: (typeof MACHINES)[number] }).machine;
        if (m) {
          const e = await c.s.post<{ id: string }>(
            '/tenant/equipment',
            {
              entityId: c.entityId,
              code: m.code,
              name: m.name,
              category: m.category,
              meter: m.meter,
              ownership: 'own',
              assetId: asset.id,
              internalRate: money(m.internalRate),
              operatorBy: 'own',
              fuelBy: 'own',
              fuelNorm: m.fuelNorm,
            },
            c.admin,
          );
          this.machineId[m.code] = e.id;
          this.machineAt[m.code] = null;
          this.reading[m.code] = m.meter === 'km' ? 1200 : 15;
          await step(c, 'maintenance plan', () =>
            c.s.post(
              `/tenant/equipment/${e.id}/maintenance-plans`,
              {
                name: m.meter === 'km' ? 'Service every 10,000 km' : 'Service every 250 hours',
                everyHours: m.meter === 'km' ? '10000' : '250',
                everyDays: 180,
                fromDate: a.bought,
                fromReading: String(this.reading[m.code]),
              },
              c.admin,
            ),
          );
        }
      });
    }
    // A hired hydra crane for the heavy concreting months (from the hostel job on).
    c.sched.at('2025-09-10', 30, 'hired crane', async () => {
      const e = await c.s.post<{ id: string }>(
        '/tenant/equipment',
        {
          entityId: c.entityId,
          code: 'HYD-H1',
          name: 'Hydra crane 14 t (hired)',
          category: 'crane',
          meter: 'hours',
          ownership: 'hired',
          partyId: c.party.crane,
          hireBasis: 'day',
          hireRate: '4500',
          minHours: '0',
          operatorBy: 'hirer',
          fuelBy: 'hirer',
        },
        c.admin,
      );
      this.craneId = e.id;
      this.machineAt['HYD-H1'] = null;
      this.reading['HYD-H1'] = 3400;
    });
    c.sched.at('2024-01-10', 30, 'quality templates', async () => {
      for (const [name, workType, items] of [
        [
          'Pre-concreting checklist',
          'Concrete',
          [
            'Shuttering line, level and plumb checked',
            'Reinforcement as per drawing and cover blocks in place',
            'Embedded conduits and sleeves fixed',
            'Shuttering oiled and joints sealed',
            'Vibrator and standby available',
            'Curing arrangement ready',
          ],
        ],
        [
          'Brick masonry checklist',
          'Masonry',
          [
            'Bricks soaked before use',
            'Mortar mix 1:6 by gauge box',
            'Joints not more than 10 mm',
            'Wall in plumb and courses level',
            'Curing for seven days planned',
          ],
        ],
      ] as const) {
        const t = await c.s.post<{ id: string } | { id: string }[]>(
          '/tenant/quality/checklist-templates',
          {
            name,
            workType,
            items: items.map((text) => ({ text, kind: 'yes_no', required: true })),
          },
          as(c, 'suresh'),
        );
        const id = Array.isArray(t)
          ? t.find((x) => (x as { name?: string }).name === name)?.id
          : t.id;
        if (id) this.templates[name] = { id, items: items.length };
      }
    });
  }

  /** Every day: the morning's planning (Mondays), the muster, machines, the daily report; deliveries and issues. */
  async day(d: Day) {
    const c = this.c;
    const projects = Object.values(c.projects).filter((ps) => live(ps, d));
    if (!isWorkDay(d)) return;
    if (weekday(d) === 1 || !Object.keys(this.labour.present).length) {
      // Gang sizes for the week: about a quarter of the week's work value is labour, at ₹560 a day.
      const need: Record<string, Record<string, number>> = {};
      for (const ps of Object.values(c.projects)) {
        if (!live(ps, d)) continue;
        const value = workValue(ps, d, addDays(d, 7));
        const heads = Math.max(6, Math.round((value * 0.3) / 6 / 560));
        const ks = ps.plan.labour;
        const mepShare = ks.includes('mep') && itemDone(ps, { window: [0.4, 1] }, d) > 0 ? 0.2 : 0;
        for (const k of ks) {
          const n =
            k === 'mep'
              ? Math.round(heads * mepShare)
              : Math.round((heads * (1 - mepShare)) / ks.filter((x) => x !== 'mep').length);
          if (n > 0) (need[k] ??= {})[ps.plan.key] = n;
        }
      }
      await this.labour.plan(d, need);
      for (const ps of projects) await this.procure(ps, d);
    }
    const sites = Object.fromEntries(projects.map((ps) => [ps.plan.key, ps.siteId]));
    await this.labour.muster(d, sites, (pk) => author(c, c.projects[pk]!, d));
    await this.machines(d, projects);
    for (const ps of projects) await this.report(ps, d);
    if (weekday(d) === 6) for (const ps of projects) await this.issue(ps, d);
    if (weekday(d) === 1) for (const ps of projects) await this.toolbox(ps, d);
    if (weekday(d) === 3) for (const ps of projects) await this.quality(ps, d);
  }

  private async machines(d: Day, projects: ProjectState[]) {
    const c = this.c;
    const wants = (code: string): ProjectState | undefined => {
      const busy = (ps: ProjectState, items: string[]) =>
        ps.items.some(
          (i) => items.includes(i.code) && itemDone(ps, i, d) > 0.01 && itemDone(ps, i, d) < 0.995,
        );
      const list = [...projects].sort((a, b) => a.plan.start.localeCompare(b.plan.start));
      if (code === 'JCB-01')
        return list.find((ps) => busy(ps, ['1.1'])) ?? list.find((ps) => busy(ps, ['5.3']));
      if (code === 'MIX-01') return list.find((ps) => busy(ps, ['2.1', '2.2']));
      if (code === 'MIX-02')
        return list
          .filter((ps) => busy(ps, ['2.2', '3.1', '4.1']))
          .find((ps) => this.machineAt['MIX-01'] !== ps.id);
      if (code === 'HYD-H1')
        return list.find(
          (ps) => (ps.plan.key === 'p6' || ps.plan.key === 'p9') && busy(ps, ['2.2']),
        );
      if (code === 'VEH-01') return list[list.length - 1];
      return undefined;
    };
    for (const code of Object.keys(this.machineAt)) {
      const id = code === 'HYD-H1' ? this.craneId : this.machineId[code];
      if (!id) continue;
      const ps = wants(code);
      const target = ps?.id ?? null;
      if (target !== this.machineAt[code]) {
        const ok = await step(c, 'machine allocation', () =>
          c.s.post(
            `/tenant/equipment/${id}/allocate`,
            { date: d, projectId: target, siteId: ps?.siteId ?? null },
            c.admin,
          ),
        );
        if (ok) this.machineAt[code] = target;
      }
      if (!ps || this.machineAt[code] !== ps.id) continue;
      const km = code === 'VEH-01';
      const worked = km ? c.r.int(40, 140) : code === 'HYD-H1' ? c.r.int(4, 8) : c.r.int(5, 8);
      const idle = km ? 0 : c.r.chance(0.15) ? c.r.int(1, 2) : 0;
      const start = this.reading[code]!;
      const end = Math.round((start + worked) * 10) / 10;
      const ok = await step(c, 'machine log', () =>
        c.s.post(
          `/tenant/equipment/${id}/logs`,
          {
            date: d,
            startReading: String(start),
            endReading: String(end),
            worked: null,
            idleHours: String(idle),
            idleReason: idle
              ? c.r.pick(['Waiting for material', 'No front available', 'Operator late'])
              : '',
            breakdownHours: '0',
            operator: km
              ? 'Santosh (driver)'
              : code === 'HYD-H1'
                ? "Hirer's operator"
                : c.r.pick(['Ganesh Sonone', 'Vilas Kharat']),
          },
          author(c, ps, d),
        ),
      );
      if (ok) {
        this.reading[code] = end;
        bump(c, 'machine log sheets');
      }
    }
  }

  private async report(ps: ProjectState, d: Day) {
    const c = this.c;
    const h = author(c, ps, d);
    const made = await step(c, 'daily report', () =>
      c.s.post<{ id: string; rowVersion: number }>(
        `/tenant/projects/${ps.id}/daily-reports`,
        { siteId: ps.siteId, reportDate: d },
        h,
      ),
    );
    if (!made) return;
    const rain = monsoon(d) && c.r.chance(0.35);
    const heavy = rain && c.r.chance(0.25);
    const working = ps.items.filter((i) => {
      const x = itemDone(ps, i, d);
      return x > 0.005 && x < 0.999;
    });
    const tomorrow = addDays(d, 1);
    const work = working.slice(0, 4).map((i) => {
      const plan = BOQ_ITEMS.find((b) => b.code === i.code)!;
      const desc =
        plan.description ??
        ANALYSES.find((a) => a.code === plan.analysis)!.description.split(',')[0]!;
      const q = (itemDone(ps, i, tomorrow) - itemDone(ps, i, d)) * i.qty;
      return {
        boqCode: i.code,
        description: `${desc} (${c.r.pick(['ground floor', 'first floor', 'grid A-C', 'grid C-F', 'east wing', 'west wing', 'staircase block'])})`,
        qty: i.unit === 'LS' ? null : qty4(Math.max(0.1, q)),
        unit: i.unit === 'LS' ? '' : i.unit,
      };
    });
    const manpower = (this.labour.present[ps.plan.key] ?? []).map((m) => ({
      trade: m.trade,
      partyId: m.partyId,
      headcount: m.headcount,
      note: '',
    }));
    manpower.push({
      trade: 'Engineers and supervisors',
      partyId: null as unknown as string,
      headcount: Math.max(1, siteTeam(ps.plan.key).length),
      note: 'Company staff',
    });
    const equipment = Object.entries(this.machineAt)
      .filter(([, at]) => at === ps.id)
      .map(([code]) => ({
        name: MACHINES.find((m) => m.code === code)?.name ?? 'Hydra crane 14 t',
        ownership: code === 'HYD-H1' ? 'hired' : 'own',
        count: 1,
        hoursWorked: String(c.r.int(5, 8)),
        hoursIdle: '0',
        idleReason: '',
      }));
    const hindrances = rain
      ? [
          {
            cause: 'rain',
            description: heavy
              ? 'Heavy rain; concreting and external work stopped'
              : 'Intermittent rain; external work held',
            hours: String(heavy ? c.r.int(4, 7) : c.r.int(1, 3)),
            account: 'neutral',
          },
        ]
      : c.r.chance(0.03)
        ? [
            {
              cause: c.r.pick(['power_water', 'materials', 'drawings'] as const),
              description: c.r.pick([
                'MSEDCL shutdown on the feeder',
                'Sand truck held at the check post',
                'Awaiting revised staircase drawing',
              ]),
              hours: String(c.r.int(1, 3)),
              account: c.r.pick(['neutral', 'client', 'contractor'] as const),
            },
          ]
        : [];
    const updated = await step(c, 'daily report details', () =>
      c.s.post<{ rowVersion: number }>(
        `/tenant/daily-reports/${made.id}`,
        {
          rowVersion: made.rowVersion,
          weatherAm: rain
            ? heavy
              ? 'heavy_rain'
              : 'rain'
            : c.r.pick(['clear', 'clear', 'cloudy']),
          weatherPm: rain ? 'rain' : c.r.pick(['clear', 'cloudy']),
          rainHours: rain ? String(heavy ? c.r.int(4, 7) : c.r.int(1, 3)) : null,
          safety: c.r.pick([
            'PPE checked at the gate',
            'Housekeeping round done',
            'Scaffold tags checked',
            'Toolbox talk held',
            'Barricading at the excavation checked',
          ]),
          visitors: c.r.chance(0.06)
            ? c.r.pick([
                "Client's engineer for inspection",
                'Architect site visit',
                'Third-party quality auditor',
              ])
            : '',
          notes: '',
          manpower: manpower
            .filter((m) => m.headcount > 0)
            .map((m) => ({ ...m, partyId: m.partyId ?? null })),
          equipment,
          work,
          hindrances,
        },
        h,
      ),
    );
    if (!updated) return;
    await step(c, 'daily report submit', () =>
      c.s.post(`/tenant/daily-reports/${made.id}/submit`, { rowVersion: updated.rowVersion }, h),
    );
    if (c.r.chance(0.92) && d < c.today)
      await step(c, 'daily report acknowledge', () =>
        c.s.post(
          `/tenant/daily-reports/${made.id}/acknowledge`,
          { comment: c.r.chance(0.1) ? 'Speed up the plaster gang.' : undefined },
          as(c, 'suresh'),
        ),
      );
    bump(c, 'daily reports');
  }

  /** Fortnightly: a requisition from site and purchase orders to the suppliers; delivered in a few days and billed. */
  private async procure(ps: ProjectState, d: Day) {
    const c = this.c;
    if (diffDays(d, ps.plan.start) % 14 > 6 || !ps.storeId) return;
    const need = materialNeed(ps, d, addDays(d, 18));
    const order: Record<string, number> = {};
    for (const [code, q] of Object.entries(need)) {
      const have = (ps.stock[code] ?? 0) + (ps.onOrder[code] ?? 0);
      const short = q - have;
      if (short > q * 0.15) order[code] = roundUp(code, short);
    }
    if (!Object.keys(order).length) return;
    const site = author(c, ps, d);
    await step(c, 'requisition', async () => {
      const pr = await c.s.post<{ id: string; rowVersion: number }>(
        `/tenant/projects/${ps.id}/requisitions`,
        {
          title: `Materials for the fortnight from ${d}`,
          siteId: ps.siteId,
          neededBy: addDays(d, 4),
          lines: Object.entries(order).map(([code, q]) => ({
            resourceId: c.res[code]!.id,
            qty: qty4(q),
            neededBy: addDays(d, 4),
          })),
        },
        site,
      );
      await c.s.post(`/tenant/requisitions/${pr.id}/submit`, { rowVersion: pr.rowVersion }, site);
      bump(c, 'requisitions');
    });
    const byVendor: Record<string, string[]> = {};
    for (const code of Object.keys(order)) {
      const v = RESOURCES.find((r) => r.code === code)!.vendor!;
      (byVendor[v] ??= []).push(code);
    }
    for (const [v, codes] of Object.entries(byVendor)) {
      const imran = as(c, d >= '2024-02-15' ? 'imran' : 'suresh');
      const o = await step(c, 'purchase order', () =>
        c.s.post<{ id: string; open: { id: string; rowVersion: number } }>(
          `/tenant/projects/${ps.id}/orders`,
          {
            kind: 'purchase',
            partyId: c.party[v],
            siteId: ps.siteId,
            deliverBy: addDays(d, 4),
            paymentTerms: '30 days from delivery',
            deliveryTerms: 'Free delivery at site; unloading by us',
            lines: codes.map((code) => {
              const r = RESOURCES.find((x) => x.code === code)!;
              return {
                resourceId: c.res[code]!.id,
                description: r.name,
                hsn: r.hsn ?? null,
                unit: r.unit,
                qty: qty4(order[code]!),
                rate: qty4(c.res[code]!.rate(d) * c.r.between(0.96, 1.0)),
                gstPct: String(r.gst ?? 18),
              };
            }),
          },
          imran,
        ),
      );
      if (!o) continue;
      const po = await step(c, 'purchase order submit', () =>
        c.s.post<{
          id: string;
          number: string;
          inForce: {
            lines: {
              lineKey: string;
              resourceId: string;
              qty: string;
              rate: string;
              gstPct: string;
            }[];
          };
        }>(`/tenant/order-revisions/${o.open.id}/submit`, { rowVersion: o.open.rowVersion }, imran),
      );
      if (!po) continue;
      bump(c, 'purchase orders');
      for (const code of codes) ps.onOrder[code] = (ps.onOrder[code] ?? 0) + order[code]!;
      const recvOn = minDay(addDays(d, c.r.int(1, 4)), c.today);
      c.sched.at(recvOn, 45, 'goods receipt', async () => {
        const grn = await c.s.post<{ id: string }>(
          `/tenant/orders/${po.id}/receipts`,
          {
            receivedOn: recvOn,
            challanNo: `DC/${v.toUpperCase().slice(0, 4)}/${c.r.int(1000, 9999)}`,
            challanDate: recvOn,
            vehicleNo: `MH37 ${String.fromCharCode(65 + c.r.int(0, 25))} ${c.r.int(1000, 9999)}`,
            storeId: ps.storeId,
            lines: po.inForce.lines.map((l) => ({ lineKey: l.lineKey, qty: l.qty, rejected: '0' })),
          },
          author(c, ps, recvOn),
        );
        bump(c, 'goods receipts');
        for (const l of po.inForce.lines) {
          const code = Object.entries(c.res).find(([, r]) => r.id === l.resourceId)?.[0];
          if (!code) continue;
          ps.onOrder[code] = Math.max(0, (ps.onOrder[code] ?? 0) - Number(l.qty));
          ps.stock[code] = (ps.stock[code] ?? 0) + Number(l.qty);
        }
        void grn;
        const billOn = minDay(addDays(recvOn, c.r.int(0, 3)), c.today);
        c.sched.at(billOn, 46, 'supplier bill', async () => {
          const bill = await c.s.post<{ id: string; payable: string; status: string }>(
            '/tenant/accounts/vendor-bills',
            {
              entityId: c.entityId,
              partyId: c.party[v],
              orderId: po.id,
              projectId: ps.id,
              billNo: `${v.toUpperCase().slice(0, 3)}/${billOn.slice(2, 4)}-${10000 + (c.counts['supplier bills'] ?? 0)}`,
              billDate: billOn,
              dueDate: addDays(billOn, 30),
              tdsSection: null,
              narration: `Against ${po.number}`,
              lines: po.inForce.lines.map((l) => ({
                lineKey: l.lineKey,
                accountId: null,
                projectId: ps.id,
                description: '',
                unit: null,
                qty: l.qty,
                rate: l.rate,
                gstPct: l.gstPct,
              })),
            },
            as(c, billOn >= '2024-01-16' ? 'kavita' : 'suresh'),
          );
          bump(c, 'supplier bills');
          void bill;
        });
      });
    }
  }

  /** Saturdays: what the week's work used goes out of the store to its WBS element. */
  private async issue(ps: ProjectState, d: Day) {
    const c = this.c;
    if (!ps.storeId) return;
    const used = materialNeed(ps, addDays(d, -6), addDays(d, 1));
    const bySection: Record<string, { resourceId: string; qty: string; code: string }[]> = {};
    for (const [code, q] of Object.entries(used)) {
      const take = Math.min(q, ps.stock[code] ?? 0);
      if (take < 0.01) continue;
      // The section that used most of it.
      const section =
        ps.items
          .filter(
            (i) =>
              i.analysis &&
              ANALYSES.find((a) => a.code === i.analysis)!.lines.some((l) => l[0] === code),
          )
          .map((i) => ({
            s: BOQ_ITEMS.find((b) => b.code === i.code)!.section,
            v: itemDone(ps, i, addDays(d, 1)) - itemDone(ps, i, addDays(d, -6)),
          }))
          .sort((a, b) => b.v - a.v)[0]?.s ?? '2';
      (bySection[section] ??= []).push({
        resourceId: c.res[code]!.id,
        qty: qty4(Math.floor(take * 100) / 100),
        code,
      });
    }
    for (const [section, lines] of Object.entries(bySection)) {
      const ok = await step(c, 'store issue', () =>
        c.s.post(
          `/tenant/stores/${ps.storeId}/issues`,
          {
            issuedOn: d,
            wbsCode: ps.wbs[section] ?? section,
            issuedTo: `${c.r.pick(['Kale', 'Shaikh'])} gang (${c.r.pick(['masons', 'RCC', 'finishing'])})`,
            purpose: "Week's consumption",
            lines: lines.map(({ code: _c, ...l }) => l),
          },
          author(c, ps, d),
        ),
      );
      if (!ok) continue;
      bump(c, 'store issues');
      for (const l of lines) ps.stock[l.code] = (ps.stock[l.code] ?? 0) - Number(l.qty);
    }
  }

  private async toolbox(ps: ProjectState, d: Day) {
    const c = this.c;
    const topics = [
      'Working at height and harness use',
      'Excavation safety and barricading',
      'Safe handling of cement bags',
      'Electrical safety on site',
      'PPE: helmets, shoes and gloves',
      'Housekeeping and nail hazards',
      'Scaffold erection and inspection',
      'Concrete pump and vibrator safety',
      'First aid and emergency numbers',
      'Heat stress: water and rest breaks',
      'Monsoon: slips, falls and lightning',
    ];
    const speaker =
      d >= '2025-03-17'
        ? 'Rahul Ingole'
        : d >= '2024-06-01' && d <= '2025-02-28'
          ? 'Ganesh Pawar'
          : 'Site engineer';
    await step(c, 'toolbox talk', () =>
      c.s.post(
        `/tenant/projects/${ps.id}/toolbox-talks`,
        {
          siteId: ps.siteId,
          heldOn: d,
          topic: c.r.pick(topics),
          speaker,
          employeeIds: [],
          workerIds: [],
          others: (this.labour.present[ps.plan.key] ?? []).reduce((n, m) => n + m.headcount, 0),
        },
        author(c, ps, d),
      ),
    );
    bump(c, 'toolbox talks');
  }

  /** Wednesdays: concrete cubes and slump while the frame is being cast; an inspection of the month's work. */
  private async quality(ps: ProjectState, d: Day) {
    const c = this.c;
    const rcc = ps.items.find((i) => i.code === '2.2');
    if (!rcc) return;
    const x = itemDone(ps, rcc, d);
    const qa = as(c, d >= '2025-03-17' ? 'rahul' : 'suresh');
    if (x > 0.02 && x < 0.995) {
      const sampled = addDays(d, -28);
      if (sampled >= ps.plan.start) {
        const fail = c.r.chance(0.04);
        const base = fail ? 27 : 31 + c.r.next() * 5;
        const ref = `CUBE/${ps.plan.key.toUpperCase()}/${sampled.replaceAll('-', '')}`;
        await step(c, 'cube test', () =>
          c.s.post(
            `/tenant/projects/${ps.id}/tests`,
            {
              kind: 'cube',
              sampleRef: ref,
              location: c.r.pick([
                'Slab, first floor',
                'Columns, ground floor',
                'Beams, grid B',
                'Roof slab',
                'Staircase',
              ]),
              sampledOn: sampled,
              testedOn: d,
              spec: { grade: 'M25' },
              results: {
                age: 28,
                cubes: [base, base + c.r.next() * 1.5, base - c.r.next() * 1.2].map(
                  (v) => Math.round(v * 10) / 10,
                ),
              },
            },
            qa,
          ),
        );
        await step(c, 'slump test', () =>
          c.s.post(
            `/tenant/projects/${ps.id}/tests`,
            {
              kind: 'slump',
              sampleRef: ref,
              location: 'Pour at site',
              sampledOn: d,
              testedOn: d,
              spec: { slump: 100 },
              results: { slump: c.r.int(85, 115) },
            },
            qa,
          ),
        );
        bump(c, 'quality tests', 2);
      }
      const tpl = this.templates['Pre-concreting checklist'];
      if (tpl)
        await step(c, 'checklist', () =>
          c.s.post(
            `/tenant/projects/${ps.id}/checklists`,
            {
              templateId: tpl.id,
              siteId: ps.siteId,
              doneOn: d,
              location: c.r.pick(['Slab, first floor', 'Roof slab', 'Lintel beams']),
              answers: Array.from({ length: tpl.items }, () => ({ answer: 'yes' })),
            },
            author(c, ps, d),
          ),
        );
    }
    // The first Wednesday after a month's measurement: the client's engineer inspects the frame work.
    if (Number(d.slice(8)) <= 7 && rcc.measured > 0) {
      const ok = await step(
        c,
        'inspection',
        async () => {
          const ir = await c.s.post<{ id: string }>(
            `/tenant/projects/${ps.id}/inspections`,
            {
              lineKey: rcc.lineKey,
              siteId: ps.siteId,
              location: 'Frame work measured last month',
              activity: 'RCC frame: columns, beams and slab',
              requestedFor: d,
            },
            author(c, ps, d),
          );
          const reject = c.r.chance(0.05);
          await c.s.post(
            `/tenant/inspections/${ir.id}/decide`,
            {
              status: reject ? 'rejected' : c.r.chance(0.2) ? 'approved_with_comments' : 'approved',
              inspector: 'Deputy Engineer (client)',
              comments: reject
                ? 'Honeycombing at the beam soffits; repair and re-offer.'
                : 'Cover and finish acceptable.',
              decidedOn: addDays(d, 1),
            },
            qa,
          );
          return true;
        },
        /nothing_to_inspect/,
      );
      if (ok) bump(c, 'inspections');
    }
  }
}

/** A payment run for the given bills: made, approved and paid the same day from the current account. */
export async function payBills(
  c: Ctx,
  d: Day,
  lines: { partyId: string; billId: string; amount: number }[],
) {
  const h = as(c, d >= '2024-01-16' ? 'kavita' : 'suresh');
  const real = lines.filter((l) => l.amount > 0.5);
  if (!real.length) return;
  for (let i = 0; i < real.length; i += 400) {
    const run = await c.s.post<{ id: string }>(
      '/tenant/accounts/payment-runs',
      {
        entityId: c.entityId,
        bankAccountId: c.bank,
        payOn: d,
        lines: real.slice(i, i + 400).map((l) => ({
          partyId: l.partyId,
          kind: 'bill',
          billId: l.billId,
          projectId: null,
          amount: money(l.amount),
        })),
      },
      h,
    );
    await c.s.post(`/tenant/accounts/payment-runs/${run.id}/submit`, {}, h);
    await c.s.post(`/tenant/accounts/payment-runs/${run.id}/paid`, { paidOn: d }, h);
    bump(c, 'payment runs');
  }
}

/** On the 10th and the 25th: everything due within a week is paid. */
export async function paySuppliers(c: Ctx, d: Day) {
  const lines: { partyId: string; billId: string; amount: number }[] = [];
  for (const p of PARTIES.filter((x) => x.kind === 'vendor' || x.kind === 'subcontractor')) {
    const partyId = c.party[p.key]!;
    const bills = await c.s.get<
      { id: string; dueDate: string; outstanding: string; status: string }[]
    >(
      `/tenant/accounts/vendor-bills?entityId=${c.entityId}&partyId=${partyId}&status=posted`,
      c.admin,
    );
    for (const b of bills)
      if (Number(b.outstanding) > 0 && b.dueDate <= addDays(d, 7))
        lines.push({ partyId, billId: b.id, amount: Number(b.outstanding) });
  }
  await payBills(c, d, lines);
}

export { lastOfMonth };
