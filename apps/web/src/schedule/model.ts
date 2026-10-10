// Plans on the client: a tender's programme (docs/wave1-plan.md step 11) or a project's schedule (docs/wave2a-plan.md
// step 4) as the API returns it, predecessors as people type them ("A1010, A1020SS+2"), and the edits a row change
// turns into.

export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';
export type ConstraintType = 'SNET' | 'SNLT' | 'FNET' | 'FNLT' | 'MSO' | 'MFO';

export interface ProgrammeCalendar {
  id: string;
  name: string;
  /** Bits, Monday = 1 … Sunday = 64. */
  workWeek: number;
  holidays: string[];
  workingDays: string[];
}

export interface ProgrammeActivity {
  id: string;
  parentId: string | null;
  depth: number;
  pos: number;
  kind: 'task' | 'milestone' | 'summary';
  code: string;
  name: string;
  duration: number;
  calendarId: string | null;
  constraintType: ConstraintType | null;
  constraintDate: string | null;
  notes: string;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  totalFloat: number | null;
  freeFloat: number | null;
  critical: boolean;
  /** Project schedules. */
  wbsId?: string | null;
  wbsCode?: string | null;
  package?: string | null;
  trade?: string | null;
  zone?: string | null;
  actualStart?: string | null;
  actualFinish?: string | null;
  /** Reported working days left (started, not finished); null: worked out from the duration. */
  remaining?: number | null;
  /** Working days still to do, as scheduled. */
  remainingLeft?: number | null;
  status?: ActivityStatus;
  baselineStart?: string | null;
  baselineFinish?: string | null;
}

export type ActivityStatus = 'not_started' | 'in_progress' | 'finished';

export interface ProgrammeBaseline {
  id: string;
  name: string;
  dataDate: string;
  finishOn: string | null;
  activityCount: number;
  takenAt: string;
  takenBy: string | null;
}

export interface ProgrammeLink {
  pred: string;
  succ: string;
  type: LinkType;
  lag: number;
}

export interface ProgrammeDetail {
  id: string;
  kind: 'tender_programme' | 'project_schedule';
  tenderId: string | null;
  projectId: string | null;
  tender: { id: string; number: string; title: string } | null;
  /** The tender or project it belongs to. */
  owner: { kind: 'tender' | 'project'; id: string; number: string; title: string };
  name: string;
  startOn: string;
  /** Project schedules: progress is as of this day (null: the start). */
  dataDate: string | null;
  baselineId: string | null;
  baselines: ProgrammeBaseline[];
  calendarId: string;
  notes: string;
  finishOn: string | null;
  duration: number | null;
  activityCount: number;
  archivedAt: string | null;
  rowVersion: number;
  calendars: ProgrammeCalendar[];
  activities: ProgrammeActivity[];
  links: ProgrammeLink[];
}

export interface ProgrammeSummary {
  id: string;
  name: string;
  startOn: string;
  finishOn: string | null;
  duration: number | null;
  activityCount: number;
  archivedAt: string | null;
}

export type Op =
  | {
      op: 'insert';
      tempId: string;
      parentId: string | null;
      afterId: string | null;
      name: string;
      duration?: number;
    }
  | {
      op: 'update';
      id: string;
      code?: string;
      name?: string;
      duration?: number;
      calendarId?: string | null;
      constraint?: { type: ConstraintType; date: string } | null;
      notes?: string;
      wbsId?: string | null;
      package?: string | null;
      trade?: string | null;
      zone?: string | null;
      progress?: {
        actualStart: string | null;
        actualFinish: string | null;
        remaining: number | null;
      } | null;
    }
  | { op: 'move'; id: string; parentId: string | null; afterId: string | null }
  | { op: 'delete'; id: string }
  | { op: 'link'; pred: string; succ: string; type: LinkType; lag: number }
  | { op: 'unlink'; pred: string; succ: string };

export const CONSTRAINTS: Record<ConstraintType, string> = {
  SNET: 'Start no earlier than',
  SNLT: 'Start no later than',
  FNET: 'Finish no earlier than',
  FNLT: 'Finish no later than',
  MSO: 'Must start on',
  MFO: 'Must finish on',
};

