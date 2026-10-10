// A tender programme in memory (docs/wave1-plan.md step 11): the edits people make (insert, change, move, indent,
// delete, link, unlink) applied to the whole plan, the rows' kinds derived (a row with rows under it is a summary;
// a task of no duration is a milestone), and the plan scheduled. Nothing touches the database here, so an edit that
// would close a loop of links or break a rule is refused before anything is saved.
import {
  ScheduleError,
  schedule,
  type ActivityKind,
  type ActivityProgress,
  type CalendarSpec,
  type ConstraintType,
  type LinkType,
  type ScheduleResult,
} from '@aerolith/shared';

export interface Activity {
  /** A database id, or a temporary id ("t…") for a row this edit inserts. */
  id: string;
  parentId: string | null;
  pos: number;
  kind: ActivityKind;
  code: string;
  name: string;
  duration: number;
  calendarId: string | null;
  constraintType: ConstraintType | null;
  constraintDate: string | null;
  notes: string;
  /** Project schedules: the WBS element it belongs to, and its progress. */
  wbsId?: string | null;
  actualStart?: string | null;
  actualFinish?: string | null;
  remaining?: number | null;
}

export interface Link {
  pred: string;
  succ: string;
  type: LinkType;
  lag: number;
}

export interface Calendar {
  id: string;
  name: string;
  /** Bits, Monday = 1 … Sunday = 64. */
  workWeek: number;
  holidays: string[];
  workingDays: string[];
}

export type Op =
  | {
      op: 'insert';
      tempId: string;
      parentId: string | null;
      /** The sibling it goes after; null puts it first under its parent. */
      afterId: string | null;
      code?: string | undefined;
      name: string;
      duration?: number | undefined;
      calendarId?: string | null | undefined;
      constraint?: { type: ConstraintType; date: string } | null | undefined;
      wbsId?: string | null | undefined;
    }
  | {
      op: 'update';
      id: string;
      code?: string | undefined;
      name?: string | undefined;
      duration?: number | undefined;
      calendarId?: string | null | undefined;
      constraint?: { type: ConstraintType; date: string } | null | undefined;
      notes?: string | undefined;
      wbsId?: string | null | undefined;
      /** Progress as of the data date; null clears it (not started). */
      progress?: ActivityProgress | null | undefined;
    }
  | { op: 'move'; id: string; parentId: string | null; afterId: string | null }
  | { op: 'delete'; id: string }
  | { op: 'link'; pred: string; succ: string; type: LinkType; lag: number }
  | { op: 'unlink'; pred: string; succ: string };

export class ProgrammeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly codes: string[] = [],
  ) {
    super(message);
  }
}

/** A tender programme; a project schedule holds up to MAX_SCHEDULE_ACTIVITIES. */
export const MAX_ACTIVITIES = 20_000;
export const MAX_SCHEDULE_ACTIVITIES = 50_000;
export const MAX_DEPTH = 10;

export const toSpec = (c: Calendar): CalendarSpec => ({
  workWeek: [0, 1, 2, 3, 4, 5, 6].map((d) => (c.workWeek & (1 << d)) !== 0),
  holidays: c.holidays,
  workingDays: c.workingDays,
});

/** India's national holidays that fall on fixed dates, for the years a programme may run. */
export function nationalHolidays(fromYear: number, years: number): string[] {
  const out: string[] = [];
  for (let y = fromYear; y < fromYear + years; y++)
    out.push(`${y}-01-26`, `${y}-08-15`, `${y}-10-02`);
  return out;
}

