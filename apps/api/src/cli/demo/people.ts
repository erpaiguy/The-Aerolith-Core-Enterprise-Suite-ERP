// Staff and labour over time: joining, salaries and April raises, deployments to sites, leave, the month's punches,
// payroll and statutory dues, people leaving with their settlement; and the labour contractors' workers, hired as
// the sites need them, marked on the daily muster and paid through monthly wage sheets.
import { type Ctx, type H, as, bump, step } from './ctx.js';
import { FIRST_NAMES, HOLIDAYS, LABOUR_CONTRACTORS, LAST_NAMES, PROJECTS, STAFF } from './plan.js';
import {
  type Day,
  addDays,
  addMonths,
  days,
  diffDays,
  firstOfMonth,
  lastOfMonth,
  maxDay,
  money,
  weekday,
} from './util.js';

const HOLIDAY = new Set(HOLIDAYS.map(([d]) => d));
export const isWorkDay = (d: Day) => weekday(d) !== 0 && !HOLIDAY.has(d);

/** Who keeps HR on a day: Pooja from when she joined, the admin before. */
const hr = (c: Ctx, d: Day): H => (d >= '2024-04-16' ? as(c, 'pooja') : c.admin);
const accounts = (c: Ctx, d: Day): H => (d >= '2024-01-16' ? as(c, 'kavita') : c.admin);

/** Site staff on each project, in the order they arrive. */
const SITE_TEAM: Record<string, string[]> = {
  p1: ['raju', 'meena', 'vijay'],
  p2: ['sachin'],
  p3: ['raju', 'meena', 'vijay'],
  p4: ['sachin', 'nikhil'],
  p5: ['nikhil'],
  p6: ['raju', 'meena', 'vijay'],
  p7: ['snehal', 'meena'],
  p8: ['nikhil'],
  p9: ['raju', 'meena'],
  p10: ['snehal'],
};
export const siteTeam = (key: string) => SITE_TEAM[key] ?? [];

interface Leave {
  from: Day;
  to: Day;
  type: string;
}

