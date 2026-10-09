// The scheduling engine (schedule.ts), worked by hand on real calendars: a Mon–Fri design office and a Mon–Sat site
// with a holiday, every link type with leads and lags, a link between the two calendars, constraints, milestones,
// summaries and cycles. Then the same random network against the Wave 0 benchmark engine on a 7-day calendar.
import { describe, expect, it } from 'vitest';
import { computeCpm } from '../../../tools/bench/src/cpm.js';
import {
  ScheduleError,
  WorkCalendar,
  dayNumber,
  isoDay,
  schedule,
  weekday,
  type CalendarSpec,
  type ScheduleActivity,
  type ScheduleLink,
} from './schedule.js';

const OFFICE: CalendarSpec = {
  workWeek: [true, true, true, true, true, false, false],
  holidays: [],
};
// Mon–Sat, with Monday 9 November 2026 off.
const SITE: CalendarSpec = {
  workWeek: [true, true, true, true, true, true, false],
  holidays: ['2026-11-09'],
};
const START = '2026-11-02'; // a Monday

const task = (
  id: string,
  duration: number,
  extra: Partial<ScheduleActivity> = {},
): ScheduleActivity => ({
  id,
  kind: 'task',
  duration,
  calendarId: null,
  parentId: null,
  ...extra,
});
const fs = (pred: string, succ: string, lag = 0): ScheduleLink => ({ pred, succ, type: 'FS', lag });
const run = (activities: ScheduleActivity[], links: ScheduleLink[], calendarId = 'site') => {
  const r = schedule({
    start: START,
    calendarId,
    calendars: { site: SITE, office: OFFICE },
    activities,
    links,
  });
  return Object.fromEntries(r.activities.map((a) => [a.id, a]));
};

describe('days and calendars', () => {
  it('numbers days and weekdays', () => {
    expect(weekday(dayNumber('2026-11-02'))).toBe(0); // Monday
    expect(weekday(dayNumber('2026-11-08'))).toBe(6); // Sunday
    expect(isoDay(dayNumber('2026-12-31'))).toBe('2026-12-31');
  });

  it('counts working days, skipping Sundays, holidays, and working an extra Sunday', () => {
    const c = new WorkCalendar({ ...SITE, workingDays: ['2026-11-15'] }, dayNumber('2026-11-01'));
    const from = (a: string, b: string) => c.cum(dayNumber(b)) - c.cum(dayNumber(a));
    expect(from('2026-11-02', '2026-11-09')).toBe(6); // Mon..Sat
    expect(from('2026-11-09', '2026-11-16')).toBe(6); // holiday Mon off, extra Sunday on
    expect(isoDay(c.day(c.cum(dayNumber('2026-11-08'))))).toBe('2026-11-10'); // next working day after Sunday
  });
});

