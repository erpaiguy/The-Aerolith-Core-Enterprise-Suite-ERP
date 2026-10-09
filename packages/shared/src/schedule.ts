// The scheduling engine (docs/04-features.md E9 and J4, docs/03-architecture.md §5): critical path method over
// activities with working calendars, the four link types with leads and lags, date constraints, milestones and
// summary rows. Shared by the tender programme (Wave 1 step 11) and project schedules (Wave 2a).
//
// Time model. Durations and lags are whole working days. Each calendar numbers its working days 0, 1, 2…; an
// activity's early start `es` is the position of its first working day and `ef = es + duration` the position just
// after its last, in its own calendar. Within one calendar every link is integer arithmetic (as fast as the Wave 0
// benchmark); a link between activities on different calendars goes through the real day boundary in between.

export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';
export type ConstraintType = 'SNET' | 'SNLT' | 'FNET' | 'FNLT' | 'MSO' | 'MFO';
export type ActivityKind = 'task' | 'milestone' | 'summary';

export interface CalendarSpec {
  /** Working weekdays, Monday first (7 entries). */
  workWeek: readonly boolean[];
  /** Non-working dates (YYYY-MM-DD), e.g. public holidays. */
  holidays: readonly string[];
  /** Working dates on days the week does not work (a Sunday worked before submission). */
  workingDays?: readonly string[];
}

export interface ScheduleActivity {
  id: string;
  kind: ActivityKind;
  /** Working days; ignored for milestones (0) and summaries (from their children). */
  duration: number;
  /** null: the plan's calendar. */
  calendarId: string | null;
  /** The summary row it sits under, if any. */
  parentId: string | null;
  constraint?: { type: ConstraintType; date: string } | null;
}

export interface ScheduleLink {
  pred: string;
  succ: string;
  type: LinkType;
  /** Working days of the successor's calendar; negative is a lead. */
  lag: number;
}

export interface ScheduleInput {
  /** The data date: nothing starts before it. */
  start: string;
  calendarId: string;
  calendars: Record<string, CalendarSpec>;
  activities: readonly ScheduleActivity[];
  links: readonly ScheduleLink[];
}

export interface ScheduledActivity {
  id: string;
  /** Working days (a summary's span in its calendar). */
  duration: number;
  start: string;
  finish: string;
  lateStart: string;
  lateFinish: string;
  /** Working days the activity can slip without moving the finish (negative: a constraint is already missed). */
  totalFloat: number;
  /** Working days it can slip without moving any successor. */
  freeFloat: number;
  critical: boolean;
}

export interface ScheduleResult {
  activities: ScheduledActivity[];
  start: string;
  finish: string;
  /** Working days of the plan's calendar from start to finish. */
  duration: number;
}

export class ScheduleError extends Error {
  constructor(
    readonly code: 'cycle' | 'bad_link' | 'bad_calendar' | 'bad_activity',
    message: string,
    /** Activities involved (for a cycle: those that could not be ordered). */
    readonly ids: string[] = [],
  ) {
    super(message);
  }
}

// --- days ---

