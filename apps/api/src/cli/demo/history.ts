// Replays the demo company's history day by day, from January 2024 to today, through the API's own routes on a
// simulated clock (clock.ts). Each day: the morning's scheduled work, the sites' day, then the evening's; the
// schedule is filled by the parts (setup, people, projects, site, money, extras) and grows as things happen.
import type { Sql } from 'postgres';
import type { Seeder } from '../demo-seed.js';
import { installClock, realNow, setClock } from './clock.js';
import { type Ctx, type H, Scheduler, on, step } from './ctx.js';
import { scheduleCompany, scheduleRealEstate } from './extras.js';
import { scheduleCompanyRegisters } from './registers.js';
import { fixHistory } from './fixups.js';
import { scheduleMoney } from './money.js';
import { Labour, schedulePeople } from './people.js';
import { scheduleTenders } from './projects.js';
import { Site } from './site.js';
import { makeUsers, setupCompany, setupPeople, setupRates } from './setup.js';
import { type Day, addDays, addMonths, days, lastOfMonth, rng, rupees, toDay } from './util.js';

export interface HistoryResult {
  c: Ctx;
  labour: Labour;
}

export async function seedHistory(
  s: Seeder,
  db: Sql,
  ctx: { admin: H; entitlement: string; tenantId: string },
): Promise<HistoryResult> {
  const today = toDay(Date.now());
  const until = (process.env.DEMO_UNTIL as Day | undefined) ?? today;
  const c: Ctx = {
    s,
    db,
    r: rng(20240102),
    admin: ctx.admin,
    users: {},
    entityId: '',
    today: until < today ? until : today,
    bank: '',
    acc: {},
    party: {},
    res: {},
    ana: {},
    projects: {},
    emp: {},
    sched: new Scheduler(),
    failures: new Map(),
    paths: [],
    costCodes: {},
    counts: {},
    stamps: s.stamps,
  };
  await makeUsers(c, ctx.entitlement);
  installClock();
  process.stdout.write('Setting up the company (January 2024)...\n');
  await setupCompany(c);
  await setupRates(c);
  const designations = await setupPeople(c);
  await schedulePeople(c, designations);
  const labour = new Labour(c);
  const site = new Site(c, labour);
  site.scheduleSetup();
  scheduleTenders(c);
  scheduleMoney(c);
  scheduleRealEstate(c);
  scheduleCompany(c);
  scheduleCompanyRegisters(c);
  for (let m = '2024-02-01'; m <= c.today; m = addMonths(m, 1)) {
    const prev = addMonths(m, -1).slice(0, 7);
    const d = addDays(m, 1);
    if (d <= c.today) c.sched.at(d, 40, 'wage sheets', () => labour.wageSheets(prev));
  }

  const started = realNow();
  const run = async (d: Day, upto: number) => {
    for (;;) {
      const list = c.sched.take(d, upto);
      if (!list.length) return;
      for (const e of list) {
        on(d);
        await step(c, e.label, e.fn);
      }
    }
  };
  for (const d of days('2024-01-02', c.today)) {
    on(d);
    await run(d, 49);
    on(d, 12);
    await step(c, 'site day', () => site.day(d));
    await run(d, 1000);
    if (d === lastOfMonth(d) || d === c.today) {
      const secs = Math.round((realNow() - started) / 1000);
      const live = Object.values(c.projects).filter((p) => p.status === 'active').length;
      process.stdout.write(
        `  ${d.slice(0, 7)}: ${live} live projects, ${Object.values(labour.workers).reduce((n, w) => n + w.length, 0)} workers on the rolls (${secs}s)\n`,
      );
    }
  }
  setClock(null);
  for (const [kind, f] of c.failures) process.stdout.write(`  failed ${f.count}x: ${kind}\n`);
  await fixHistory(c);
  void rupees;
  return { c, labour };
}