export async function schedulePeople(c: Ctx, designations: Record<string, string>) {
  const comps = await c.s.get<{ id: string; code: string }[]>('/tenant/payroll/components', c.admin);
  const comp = Object.fromEntries(comps.map((x) => [x.code, x.id]));
  const leaveTypes = await c.s.get<{ id: string; code: string }[]>('/tenant/hr/leave-types', c.admin);
  const leaveType = Object.fromEntries(leaveTypes.map((x) => [x.code, x.id]));
  const leaves: Record<string, Leave[]> = {};
  const salaryOf: Record<string, number> = {};

  const salary = async (code: string, from: Day, gross: number) => {
    const basic = Math.round(gross * 0.5);
    const hra = Math.round(basic * 0.4);
    const conv = 1600;
    await c.s.post(
      `/tenant/payroll/employees/${c.emp[code]!.id}/salary`,
      {
        from,
        pfMode: 'ceiling',
        esi: true,
        regime: 'new',
        lines: [
          { componentId: comp.BASIC, amount: money(basic), percentOfBasic: null },
          { componentId: comp.HRA, amount: null, percentOfBasic: '40' },
          { componentId: comp.CONV, amount: money(conv), percentOfBasic: null },
          { componentId: comp.SPECIAL, amount: money(gross - basic - hra - conv), percentOfBasic: null },
        ],
      },
      hr(c, from),
    );
    salaryOf[code] = gross;
  };

  // --- joining, raises, leaving ---
  for (const p of STAFF) {
    c.sched.at(p.joinedOn, 10, `join ${p.code}`, async () => {
      const e = await c.s.post<{ id: string; rowVersion: number }>(
        '/tenant/hr/employees',
        {
          entityId: c.entityId,
          code: p.code,
          name: p.name,
          kind: 'staff',
          gender: p.gender,
          birthDate: p.birthDate,
          joinedOn: p.joinedOn,
          designationId: designations[p.designation],
          department: p.department,
          grade: p.role === 'manager' ? 'M1' : 'S1',
          userId: c.users[p.username]!.id,
          pan: p.pan,
          phone: `98220${p.code.slice(-3)}${p.code.slice(-2)}`,
          email: `${p.username}@deshmukh-infra.demo`,
          bankAccount: `5010${p.pan.slice(5, 9)}${p.code.slice(-3)}12`,
          bankIfsc: 'HDFC0001234',
          bankName: 'HDFC Bank, Washim',
        },
        hr(c, p.joinedOn),
      );
      c.emp[p.code] = { id: e.id, rowVersion: e.rowVersion, userId: c.users[p.username]!.id };
      await salary(p.code, p.joinedOn, p.gross);
      bump(c, 'staff joined');
    });
    // A raise every April for those a year or more in.
    for (let y = 2025; `${y}-04-01` <= c.today; y++) {
      const d = `${y}-04-01` as Day;
      if (d <= p.joinedOn || (p.left && p.left.on < d)) continue;
      c.sched.at(d, 6, `raise ${p.code}`, async () => {
        if (!c.emp[p.code]) return;
        await salary(p.code, d, Math.round(((salaryOf[p.code] ?? p.gross) * 1.08) / 100) * 100);
      });
    }
    if (p.left) {
      const left = p.left;
      // The exit date is entered at the start of the last month; the settlement after its payroll.
      c.sched.at(firstOfMonth(left.on), 9, `exit ${p.code}`, async () => {
        const e = c.emp[p.code]!;
        const r = await c.s.put<{ rowVersion: number }>(
          `/tenant/hr/employees/${e.id}`,
          { leftOn: left.on, rowVersion: e.rowVersion },
          hr(c, left.on),
        );
        e.rowVersion = r.rowVersion;
      });
      const settleOn = addDays(left.on, 6);
      c.sched.at(settleOn, 40, `settlement ${p.code}`, async () => {
        const e = c.emp[p.code]!;
        const st = await c.s.post<{ total: string }>(
          `/tenant/payroll/employees/${e.id}/settlement`,
          { reason: left.reason, noticeDays: left.noticeDays, leaveTypeCode: 'EL' },
          hr(c, settleOn),
        );
        if (Number(st.total) <= 0) return;
        await c.s.post(`/tenant/payroll/employees/${e.id}/settlement/post`, {}, hr(c, settleOn));
        await c.s.post(
          '/tenant/accounts/vouchers',
          {
            entityId: c.entityId,
            type: 'payment',
            date: addDays(settleOn, 2),
            narration: `Full and final settlement: ${p.name} (${left.reason})`,
            reference: `F&F/${p.code}`,
            lines: [
              { accountId: c.acc.salaries_payable, debit: st.total },
              { accountId: c.bank, credit: st.total },
            ],
          },
          accounts(c, settleOn),
        );
      });
    }
  }

  // --- deployments: site staff follow their projects; between projects they are at the head office ---
  const moves: { on: Day; who: string; key: string | null }[] = [];
  for (const pp of PROJECTS)
    for (const who of SITE_TEAM[pp.key] ?? []) {
      const sp = STAFF.find((x) => x.username === who)!;
      const from = maxDay(pp.start, sp.joinedOn);
      if (sp.left && sp.left.on < from) continue;
      moves.push({ on: from, who, key: pp.key });
    }
  for (const pp of PROJECTS)
    if (pp.finished)
      for (const who of SITE_TEAM[pp.key] ?? []) {
        // Back to the office unless already moved to a later project.
        const later = moves.some((m) => m.who === who && m.on > pp.start && m.key !== pp.key && m.on <= addDays(pp.finished!, 1));
        if (!later) moves.push({ on: addDays(pp.finished!, 1), who, key: null });
      }
  moves.sort((a, b) => a.on.localeCompare(b.on));
  const lastMove: Record<string, Day> = {};
  for (const m of moves) {
    const sp = STAFF.find((x) => x.username === m.who)!;
    if (sp.left && m.on > sp.left.on) continue;
    if (m.on > c.today) continue;
    if (lastMove[m.who] === m.on) continue;
    lastMove[m.who] = m.on;
    c.sched.at(m.on, 12, `deploy ${sp.code}`, async () => {
      const ps = m.key ? c.projects[m.key] : null;
      if (m.key && !ps) return;
      await c.s.post(
        `/tenant/hr/employees/${c.emp[sp.code]!.id}/deployments`,
        { from: m.on, projectId: ps?.id ?? null, siteId: ps?.siteId ?? null },
        hr(c, m.on),
      );
    });
  }

  // --- each month: leave, punches, payroll, dues ---
  for (let m = '2024-01-01'; m <= c.today; m = addMonths(m, 1)) {
    const month = m.slice(0, 7);
    const end = lastOfMonth(m);
    const until = end < c.today ? end : addDays(c.today, -1);
    // Leave taken this month, applied before the punches are read.
    c.sched.at(until, 80, `leave ${month}`, async () => {
      for (const p of STAFF) {
        if (!c.emp[p.code] || (p.left && p.left.on < m)) continue;
        if (!c.r.chance(0.3)) continue;
        const year = m.slice(0, 4);
        const taken = (leaves[p.code] ?? []).filter((l) => l.from.startsWith(year));
        const type = c.r.chance(0.6) ? 'CL' : 'SL';
        const used = taken.filter((l) => l.type === type).reduce((n, l) => n + diffDays(l.to, l.from) + 1, 0);
        if (used >= (type === 'CL' ? 6 : 5)) continue;
        let from = addDays(m, c.r.int(2, 24));
        while (!isWorkDay(from)) from = addDays(from, 1);
        const to = c.r.chance(0.3) && isWorkDay(addDays(from, 1)) ? addDays(from, 1) : from;
        if (to > until || from < maxDay(m, p.joinedOn) || (p.left && to > p.left.on)) continue;
        const ok = await step(c, 'leave', () =>
          c.s.post(
            '/tenant/hr/leave',
            {
              employeeId: c.emp[p.code]!.id,
              leaveTypeId: leaveType[type],
              from,
              to,
              halfDay: false,
              reason: type === 'CL' ? c.r.pick(['Family function', 'Personal work', 'Travel to native place', 'Bank and documents work']) : c.r.pick(['Fever', 'Viral infection', 'Doctor visit', 'Back pain']),
            },
            hr(c, until),
          ),
        );
        if (ok) (leaves[p.code] ??= []).push({ from, to, type });
      }
    });
    // The month's punches from the biometric machines, read in one file.
    c.sched.at(until, 90, `punches ${month}`, async () => {
      const rows = ['Employee Code,Date,Time'];
      for (const p of STAFF) {
        if (!c.emp[p.code]) continue;
        for (const d of days(maxDay(m, p.joinedOn), until)) {
          if (!isWorkDay(d) || (p.left && d > p.left.on)) continue;
          if ((leaves[p.code] ?? []).some((l) => d >= l.from && d <= l.to)) continue;
          if (c.r.chance(0.015)) continue; // absent without leave
          const inM = 9 * 60 - 10 + c.r.int(0, 30);
          const outM = 18 * 60 - 15 + c.r.int(0, 60);
          const t = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
          rows.push(`${p.code},${d},${t(inM)}`, `${p.code},${d},${t(outM)}`);
        }
      }
      if (rows.length === 1) return;
      await c.s.upload(
        `/tenant/hr/attendance/import?entityId=${c.entityId}`,
        hr(c, until),
        `punches-${month}.csv`,
        'text/csv',
        Buffer.from(rows.join('\n')),
      );
    });
    if (end >= c.today) continue; // the month is not over: no payroll yet
    const runOn = addDays(end, 1);
    c.sched.at(runOn, 20, `payroll ${month}`, async () => {
      const h = hr(c, runOn);
      const run = await c.s.post<{ id: string }>('/tenant/payroll/runs', { entityId: c.entityId, month }, h);
      await c.s.post(`/tenant/payroll/runs/${run.id}/submit`, {}, h);
      await c.s.post(`/tenant/payroll/runs/${run.id}/post`, {}, h);
      await c.s.post(
        `/tenant/payroll/runs/${run.id}/pay`,
        { bankAccountId: c.bank, date: addDays(end, 2) },
        h,
      );
      bump(c, 'payroll runs');
    });
    // PF, ESI, PT, LWF and salary TDS for the month, paid by the 15th.
    const dueOn = addDays(end, 15);
    if (dueOn <= c.today)
      c.sched.at(dueOn, 30, `statutory dues ${month}`, async () => {
        const lines: { accountId: string; debit?: string; credit?: string }[] = [];
        let total = 0;
        for (const key of ['pf_payable', 'esi_payable', 'pt_payable', 'lwf_payable', 'tds_payable_salary']) {
          const owed = -(await balance(c, c.acc[key]!, end));
          if (owed > 0.5) {
            lines.push({ accountId: c.acc[key]!, debit: money(owed) });
            total += owed;
          }
        }
        if (!lines.length) return;
        lines.push({ accountId: c.bank, credit: money(total) });
        await c.s.post(
          '/tenant/accounts/vouchers',
          {
            entityId: c.entityId,
            type: 'payment',
            date: dueOn,
            narration: `PF, ESI, professional tax, LWF and salary TDS for ${month}`,
            reference: `STAT/${month}`,
            lines,
          },
          accounts(c, dueOn),
        );
      });
  }
}