const DAY_MS = 86_400_000;
/** Days since 1970-01-01. */
export const dayNumber = (iso: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new ScheduleError('bad_activity', `not a date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
};
export const isoDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday (1970-01-01 was a Thursday). */
export const weekday = (day: number): number => (((day + 3) % 7) + 7) % 7;

/**
 * A calendar's working days as positions. `cum(b)` counts working days before day `b` (so it is also the position of
 * the first working day on or after `b`); `day(p)` is the day of working day `p`. Positions count from `lo`, which
 * stays fixed while the range grows forward as needed.
 */
export class WorkCalendar {
  private cumArr: Int32Array;
  private days: Int32Array;
  private hi: number;
  private readonly holidays: Set<number>;
  private readonly extra: Set<number>;
  private readonly week: readonly boolean[];

  constructor(
    spec: CalendarSpec,
    private readonly lo: number,
    span = 4000,
  ) {
    if (spec.workWeek.length !== 7) throw new ScheduleError('bad_calendar', 'a week has 7 days');
    this.holidays = new Set(spec.holidays.map(dayNumber));
    this.extra = new Set((spec.workingDays ?? []).map(dayNumber));
    if (!spec.workWeek.some(Boolean) && this.extra.size === 0)
      throw new ScheduleError('bad_calendar', 'a calendar needs working days');
    this.week = spec.workWeek;
    this.hi = lo;
    this.cumArr = new Int32Array(1);
    this.days = new Int32Array(0);
    this.grow(lo + span);
  }

  isWorking(day: number): boolean {
    if (this.extra.has(day)) return true;
    if (this.holidays.has(day)) return false;
    return this.week[weekday(day)] === true;
  }

  private grow(to: number) {
    if (to <= this.hi) return;
    const len = to - this.lo;
    const cum = new Int32Array(len + 1);
    cum.set(this.cumArr);
    const days: number[] = Array.from(this.days);
    for (let d = this.hi; d < to; d++) {
      const i = d - this.lo;
      const w = this.isWorking(d);
      cum[i + 1] = cum[i]! + (w ? 1 : 0);
      if (w) days.push(d);
    }
    this.cumArr = cum;
    this.days = Int32Array.from(days);
    this.hi = to;
  }

  /** Working days before day `b` (positions start at the range's first day). */
  cum(b: number): number {
    if (b <= this.lo) return 0;
    if (b > this.hi) this.grow(Math.max(b, this.hi * 2 - this.lo));
    return this.cumArr[b - this.lo]!;
  }

  /** The day of working day `p` (p ≥ 0). */
  day(p: number): number {
    while (p >= this.days.length) this.grow(this.hi + Math.max(4000, this.hi - this.lo));
    return this.days[Math.max(0, p)]!;
  }

  /** Day boundary where working day `p` starts. */
  startB(p: number): number {
    return this.day(p);
  }

  /** Day boundary where the working day before position `p` ends (the morning after it). */
  finishB(p: number): number {
    return p <= 0 ? this.day(0) : this.day(p - 1) + 1;
  }
}

// --- the engine ---

const NONE = -2147483648;

export function schedule(input: ScheduleInput): ScheduleResult {
  const startDay = dayNumber(input.start);
  const lo = startDay - 3650;
  const cals = new Map<string, WorkCalendar>();
  const cal = (id: string): WorkCalendar => {
    let c = cals.get(id);
    if (!c) {
      const spec = input.calendars[id];
      if (!spec) throw new ScheduleError('bad_calendar', `no calendar ${id}`);
      c = new WorkCalendar(spec, lo);
      cals.set(id, c);
    }
    return c;
  };
  const planCal = cal(input.calendarId);

  const acts = input.activities;
  const n = acts.length;
  const index = new Map<string, number>();
  acts.forEach((a, i) => {
    if (index.has(a.id)) throw new ScheduleError('bad_activity', `activity ${a.id} twice`, [a.id]);
    index.set(a.id, i);
  });
  const calOf: WorkCalendar[] = acts.map((a) => cal(a.calendarId ?? input.calendarId));
  const isSummary = acts.map((a) => a.kind === 'summary');
  const dur = Int32Array.from(acts, (a) =>
    a.kind === 'task' ? Math.max(0, Math.round(a.duration)) : 0,
  );

  // Links as index arrays (CSR), between non-summary activities.
  const m = input.links.length;
  const lp = new Int32Array(m);
  const ls = new Int32Array(m);
  const lt = new Uint8Array(m);
  const lag = new Int32Array(m);
  const TYPES: LinkType[] = ['FS', 'SS', 'FF', 'SF'];
  input.links.forEach((l, k) => {
    const p = index.get(l.pred);
    const s = index.get(l.succ);
    if (p === undefined || s === undefined)
      throw new ScheduleError('bad_link', 'a link names an unknown activity', [l.pred, l.succ]);
    if (p === s) throw new ScheduleError('bad_link', 'an activity cannot follow itself', [l.pred]);
    if (isSummary[p] || isSummary[s])
      throw new ScheduleError('bad_link', 'summary rows take no links', [l.pred, l.succ]);
    lp[k] = p;
    ls[k] = s;
    lt[k] = TYPES.indexOf(l.type);
    lag[k] = Math.round(l.lag);
  });
  const outStart = new Int32Array(n + 1);
  const inStart = new Int32Array(n + 1);
  for (let k = 0; k < m; k++) {
    outStart[lp[k]! + 1]!++;
    inStart[ls[k]! + 1]!++;
  }
  for (let i = 0; i < n; i++) {
    outStart[i + 1]! += outStart[i]!;
    inStart[i + 1]! += inStart[i]!;
  }
  const outRel = new Int32Array(m);
  const inRel = new Int32Array(m);
  {
    const of = outStart.slice(0, n);
    const inf = inStart.slice(0, n);
    for (let k = 0; k < m; k++) {
      outRel[of[lp[k]!]!++] = k;
      inRel[inf[ls[k]!]!++] = k;
    }
  }

  // Topological order (Kahn); what is left over is in or behind a cycle.
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) indeg[i] = inStart[i + 1]! - inStart[i]!;
  const order = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (indeg[i] === 0) order[tail++] = i;
  while (head < tail) {
    const a = order[head++]!;
    for (let q = outStart[a]!; q < outStart[a + 1]!; q++) {
      const s = ls[outRel[q]!]!;
      if (--indeg[s]! === 0) order[tail++] = s;
    }
  }
  if (tail !== n) {
    const stuck = acts.filter((_, i) => indeg[i]! > 0).map((a) => a.id);
    throw new ScheduleError('cycle', 'the links go round in a circle', stuck);
  }

  const cons = acts.map((a) =>
    a.constraint ? { type: a.constraint.type, day: dayNumber(a.constraint.date) } : null,
  );

  // Forward pass. Bounds on a successor come in its own calendar's positions.
  const es = new Int32Array(n);
  const ef = new Int32Array(n);
  for (let o = 0; o < n; o++) {
    const a = order[o]!;
    if (isSummary[a]) continue;
    const C = calOf[a]!;
    let start = C.cum(startDay);
    for (let q = inStart[a]!; q < inStart[a + 1]!; q++) {
      const k = inRel[q]!;
      const p = lp[k]!;
      const P = calOf[p]!;
      const same = P === C;
      let bound: number;
      switch (lt[k]) {
        case 0: // FS
          bound = (same ? ef[p]! : C.cum(P.finishB(ef[p]!))) + lag[k]!;
          break;
        case 1: // SS
          bound = (same ? es[p]! : C.cum(P.startB(es[p]!))) + lag[k]!;
          break;
        case 2: // FF
          bound = (same ? ef[p]! : C.cum(P.finishB(ef[p]!))) + lag[k]! - dur[a]!;
          break;
        default: // SF
          bound = (same ? es[p]! : C.cum(P.startB(es[p]!))) + lag[k]! - dur[a]!;
      }
      if (bound > start) start = bound;
    }
    const c = cons[a];
    if (c) {
      if (c.type === 'SNET') start = Math.max(start, C.cum(c.day));
      else if (c.type === 'FNET') start = Math.max(start, C.cum(c.day) + 1 - dur[a]!);
      else if (c.type === 'MSO') start = C.cum(c.day);
      else if (c.type === 'MFO') start = C.cum(c.day) + 1 - dur[a]!;
    }
    es[a] = start;
    ef[a] = start + dur[a]!;
  }

  // The plan's finish: the latest finish boundary of any activity.
  let finishB = startDay;
  for (let i = 0; i < n; i++) {
    if (isSummary[i]) continue;
    const b = calOf[i]!.finishB(ef[i]!);
    if (b > finishB) finishB = b;
  }

  // Backward pass, in the activity's own positions.
  const lf = new Int32Array(n);
  const lsA = new Int32Array(n);
  for (let o = n - 1; o >= 0; o--) {
    const a = order[o]!;
    if (isSummary[a]) continue;
    const A = calOf[a]!;
    let finish = A.cum(finishB);
    for (let q = outStart[a]!; q < outStart[a + 1]!; q++) {
      const k = outRel[q]!;
      const s = ls[k]!;
      const S = calOf[s]!;
      const same = S === A;
      let bound: number;
      switch (lt[k]) {
        case 0: // FS: finish of a ≤ start of s − lag
          bound = same ? lsA[s]! - lag[k]! : A.cum(S.startB(lsA[s]! - lag[k]!));
          break;
        case 1: // SS: start of a ≤ start of s − lag
          bound = (same ? lsA[s]! - lag[k]! : A.cum(S.startB(lsA[s]! - lag[k]!) + 1) - 1) + dur[a]!;
          break;
        case 2: // FF: finish of a ≤ finish of s − lag
          bound = same ? lf[s]! - lag[k]! : A.cum(S.startB(lf[s]! - lag[k]!));
          break;
        default: // SF: start of a ≤ finish of s − lag
          bound = (same ? lf[s]! - lag[k]! : A.cum(S.startB(lf[s]! - lag[k]!) + 1) - 1) + dur[a]!;
      }
      if (bound < finish) finish = bound;
    }
    const c = cons[a];
    if (c) {
      if (c.type === 'FNLT') finish = Math.min(finish, A.cum(c.day + 1));
      else if (c.type === 'SNLT') finish = Math.min(finish, A.cum(c.day + 1) - 1 + dur[a]!);
      else if (c.type === 'MSO') finish = A.cum(c.day) + dur[a]!;
      else if (c.type === 'MFO') finish = A.cum(c.day) + 1;
    }
    lf[a] = finish;
    lsA[a] = finish - dur[a]!;
  }

  // Free float: slack to the nearest successor's early dates (or to the plan's finish).
  const free = new Int32Array(n).fill(NONE);
  for (let a = 0; a < n; a++) {
    if (isSummary[a]) continue;
    const A = calOf[a]!;
    let f = A.cum(finishB) - ef[a]!;
    for (let q = outStart[a]!; q < outStart[a + 1]!; q++) {
      const k = outRel[q]!;
      const s = ls[k]!;
      const S = calOf[s]!;
      const same = S === A;
      let slack: number;
      switch (lt[k]) {
        case 0:
          slack = es[s]! - lag[k]! - (same ? ef[a]! : S.cum(A.finishB(ef[a]!)));
          break;
        case 1:
          slack = es[s]! - lag[k]! - (same ? es[a]! : S.cum(A.startB(es[a]!)));
          break;
        case 2:
          slack = ef[s]! - lag[k]! - (same ? ef[a]! : S.cum(A.finishB(ef[a]!)));
          break;
        default:
          slack = ef[s]! - lag[k]! - (same ? es[a]! : S.cum(A.startB(es[a]!)));
      }
      if (slack < f) f = slack;
    }
    free[a] = Math.max(0, f);
  }

  const hasPred = (i: number) => inStart[i + 1]! > inStart[i]!;
  /** Dates as people read them: a task's first and last working day; a milestone on the day it marks. */
  const dates = (i: number, s: number, f: number) => {
    const C = calOf[i]!;
    if (dur[i]! > 0) return { start: C.day(s), finish: C.day(f - 1) };
    // A milestone after something marks the day that finished; a milestone with nothing before it, its start.
    const d = hasPred(i) && s > C.cum(startDay) ? C.day(s - 1) : C.day(s);
    return { start: d, finish: d };
  };

  const out: ScheduledActivity[] = acts.map((a, i) => {
    if (isSummary[i])
      return {
        id: a.id,
        duration: 0,
        start: '',
        finish: '',
        lateStart: '',
        lateFinish: '',
        totalFloat: 0,
        freeFloat: 0,
        critical: false,
      };
    const early = dates(i, es[i]!, ef[i]!);
    const late = dates(i, lsA[i]!, lf[i]!);
    const tf = lsA[i]! - es[i]!;
    return {
      id: a.id,
      duration: dur[i]!,
      start: isoDay(early.start),
      finish: isoDay(early.finish),
      lateStart: isoDay(late.start),
      lateFinish: isoDay(late.finish),
      totalFloat: tf,
      freeFloat: free[i]!,
      critical: tf <= 0,
    };
  });

  // Summary rows span their children (deepest first, so nested summaries roll up).
  const children = new Map<number, number[]>();
  acts.forEach((a, i) => {
    if (a.parentId === null) return;
    const p = index.get(a.parentId);
    if (p === undefined || !isSummary[p])
      throw new ScheduleError(
        'bad_activity',
        'an activity sits under a row that is not a summary',
        [a.id],
      );
    children.set(p, [...(children.get(p) ?? []), i]);
  });
  const depthOf = (i: number): number => {
    let d = 0;
    for (let p = acts[i]!.parentId; p !== null; p = acts[index.get(p)!]!.parentId) {
      if (++d > 100)
        throw new ScheduleError('bad_activity', 'summary rows go round in a circle', [acts[i]!.id]);
    }
    return d;
  };
  const summaries = acts
    .map((_, i) => i)
    .filter((i) => isSummary[i])
    .sort((x, y) => depthOf(y) - depthOf(x));
  for (const i of summaries) {
    const kids = (children.get(i) ?? []).map((k) => out[k]!).filter((k) => k.start !== '');
    if (kids.length === 0) continue;
    const start = kids.reduce((x, k) => (k.start < x ? k.start : x), kids[0]!.start);
    const finish = kids.reduce((x, k) => (k.finish > x ? k.finish : x), kids[0]!.finish);
    const lateStart = kids.reduce(
      (x, k) => (k.lateStart < x ? k.lateStart : x),
      kids[0]!.lateStart,
    );
    const lateFinish = kids.reduce(
      (x, k) => (k.lateFinish > x ? k.lateFinish : x),
      kids[0]!.lateFinish,
    );
    const C = calOf[i]!;
    const tf = Math.min(...kids.map((k) => k.totalFloat));
    out[i] = {
      id: acts[i]!.id,
      duration: C.cum(dayNumber(finish) + 1) - C.cum(dayNumber(start)),
      start,
      finish,
      lateStart,
      lateFinish,
      totalFloat: tf,
      freeFloat: Math.min(...kids.map((k) => k.freeFloat)),
      critical: tf <= 0,
    };
  }

  const real = out.filter((a) => a.start !== '');
  const first = real.length
    ? real.reduce((x, a) => (a.start < x ? a.start : x), real[0]!.start)
    : input.start;
  const last = real.length
    ? real.reduce((x, a) => (a.finish > x ? a.finish : x), real[0]!.finish)
    : input.start;
  return {
    activities: out,
    start: first,
    finish: last,
    duration: real.length ? planCal.cum(dayNumber(last) + 1) - planCal.cum(dayNumber(first)) : 0,
  };
}