describe('critical path on working calendars', () => {
  it('chains tasks over a weekend and a holiday, with float on the shorter path', () => {
    // Excavation 5d → Footings 4d → Plinth milestone; Survey 2d → Plinth.
    const r = run(
      [
        task('exc', 5),
        task('foot', 4),
        task('survey', 2),
        task('plinth', 0, { kind: 'milestone' }),
      ],
      [fs('exc', 'foot'), fs('foot', 'plinth'), fs('survey', 'plinth')],
    );
    expect(r.exc).toMatchObject({ start: '2026-11-02', finish: '2026-11-06', critical: true });
    // Sat 7th, (Sun, holiday Mon) Tue 10th, Wed 11th, Thu 12th.
    expect(r.foot).toMatchObject({ start: '2026-11-07', finish: '2026-11-12', totalFloat: 0 });
    expect(r.plinth).toMatchObject({ start: '2026-11-12', finish: '2026-11-12', critical: true });
    // Survey can finish as late as the 12th: 7 working days of float.
    expect(r.survey).toMatchObject({
      start: '2026-11-02',
      finish: '2026-11-03',
      lateStart: '2026-11-11',
      lateFinish: '2026-11-12',
      totalFloat: 7,
      freeFloat: 7,
      critical: false,
    });
  });

  it('applies SS, FF and SF links with lags and leads', () => {
    const r = run(
      [task('a', 6), task('b', 3), task('c', 4), task('d', 2), task('e', 3)],
      [
        { pred: 'a', succ: 'b', type: 'SS', lag: 2 }, // b starts 2 days into a
        { pred: 'a', succ: 'c', type: 'FF', lag: 1 }, // c finishes a day after a
        { pred: 'b', succ: 'd', type: 'SF', lag: 4 }, // d finishes 4 days after b starts
        fs('a', 'e', -2), // e overlaps the last 2 days of a
      ],
    );
    expect(r.a).toMatchObject({ start: '2026-11-02', finish: '2026-11-07' }); // Mon..Sat
    expect(r.b).toMatchObject({ start: '2026-11-04', finish: '2026-11-06' });
    expect(r.c).toMatchObject({ start: '2026-11-05', finish: '2026-11-10' }); // finishes a day after Sat 7th: Tue 10th
    expect(r.d).toMatchObject({ start: '2026-11-06', finish: '2026-11-07' });
    expect(r.e).toMatchObject({ start: '2026-11-06', finish: '2026-11-10' });
  });

  it("links an office task to a site task through the real day between, in each one's own calendar", () => {
    // Drawings (office, Mon–Fri) finish Friday; site works Saturday, so mobilisation starts Saturday.
    const r = run(
      [
        task('drawings', 5, { calendarId: 'office' }),
        task('mobilise', 2),
        task('approval', 3, { calendarId: 'office' }),
      ],
      [fs('drawings', 'mobilise'), fs('mobilise', 'approval')],
    );
    expect(r.drawings).toMatchObject({ start: '2026-11-02', finish: '2026-11-06' });
    expect(r.mobilise).toMatchObject({ start: '2026-11-07', finish: '2026-11-10' }); // Sat, Tue (Sun + holiday)
    expect(r.approval).toMatchObject({ start: '2026-11-11', finish: '2026-11-13' });
    expect(Object.values(r).every((a) => a.totalFloat === 0)).toBe(true);
  });

  it('honours constraints, and shows a missed deadline as negative float', () => {
    const r = run(
      [
        task('a', 3, { constraint: { type: 'SNET', date: '2026-11-04' } }),
        task('b', 5, { constraint: { type: 'FNLT', date: '2026-11-10' } }),
        task('c', 2, { constraint: { type: 'MSO', date: '2026-11-16' } }),
      ],
      [fs('a', 'b')],
    );
    expect(r.a).toMatchObject({ start: '2026-11-04', finish: '2026-11-06' });
    expect(r.b).toMatchObject({ start: '2026-11-07', finish: '2026-11-13' });
    // Must finish by Tue 10th but finishes Fri 13th: 3 working days late.
    expect(r.b!.totalFloat).toBe(-3);
    expect(r.a!.totalFloat).toBe(-3);
    expect(r.c).toMatchObject({ start: '2026-11-16', finish: '2026-11-17', totalFloat: 0 });
  });

  it('rolls summaries up from their children, nested', () => {
    const r = run(
      [
        { id: 'civil', kind: 'summary', duration: 0, calendarId: null, parentId: null },
        { id: 'sub', kind: 'summary', duration: 0, calendarId: null, parentId: 'civil' },
        task('x', 3, { parentId: 'sub' }),
        task('y', 4, { parentId: 'civil' }),
      ],
      [fs('x', 'y')],
    );
    expect(r.sub).toMatchObject({ start: '2026-11-02', finish: '2026-11-04', duration: 3 });
    // Thu 5th, Fri, Sat, then Tue 10th after Sunday and the holiday.
    expect(r.civil).toMatchObject({
      start: '2026-11-02',
      finish: '2026-11-10',
      duration: 7,
      critical: true,
    });
  });

  it('refuses a circle of links, naming the activities in it, and links on summaries', () => {
    let err: unknown;
    try {
      run(
        [task('a', 1), task('b', 1), task('c', 1), task('d', 1)],
        [fs('a', 'b'), fs('b', 'c'), fs('c', 'b'), fs('c', 'd')],
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScheduleError);
    expect((err as ScheduleError).code).toBe('cycle');
    expect((err as ScheduleError).ids.sort()).toEqual(['b', 'c', 'd']);
    expect(() =>
      run(
        [{ id: 's', kind: 'summary', duration: 0, calendarId: null, parentId: null }, task('a', 1)],
        [fs('s', 'a')],
      ),
    ).toThrow(/summary/);
  });
});

describe('against the Wave 0 benchmark engine', () => {
  it('agrees on a random network of 5,000 activities on a 7-day calendar, and is fast at 50,000', () => {
    const every: CalendarSpec = { workWeek: Array(7).fill(true), holidays: [] };
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const make = (n: number) => {
      const durations = Array.from({ length: n }, () => Math.floor(rnd() * 10));
      const links: { pred: number; succ: number; type: 'FS' | 'SS' | 'FF' | 'SF'; lag: number }[] =
        [];
      for (let s = 1; s < n; s++)
        for (let k = 0; k < 2; k++) {
          const pred = Math.max(0, s - 1 - Math.floor(rnd() * 50));
          const type = (['FS', 'FS', 'SS', 'FF', 'SF'] as const)[Math.floor(rnd() * 5)]!;
          links.push({ pred, succ: s, type, lag: Math.floor(rnd() * 5) - 1 });
        }
      return { durations, links };
    };
    const { durations, links } = make(5000);
    const bench = computeCpm(durations, links);
    const ours = schedule({
      start: START,
      calendarId: 'all',
      calendars: { all: every },
      activities: durations.map((d, i) => task(String(i), d)),
      links: links.map((l) => ({ ...l, pred: String(l.pred), succ: String(l.succ) })),
    });
    const s0 = dayNumber(START);
    // The benchmark lets activities start before day 0 through leads; ours never starts before the data date.
    // Compare only when no activity was held back by it.
    const minEs = Math.min(...Array.from(bench.es));
    expect(minEs).toBeGreaterThanOrEqual(0);
    ours.activities.forEach((a, i) => {
      // A milestone shows the day its predecessor finished, so positions are compared for tasks only.
      if (durations[i]! > 0) {
        expect(dayNumber(a.start) - s0).toBe(bench.es[i]);
        expect(dayNumber(a.finish) - s0 + 1).toBe(bench.ef[i]);
      }
      expect(a.totalFloat).toBe(bench.totalFloat[i]);
    });

    const big = make(50_000);
    const t0 = performance.now();
    schedule({
      start: START,
      calendarId: 'site',
      calendars: { site: SITE },
      activities: big.durations.map((d, i) => task(String(i), d)),
      links: big.links.map((l) => ({ ...l, pred: String(l.pred), succ: String(l.succ) })),
    });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