/** A ledger's balance (debit positive) at the end of a day. */
export async function balance(c: Ctx, accountId: string, asOf: Day): Promise<number> {
  const l = await c.s.get<{ closing: string }>(
    `/tenant/accounts/ledgers/${accountId}?entityId=${c.entityId}&from=${asOf}&to=${asOf}`,
    c.admin,
  );
  return Number(l.closing);
}

// ---------------------------------------------------------------------------------------------------------------------
// Labour

interface Worker {
  id: string;
  name: string;
  trade: string;
  skill: string;
  wage: number;
  rowVersion: number;
  joinedOn: Day;
  /** Project key the worker is on, or null when between jobs. */
  on: string | null;
  idleSince: Day | null;
}

export class Labour {
  readonly workers: Record<string, Worker[]> = { kale: [], shaikh: [], mep: [] };
  private names = new Set<string>();
  hired: Record<string, number> = { kale: 0, shaikh: 0, mep: 0 };
  /** Musters marked per (contractor, site, month), for the wage sheets. */
  readonly musters = new Set<string>();
  /** Today's present headcount by project and trade, for the daily report. */
  readonly present: Record<string, { trade: string; partyId: string; headcount: number }[]> = {};

  constructor(private readonly c: Ctx) {}

  private newName(): string {
    for (;;) {
      const n = `${this.c.r.pick(FIRST_NAMES)} ${this.c.r.pick(LAST_NAMES)}`;
      if (!this.names.has(n)) {
        this.names.add(n);
        return n;
      }
    }
  }

