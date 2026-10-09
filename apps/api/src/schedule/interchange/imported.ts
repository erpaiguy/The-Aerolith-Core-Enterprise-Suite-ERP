// A programme read from another tool (MS Project XML, Primavera XER), before it becomes one of ours: the same shape
// whatever the format, with what could not be carried over said in plain words.
import type { ConstraintType, LinkType } from '@aerolith/shared';
import { nextCode, type Op } from '../programme-model.js';

export interface ImportedCalendar {
  key: string;
  name: string;
  /** Bits, Monday = 1 … Sunday = 64. */
  workWeek: number;
  holidays: string[];
  workingDays: string[];
}

export interface ImportedActivity {
  key: string;
  parentKey: string | null;
  code: string;
  name: string;
  /** Working days. */
  duration: number;
  /** A summary in the file (it becomes one here only if rows sit under it). */
  summary: boolean;
  calendarKey: string | null;
  constraint: { type: ConstraintType; date: string } | null;
}

export interface ImportedLink {
  pred: string;
  succ: string;
  type: LinkType;
  lag: number;
}

export interface ImportedPlan {
  format: 'mspdi' | 'xer';
  name: string;
  startOn: string;
  calendars: ImportedCalendar[];
  defaultCalendarKey: string | null;
  activities: ImportedActivity[];
  links: ImportedLink[];
  /** The finish date the file itself states, to compare with ours after recalculating. */
  fileFinish: string | null;
  warnings: string[];
}

/** Hours to whole working days, saying so when a duration was not a whole number of days. */
export function hoursToDays(
  hours: number,
  hoursPerDay: number,
  what: string,
  warnings: string[],
): number {
  const days = hours / hoursPerDay;
  const whole = Math.round(days);
  if (Math.abs(days - whole) > 0.01)
    warnings.push(`${what}: ${days.toFixed(2)} days rounded to ${whole}.`);
  return Math.max(0, whole);
}

/**
 * The edits that build the imported programme: rows in file order under their summaries, then the links. Links on
 * summary rows (allowed by MS Project, not here) are dropped and listed; codes used twice get a suffix.
 */
export function toOps(
  plan: ImportedPlan,
  calendarIds: Map<string, string>,
): { ops: Op[]; warnings: string[] } {
  const warnings: string[] = [];
  const temp = new Map(plan.activities.map((a, i) => [a.key, `t${i}`]));
  const hasChildren = new Set(plan.activities.map((a) => a.parentKey).filter((k) => k !== null));
  const used = new Set<string>();
  const lastChild = new Map<string | null, string>();
  const ops: Op[] = [];
  for (const a of plan.activities) {
    let code = a.code.trim().slice(0, 40) || nextCode(used);
    if (used.has(code.toLowerCase())) {
      let n = 2;
      while (used.has(`${code}-${n}`.toLowerCase())) n++;
      warnings.push(`Activity ID ${code} appears more than once; the copy is ${code}-${n}.`);
      code = `${code}-${n}`;
    }
    used.add(code.toLowerCase());
    const parent = a.parentKey !== null && temp.has(a.parentKey) ? temp.get(a.parentKey)! : null;
    const t = temp.get(a.key)!;
    ops.push({
      op: 'insert',
      tempId: t,
      parentId: parent,
      afterId: lastChild.get(parent) ?? null,
      code,
      name: a.name.slice(0, 500),
      duration: hasChildren.has(a.key) ? 0 : Math.min(36500, a.duration),
      calendarId: a.calendarKey ? (calendarIds.get(a.calendarKey) ?? null) : null,
      constraint: hasChildren.has(a.key) ? null : a.constraint,
    });
    lastChild.set(parent, t);
  }
  const codeOf = new Map(plan.activities.map((a) => [a.key, a.code]));
  let dropped = 0;
  for (const l of plan.links) {
    const p = temp.get(l.pred);
    const s = temp.get(l.succ);
    if (!p || !s || p === s) continue;
    if (hasChildren.has(l.pred) || hasChildren.has(l.succ)) {
      if (dropped++ < 20)
        warnings.push(
          `Link ${codeOf.get(l.pred)} → ${codeOf.get(l.succ)} is on a summary row; summaries take no links here, so it was left out.`,
        );
      continue;
    }
    ops.push({
      op: 'link',
      pred: p,
      succ: s,
      type: l.type,
      lag: Math.max(-3650, Math.min(3650, l.lag)),
    });
  }
  if (dropped > 20) warnings.push(`…and ${dropped - 20} more links on summary rows.`);
  return { ops, warnings };
}