/** The next free activity code after the highest "A<number>": A1000, A1010, A1020… */
export function nextCode(codes: Iterable<string>): string {
  let max = 990;
  for (const c of codes) {
    const m = /^A(\d{1,9})$/i.exec(c);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `A${Math.floor(max / 10) * 10 + 10}`;
}

export class Programme {
  readonly acts = new Map<string, Activity>();
  links = new Map<string, Link>();

  constructor(
    activities: Activity[],
    links: Link[],
    readonly limit = MAX_ACTIVITIES,
  ) {
    for (const a of activities) this.acts.set(a.id, { ...a });
    for (const l of links) this.links.set(`${l.pred}>${l.succ}`, { ...l });
  }

  private act(id: string): Activity {
    const a = this.acts.get(id);
    if (!a) throw new ProgrammeError('activity_not_found', 'That row is not in this programme.');
    return a;
  }

  private children(parentId: string | null): Activity[] {
    return [...this.acts.values()]
      .filter((a) => a.parentId === parentId)
      .sort((x, y) => x.pos - y.pos);
  }

  /** Rows in display order: each summary followed by what is under it. */
  ordered(): Activity[] {
    const kids = new Map<string | null, Activity[]>();
    for (const a of this.acts.values()) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
    for (const list of kids.values()) list.sort((x, y) => x.pos - y.pos);
    const out: Activity[] = [];
    const walk = (p: string | null) => {
      for (const a of kids.get(p) ?? []) {
        out.push(a);
        walk(a.id);
      }
    };
    walk(null);
    return out;
  }

  depth(id: string): number {
    let d = 0;
    for (let p = this.act(id).parentId; p !== null; p = this.act(p).parentId) d++;
    return d;
  }

  /** A position after `afterId` among `parentId`'s rows (renumbering them when the gap is used up). */
  private placeAfter(parentId: string | null, afterId: string | null, moving?: string): number {
    const sibs = this.children(parentId).filter((a) => a.id !== moving);
    let i = -1;
    if (afterId !== null) {
      i = sibs.findIndex((a) => a.id === afterId);
      if (i < 0)
        throw new ProgrammeError('bad_position', 'The row to go after is not at that level.');
    }
    const before = i >= 0 ? sibs[i]!.pos : null;
    const after = sibs[i + 1]?.pos ?? null;
    if (before === null && after === null) return 1024;
    if (before === null) return after! - 1024;
    if (after === null) return before + 1024;
    if (after - before > 1e-6) return (before + after) / 2;
    sibs.forEach((s, k) => (s.pos = (k + 1) * 1024));
    return (i + 1) * 1024 + 512;
  }

  private checkParent(parentId: string | null, moving?: string) {
    if (parentId === null) return;
    for (let p: string | null = parentId; p !== null; p = this.act(p).parentId)
      if (p === moving) throw new ProgrammeError('bad_position', 'A row cannot go under itself.');
    if (this.depth(parentId) + 1 >= MAX_DEPTH)
      throw new ProgrammeError('too_deep', `Summaries go at most ${MAX_DEPTH} levels deep.`);
  }

  /** IDs are unique, ignoring case; checked after the whole edit, so two rows can swap IDs in one go. */
  private checkCodes() {
    const seen = new Map<string, string>();
    for (const a of this.acts.values()) {
      const lc = a.code.toLowerCase();
      if (seen.has(lc))
        throw new ProgrammeError('code_taken', `Activity ID ${a.code} is used twice.`, [a.code]);
      seen.set(lc, a.id);
    }
  }

  apply(ops: Op[]) {
    for (const o of ops) {
      switch (o.op) {
        case 'insert': {
          if (!/^t[\w-]{0,40}$/.test(o.tempId) || this.acts.has(o.tempId))
            throw new ProgrammeError(
              'bad_temp_id',
              'New rows need a fresh temporary id starting with "t".',
            );
          if (this.acts.size >= this.limit)
            throw new ProgrammeError('too_many', `A plan holds up to ${this.limit} activities.`);
          this.checkParent(o.parentId);
          const code = o.code?.trim() || nextCode([...this.acts.values()].map((a) => a.code));
          this.acts.set(o.tempId, {
            id: o.tempId,
            parentId: o.parentId,
            pos: this.placeAfter(o.parentId, o.afterId),
            kind: 'task',
            code,
            name: o.name,
            duration: o.duration ?? 1,
            calendarId: o.calendarId ?? null,
            constraintType: o.constraint?.type ?? null,
            constraintDate: o.constraint?.date ?? null,
            notes: '',
            wbsId: o.wbsId ?? null,
          });
          break;
        }
        case 'update': {
          const a = this.act(o.id);
          if (o.code !== undefined) {
            const code = o.code.trim();
            if (!code) throw new ProgrammeError('bad_code', 'An activity needs an ID.');
            a.code = code;
          }
          if (o.name !== undefined) a.name = o.name;
          if (o.duration !== undefined) a.duration = o.duration;
          if (o.calendarId !== undefined) a.calendarId = o.calendarId;
          if (o.constraint !== undefined) {
            a.constraintType = o.constraint?.type ?? null;
            a.constraintDate = o.constraint?.date ?? null;
          }
          if (o.notes !== undefined) a.notes = o.notes;
          if (o.wbsId !== undefined) a.wbsId = o.wbsId;
          if (o.progress !== undefined) {
            const p = o.progress;
            if (p && !p.actualStart && (p.actualFinish || p.remaining !== null))
              throw new ProgrammeError(
                'bad_progress',
                `${a.code}: a finish or remaining days need an actual start.`,
                [a.code],
              );
            if (p?.actualStart && p.actualFinish && p.actualFinish < p.actualStart)
              throw new ProgrammeError(
                'bad_progress',
                `${a.code} cannot finish before it started.`,
                [a.code],
              );
            a.actualStart = p?.actualStart ?? null;
            a.actualFinish = p?.actualStart ? (p.actualFinish ?? null) : null;
            a.remaining = p?.actualStart && !p.actualFinish ? (p.remaining ?? null) : null;
          }
          break;
        }
        case 'move': {
          const a = this.act(o.id);
          this.checkParent(o.parentId, a.id);
          // A summary moving down a level keeps its own rows under it; the deepest of them must still fit.
          const pos = this.placeAfter(o.parentId, o.afterId, a.id);
          a.parentId = o.parentId;
          a.pos = pos;
          let deepest = 0;
          const walk = (id: string, d: number) => {
            deepest = Math.max(deepest, d);
            for (const c of this.children(id)) walk(c.id, d + 1);
          };
          walk(a.id, this.depth(a.id));
          if (deepest >= MAX_DEPTH)
            throw new ProgrammeError('too_deep', `Summaries go at most ${MAX_DEPTH} levels deep.`);
          break;
        }
        case 'delete': {
          const gone = new Set<string>();
          const walk = (id: string) => {
            gone.add(id);
            for (const c of this.children(id)) walk(c.id);
          };
          walk(this.act(o.id).id);
          for (const id of gone) this.acts.delete(id);
          for (const [k, l] of this.links)
            if (gone.has(l.pred) || gone.has(l.succ)) this.links.delete(k);
          break;
        }
        case 'link': {
          const p = this.act(o.pred);
          const s = this.act(o.succ);
          if (p.id === s.id)
            throw new ProgrammeError('bad_link', 'An activity cannot follow itself.', [p.code]);
          for (const x of [p, s])
            if (this.children(x.id).length)
              throw new ProgrammeError(
                'bad_link',
                `${x.code} is a summary; summaries take no links.`,
                [x.code],
              );
          this.links.set(`${p.id}>${s.id}`, { pred: p.id, succ: s.id, type: o.type, lag: o.lag });
          break;
        }
        case 'unlink':
          this.links.delete(`${o.pred}>${o.succ}`);
          break;
      }
    }
    this.checkCodes();
    this.deriveKinds();
  }

  /** A row with rows under it is a summary (and may take no links); a task of no duration is a milestone. */
  private deriveKinds() {
    const parents = new Set(
      [...this.acts.values()].map((a) => a.parentId).filter((p) => p !== null),
    );
    const linked = new Set([...this.links.values()].flatMap((l) => [l.pred, l.succ]));
    for (const a of this.acts.values()) {
      if (parents.has(a.id)) {
        if (linked.has(a.id))
          throw new ProgrammeError(
            'summary_has_links',
            `${a.code} would become a summary but has links. Remove its links first.`,
            [a.code],
          );
        a.kind = 'summary';
        a.constraintType = null;
        a.constraintDate = null;
        // A summary's progress is its children's.
        a.actualStart = null;
        a.actualFinish = null;
        a.remaining = null;
      } else a.kind = a.duration === 0 ? 'milestone' : 'task';
    }
  }

  /** Schedules the plan; a loop of links or a broken rule is reported with the activity IDs involved. */
  schedule(
    start: string,
    calendarId: string,
    calendars: Calendar[],
    dataDate: string | null = null,
  ): ScheduleResult {
    const codeOf = (id: string) => this.acts.get(id)?.code ?? id;
    // Nothing is done after the day progress is reported for.
    const asOf = dataDate ?? start;
    const ahead = [...this.acts.values()].filter(
      (a) => (a.actualStart && a.actualStart > asOf) || (a.actualFinish && a.actualFinish > asOf),
    );
    if (ahead.length)
      throw new ProgrammeError(
        'actual_after_data_date',
        `Actual dates cannot be after the data date (${asOf}): ${ahead
          .slice(0, 8)
          .map((a) => a.code)
          .join(', ')}${ahead.length > 8 ? '…' : ''}.`,
        ahead.map((a) => a.code),
      );
    try {
      return schedule({
        start,
        dataDate: dataDate ?? undefined,
        calendarId,
        calendars: Object.fromEntries(calendars.map((c) => [c.id, toSpec(c)])),
        activities: this.ordered().map((a) => ({
          id: a.id,
          kind: a.kind,
          duration: a.duration,
          calendarId: a.calendarId,
          parentId: a.parentId,
          constraint:
            a.constraintType && a.constraintDate
              ? { type: a.constraintType, date: a.constraintDate }
              : null,
          progress: a.actualStart
            ? {
                actualStart: a.actualStart,
                actualFinish: a.actualFinish ?? null,
                remaining: a.remaining ?? null,
              }
            : null,
        })),
        links: [...this.links.values()],
      });
    } catch (err) {
      if (err instanceof ScheduleError) {
        const codes = err.ids.map(codeOf);
        if (err.code === 'cycle')
          throw new ProgrammeError(
            'link_loop',
            `These activities follow each other in a loop: ${codes.slice(0, 12).join(', ')}${codes.length > 12 ? '…' : ''}.`,
            codes,
          );
        throw new ProgrammeError(err.code, err.message, codes);
      }
      throw err;
    }
  }
}