  private async hire(k: string, d: Day): Promise<Worker | null> {
    const plan = LABOUR_CONTRACTORS[k]!;
    if (this.hired[k]! >= plan.workers) return null;
    const roll = this.c.r.next();
    const mix = k === 'mep' ? [0.45, 0.35, 0.2] : [0.3, 0.5, 0.1, 0.1];
    let acc = 0;
    let i = 0;
    for (; i < mix.length - 1; i++) {
      acc += mix[i]!;
      if (roll < acc) break;
    }
    const [trade, skill, wage] = plan.trades[i]!;
    const name = this.newName();
    const female = trade === 'Helper' && this.c.r.chance(0.25);
    const list = await this.c.s.post<{ id: string; name: string; rowVersion: number }[]>(
      `/tenant/labour/contractors/${this.c.party[k]}/workers`,
      {
        name,
        relative: `${female ? 'W/o' : 'S/o'} ${this.c.r.pick(FIRST_NAMES.slice(0, 40))} ${name.split(' ')[1]}`,
        gender: female ? 'female' : 'male',
        birthDate: `${this.c.r.int(1972, 2004)}-0${this.c.r.int(1, 9)}-1${this.c.r.int(0, 9)}`,
        trade,
        skill,
        dailyWage: money(wage),
        joinedOn: d,
      },
      as(this.c, d >= '2024-04-16' ? 'pooja' : 'suresh'),
    );
    const w = list.find((x) => x.name === name)!;
    this.hired[k]!++;
    bump(this.c, 'workers hired');
    const worker: Worker = { id: w.id, name, trade, skill, wage, rowVersion: w.rowVersion, joinedOn: d, on: null, idleSince: d };
    this.workers[k]!.push(worker);
    return worker;
  }

  private async leave(k: string, w: Worker, d: Day) {
    const list = await this.c.s.put<{ id: string; rowVersion: number }[]>(
      `/tenant/labour/workers/${w.id}`,
      { leftOn: d, rowVersion: w.rowVersion },
      as(this.c, d >= '2024-04-16' ? 'pooja' : 'suresh'),
    );
    void list;
    this.workers[k] = this.workers[k]!.filter((x) => x !== w);
    bump(this.c, 'workers left');
  }