/** "A1010", "A1010SS", "A1010 FF+2", "A1010SF-1" as one predecessor. */
export function formatLink(code: string, l: Pick<ProgrammeLink, 'type' | 'lag'>): string {
  const lag = l.lag === 0 ? '' : l.lag > 0 ? `+${l.lag}` : String(l.lag);
  return l.type === 'FS' && l.lag === 0 ? code : `${code}${l.type}${lag}`;
}

/** An activity's predecessors as they are typed. */
export function predecessorsText(
  id: string,
  links: ProgrammeLink[],
  codeOf: (id: string) => string,
): string {
  return links
    .filter((l) => l.succ === id)
    .map((l) => formatLink(codeOf(l.pred), l))
    .sort()
    .join(', ');
}

export interface ParsedLink {
  code: string;
  type: LinkType;
  lag: number;
}

/**
 * Reads typed predecessors: activity IDs separated by commas or semicolons, each optionally followed by a link type
 * and a lag in working days ("A1020SS+2", "a1030 ff -1"). IDs are matched ignoring case against those in the plan;
 * an ID that itself ends in FS/SS/FF/SF is understood as the ID when no such type was meant.
 */
export function parsePredecessors(
  text: string,
  codes: Iterable<string>,
): { links: ParsedLink[]; errors: string[] } {
  const known = new Map([...codes].map((c) => [c.toLowerCase(), c]));
  const links: ParsedLink[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/[,;]/)) {
    const token = raw.trim();
    if (!token) continue;
    const m = /^(.+?)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d{1,4})\s*d?)?$/i.exec(token);
    let code = m?.[1]?.trim() ?? '';
    let type = (m?.[2]?.toUpperCase() ?? 'FS') as LinkType;
    if (m && !known.has(code.toLowerCase()) && m[2] && known.has(`${code}${m[2]}`.toLowerCase())) {
      code = `${code}${m[2]}`;
      type = 'FS';
    }
    const real = known.get(code.toLowerCase());
    if (!m || !real) {
      errors.push(`"${token}" is not an activity ID in this programme.`);
      continue;
    }
    const lag = m[4] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
    links.push({ code: real, type, lag });
  }
  return { links, errors };
}

/** The link edits that turn an activity's predecessors into the typed ones. */
export function predecessorOps(
  succ: string,
  typed: ParsedLink[],
  links: ProgrammeLink[],
  idOf: (code: string) => string,
): Op[] {
  const ops: Op[] = [];
  const now = new Map(links.filter((l) => l.succ === succ).map((l) => [l.pred, l]));
  const wanted = new Map(typed.map((t) => [idOf(t.code), t]));
  for (const [pred] of now) if (!wanted.has(pred)) ops.push({ op: 'unlink', pred, succ });
  for (const [pred, t] of wanted) {
    const o = now.get(pred);
    if (!o || o.type !== t.type || o.lag !== t.lag)
      ops.push({ op: 'link', pred, succ, type: t.type, lag: t.lag });
  }
  return ops;
}

// --- dates ---

const DAY = 86_400_000;
export const dayNo = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
export const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday. */
export const weekdayOf = (day: number) => (((day + 3) % 7) + 7) % 7;
export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
/** 9 Nov 26 */
export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y!.slice(2)}`;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const workWeekLabel = (bits: number) =>
  WEEKDAYS.filter((_, i) => (bits & (1 << i)) !== 0).join(', ') || 'none';

/** Whether a day is worked in a calendar. */
export function isWorking(
  cal: ProgrammeCalendar,
  day: number,
  sets?: { h: Set<string>; w: Set<string> },
) {
  const iso = isoOf(day);
  const h = sets?.h ?? new Set(cal.holidays);
  const w = sets?.w ?? new Set(cal.workingDays);
  if (w.has(iso)) return true;
  if (h.has(iso)) return false;
  return (cal.workWeek & (1 << weekdayOf(day))) !== 0;
}