  /** Each Monday: size every gang to the coming week's work, hire or release, and let some go. */
  async plan(d: Day, need: Record<string, Record<string, number>>) {
    for (const k of Object.keys(this.workers)) {
      const ws = this.workers[k]!;
      // Some leave on their own every week.
      for (const w of [...ws])
        if (w.on && this.c.r.chance(0.011)) await step(this.c, 'worker leaves', () => this.leave(k, w, addDays(d, -1)));
      // Released gangs that waited three weeks for work go home.
      for (const w of [...this.workers[k]!])
        if (!w.on && w.idleSince && diffDays(d, w.idleSince) > 21) await step(this.c, 'worker leaves', () => this.leave(k, w, addDays(d, -1)));
      const byProject = need[k] ?? {};
      // Release those on finished or over-staffed projects.
      for (const w of this.workers[k]!) {
        if (!w.on) continue;
        const want = byProject[w.on] ?? 0;
        const have = this.workers[k]!.filter((x) => x.on === w.on).length;
        if (have > want) {
          w.on = null;
          w.idleSince = d;
        }
      }
      for (const [pk, want] of Object.entries(byProject)) {
        let have = this.workers[k]!.filter((x) => x.on === pk).length;
        for (const w of this.workers[k]!) {
          if (have >= want) break;
          if (!w.on) {
            w.on = pk;
            w.idleSince = null;
            have++;
          }
        }
        while (have < want) {
          const w = await step(this.c, 'hire worker', () => this.hire(k, d));
          if (!w) break;
          w.on = pk;
          w.idleSince = null;
          have++;
        }
      }
    }
  }

  /** The day's muster at each site, per contractor. */
  async muster(d: Day, sites: Record<string, string>, author: (pk: string) => H) {
    for (const pk of Object.keys(this.present)) delete this.present[pk];
    for (const [k, ws] of Object.entries(this.workers)) {
      const byProject: Record<string, Worker[]> = {};
      for (const w of ws) if (w.on && w.joinedOn <= d) (byProject[w.on] ??= []).push(w);
      for (const [pk, list] of Object.entries(byProject)) {
        const siteId = sites[pk];
        if (!siteId) continue;
        const marks = list.map((w) => {
          const roll = this.c.r.next();
          const status = roll < 0.88 ? 'present' : roll < 0.92 ? 'half_day' : 'absent';
          const ot = status === 'present' && this.c.r.chance(0.08) ? String(this.c.r.int(1, 3)) : '0';
          return { workerId: w.id, status, overtimeHours: ot, trade: w.trade };
        });
        const ok = await step(this.c, 'muster', () =>
          this.c.s.post(
            `/tenant/labour/sites/${siteId}/muster`,
            { date: d, partyId: this.c.party[k], marks: marks.map(({ trade: _t, ...m }) => m) },
            author(pk),
          ),
        );
        if (!ok) continue;
        bump(this.c, 'muster marks', marks.length);
        this.musters.add(`${k}|${pk}|${d.slice(0, 7)}`);
        const byTrade: Record<string, number> = {};
        for (const m of marks) if (m.status !== 'absent') byTrade[m.trade] = (byTrade[m.trade] ?? 0) + 1;
        for (const [trade, headcount] of Object.entries(byTrade))
          (this.present[pk] ??= []).push({ trade, partyId: this.c.party[k]!, headcount });
      }
    }
  }

  /** After a month: a wage sheet per contractor and site, passed, and verified paid on the 7th. */
  async wageSheets(month: string) {
    const passOn = addDays(lastOfMonth(`${month}-01`), 2);
    for (const key of [...this.musters].filter((x) => x.endsWith(`|${month}`))) {
      const [k, pk] = key.split('|') as [string, string];
      const ps = this.c.projects[pk];
      if (!ps) continue;
      const h = as(this.c, passOn >= '2024-04-16' ? 'pooja' : 'suresh');
      const sheet = await step(this.c, 'wage sheet', () =>
        this.c.s.post<{ id: string; total: string }>(
          '/tenant/labour/wage-sheets',
          { partyId: this.c.party[k], siteId: ps.siteId, month },
          h,
        ),
      );
      if (!sheet) continue;
      await step(this.c, 'wage sheet pass', () =>
        this.c.s.post(`/tenant/labour/wage-sheets/${sheet.id}/pass`, {}, h),
      );
      const paidOn = addDays(passOn, 5);
      if (paidOn <= this.c.today)
        this.c.sched.at(paidOn, 30, 'wage sheet verify', () =>
          this.c.s.post(
            `/tenant/labour/wage-sheets/${sheet.id}/verify`,
            { paidOn: addDays(paidOn, -1), reference: `${k.toUpperCase()}/WAGES/${month}`, mode: 'bank' },
            h,
          ),
        );
      bump(this.c, 'wage sheets');
    }
  }
}
