// Primavera P6 XER, read and written by our own code from the file's public structure (docs/04-features.md §X):
// tab-separated tables (%T name, %F fields, %R rows). Read: the project, its calendars (P6's nested clndr_data text),
// the WBS as summary rows, activities and relationships. Durations and lags are hours in the file and whole working
// days here, by the calendar's hours per day. Progress (actual dates) is not carried over; original durations are.
import type { ConstraintType, LinkType } from '@aerolith/shared';
import type { ProgrammeView } from '../programme.service.js';
import { hoursToDays, type ImportedCalendar, type ImportedPlan } from './imported.js';

type Row = Record<string, string>;

/** The tables of an XER file, by name, each row by field name. */
export function xerTables(content: string): Map<string, Row[]> {
  const tables = new Map<string, Row[]>();
  let fields: string[] = [];
  let rows: Row[] | null = null;
  for (const line of content.split(/\r?\n/)) {
    const cells = line.split('\t');
    if (cells[0] === '%T') {
      rows = [];
      tables.set(cells[1]!.trim(), rows);
    } else if (cells[0] === '%F') fields = cells.slice(1).map((f) => f.trim());
    else if (cells[0] === '%R' && rows)
      rows.push(Object.fromEntries(fields.map((f, i) => [f, cells[i + 1] ?? ''])));
  }
  return tables;
}

// P6 keeps a calendar as nested text: (0||DaysOfWeek()( (0||1()( (0||0(s|08:00|f|17:00)()) )) … ))
interface CalNode {
  name: string;
  attrs: string[];
  children: CalNode[];
}

export function parseClndrData(data: string): CalNode[] {
  let i = 0;
  const s = data.replace(/\x7f\x7f/g, '');
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const node = (): CalNode | null => {
    ws();
    if (s[i] !== '(') return null;
    i++; // (
    const head = s.indexOf('||', i);
    const open = s.indexOf('(', head);
    if (head < 0 || open < 0) throw new Error('calendar text');
    const name = s.slice(head + 2, open).trim();
    const close = s.indexOf(')', open);
    const attrs = s
      .slice(open + 1, close)
      .split('|')
      .filter(Boolean);
    i = close + 1;
    ws();
    const kids: CalNode[] = [];
    if (s[i] === '(') {
      i++; // children list
      for (;;) {
        ws();
        if (s[i] === ')') {
          i++;
          break;
        }
        const k = node();
        if (!k) throw new Error('calendar text');
        kids.push(k);
      }
    }
    ws();
    if (s[i] === ')') i++;
    return { name, attrs, children: kids };
  };
  const out: CalNode[] = [];
  for (;;) {
    const n = node();
    if (!n) break;
    out.push(n);
  }
  return out;
}

/** P6's day numbers in calendars count from 30 December 1899, like spreadsheets. */
const serialToIso = (n: number) =>
  new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
const isoToSerial = (iso: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
const find = (nodes: CalNode[], name: string): CalNode | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n;
    const k = find(n.children, name);
    if (k) return k;
  }
  return undefined;
};
const hasTimes = (n: CalNode) => n.children.some((c) => c.attrs.includes('s'));

export function readCalendar(
  row: Row,
  warnings: string[],
): ImportedCalendar & { hoursPerDay: number } {
  let week = 0b0011111;
  const holidays: string[] = [];
  const workingDays: string[] = [];
  try {
    const tree = parseClndrData(row.clndr_data ?? '');
    const days = find(tree, 'DaysOfWeek');
    if (days) {
      week = 0;
      for (const d of days.children) {
        const n = Number(d.name); // 1 is Sunday
        if (n >= 1 && n <= 7 && hasTimes(d)) week |= 1 << ((n + 5) % 7);
      }
    }
    for (const e of find(tree, 'Exceptions')?.children ?? []) {
      const at = e.attrs.indexOf('d');
      const serial = at >= 0 ? Number(e.attrs[at + 1]) : NaN;
      if (!Number.isFinite(serial)) continue;
      (hasTimes(e) ? workingDays : holidays).push(serialToIso(serial));
    }
  } catch {
    warnings.push(
      `Calendar "${row.clndr_name}" could not be read; Mon–Fri without holidays is used.`,
    );
  }
  return {
    key: row.clndr_id!,
    name: (row.clndr_name || `Calendar ${row.clndr_id}`).slice(0, 100),
    workWeek: week,
    holidays: holidays.sort(),
    workingDays: workingDays.sort(),
    hoursPerDay: Number(row.day_hr_cnt) || 8,
  };
}

const CONSTRAINT_IN: Record<string, ConstraintType> = {
  CS_MSO: 'MSO',
  CS_MANDSTART: 'MSO',
  CS_MEO: 'MFO',
  CS_MANDFIN: 'MFO',
  CS_MSOA: 'SNET',
  CS_MSOB: 'SNLT',
  CS_MEOA: 'FNET',
  CS_MEOB: 'FNLT',
};
const CONSTRAINT_OUT: Record<ConstraintType, string> = {
  MSO: 'CS_MSO',
  MFO: 'CS_MEO',
  SNET: 'CS_MSOA',
  SNLT: 'CS_MSOB',
  FNET: 'CS_MEOA',
  FNLT: 'CS_MEOB',
};
const LINK_IN: Record<string, LinkType> = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };
const dateOf = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.exec(s)?.[0]) || null;

export function readXer(content: string): ImportedPlan {
  if (!content.startsWith('ERMHDR'))
    throw new Error(
      'This is not a Primavera XER file: export it from P6 as "Primavera PM/EPPM (XER)".',
    );
  const t = xerTables(content);
  const warnings: string[] = [];
  const projects = t.get('PROJECT') ?? [];
  const project = projects[0];
  if (!project) throw new Error('The XER file holds no project.');
  if (projects.length > 1)
    warnings.push(
      `The file holds ${projects.length} projects; the first, ${project.proj_short_name}, was imported.`,
    );
  const projId = project.proj_id!;

  const tasks = (t.get('TASK') ?? []).filter((x) => x.proj_id === projId);
  const calRows = new Map((t.get('CALENDAR') ?? []).map((c) => [c.clndr_id!, c]));
  const used = new Set(
    [project.clndr_id ?? '', ...tasks.map((x) => x.clndr_id ?? '')].filter((k) => calRows.has(k)),
  );
  const calendars = [...used].map((k) => readCalendar(calRows.get(k)!, warnings));
  const hoursOf = new Map(calendars.map((c) => [c.key, c.hoursPerDay]));
  const defaultCal =
    project.clndr_id && calRows.has(project.clndr_id)
      ? project.clndr_id
      : (calendars[0]?.key ?? null);
  const hoursFor = (clndr: string | undefined) =>
    hoursOf.get(clndr ?? '') ?? hoursOf.get(defaultCal ?? '') ?? 8;

  // The WBS as summary rows, in P6's order; the project's own node is the top level.
  const wbs = (t.get('PROJWBS') ?? []).filter((w) => w.proj_id === projId);
  const root = wbs.find((w) => w.proj_node_flag === 'Y')?.wbs_id ?? null;
  const kids = new Map<string | null, Row[]>();
  for (const w of wbs) {
    if (w.wbs_id === root) continue;
    const parent = w.parent_wbs_id === root ? null : (w.parent_wbs_id ?? null);
    kids.set(parent, [...(kids.get(parent) ?? []), w]);
  }
  for (const list of kids.values()) list.sort((a, b) => Number(a.seq_num) - Number(b.seq_num));
  const tasksIn = new Map<string | null, Row[]>();
  for (const x of tasks) {
    const w = x.wbs_id === root || !wbs.some((b) => b.wbs_id === x.wbs_id) ? null : x.wbs_id!;
    tasksIn.set(w, [...(tasksIn.get(w) ?? []), x]);
  }

  const activities: ImportedPlan['activities'] = [];
  let progress = 0;
  const addTask = (x: Row, parentKey: string | null) => {
    const code = x.task_code || x.task_id!;
    const type = x.task_type ?? 'TT_Task';
    if (type === 'TT_LOE' || type === 'TT_WBS')
      warnings.push(
        `${code} is a ${type === 'TT_LOE' ? 'level-of-effort' : 'WBS summary'} activity in P6; here it is an ordinary task.`,
      );
    if (x.act_start_date || x.status_code === 'TK_Complete' || x.status_code === 'TK_Active')
      progress++;
    const milestone = type === 'TT_Mile' || type === 'TT_FinMile';
    const cstr = CONSTRAINT_IN[x.cstr_type ?? ''] ?? null;
    if (x.cstr_type === 'CS_ALAP')
      warnings.push(`${code} is "as late as possible" in P6; here it is as early as possible.`);
    const cdate = dateOf(x.cstr_date);
    activities.push({
      key: `task:${x.task_id}`,
      parentKey,
      code,
      name: x.task_name || '(no name)',
      duration: milestone
        ? 0
        : hoursToDays(
            Number(x.target_drtn_hr_cnt) || 0,
            hoursFor(x.clndr_id),
            `${code} ${x.task_name}`,
            warnings,
          ),
      summary: false,
      calendarKey:
        x.clndr_id && x.clndr_id !== defaultCal && hoursOf.has(x.clndr_id) ? x.clndr_id : null,
      constraint: cstr && cdate ? { type: cstr, date: cdate } : null,
    });
  };
  const walk = (wbsId: string | null, parentKey: string | null, path: string[]) => {
    for (const x of tasksIn.get(wbsId) ?? []) addTask(x, parentKey);
    for (const w of kids.get(wbsId) ?? []) {
      const p = [...path, w.wbs_short_name || w.wbs_id!];
      const key = `wbs:${w.wbs_id}`;
      activities.push({
        key,
        parentKey,
        code: p.join('.'),
        name: w.wbs_name || w.wbs_short_name || '(WBS)',
        duration: 0,
        summary: true,
        calendarKey: null,
        constraint: null,
      });
      walk(w.wbs_id!, key, p);
    }
  };
  walk(null, null, []);
  if (progress)
    warnings.push(
      `${progress} activities have progress in P6; progress is not imported, so their original durations were used.`,
    );

  const known = new Set(tasks.map((x) => x.task_id));
  const links: ImportedPlan['links'] = [];
  for (const r of t.get('TASKPRED') ?? []) {
    if (!known.has(r.task_id) || !known.has(r.pred_task_id)) continue;
    const succ = tasks.find((x) => x.task_id === r.task_id)!;
    links.push({
      pred: `task:${r.pred_task_id}`,
      succ: `task:${r.task_id}`,
      type: LINK_IN[r.pred_type ?? 'PR_FS'] ?? 'FS',
      lag: Math.round((Number(r.lag_hr_cnt) || 0) / hoursFor(succ.clndr_id)),
    });
  }
  const finishes = tasks
    .map((x) => dateOf(x.early_end_date) ?? dateOf(x.target_end_date))
    .filter((d) => d !== null);
  return {
    format: 'xer',
    name: (project.proj_short_name || 'Imported programme').slice(0, 200),
    startOn:
      dateOf(project.last_recalc_date) ??
      dateOf(project.plan_start_date) ??
      new Date().toISOString().slice(0, 10),
    calendars: calendars.map(({ hoursPerDay: _h, ...c }) => c),
    defaultCalendarKey: defaultCal,
    activities,
    links,
    fileFinish: dateOf(project.scd_end_date) ?? (finishes.length ? finishes.sort().at(-1)! : null),
    warnings,
  };
}

// --- writing ---

const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ');

function clndrData(c: ProgrammeView['calendars'][number]): string {
  const times = '(0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())';
  const days = [1, 2, 3, 4, 5, 6, 7]
    .map((n) => `(0||${n}()(${(c.workWeek & (1 << ((n + 5) % 7))) !== 0 ? times : ''}))`)
    .join('');
  const ex = [
    ...c.holidays.map((d, i) => `(0||${i}(d|${isoToSerial(d)})())`),
    ...c.workingDays.map((d, i) => `(0||${c.holidays.length + i}(d|${isoToSerial(d)})(${times}))`),
  ].join('');
  return `(0||CalendarData()((0||DaysOfWeek()(${days}))(0||VIEW(ShowTotal|Y)())(0||Exceptions()(${ex}))))`;
}

/**
 * The programme as an XER file: the project, its calendars, summaries as WBS nodes, activities and relationships,
 * with 8-hour days. [Guessing] P6 imports a file with only these tables; it is checked by reading it back here.
 */
export function writeXer(p: ProgrammeView, now = new Date()): string {
  const lines: string[] = [];
  const table = (name: string, fields: string[], rows: (string | number | null)[][]) => {
    lines.push(`%T\t${name}`, `%F\t${fields.join('\t')}`);
    for (const r of rows)
      lines.push(`%R\t${r.map((v) => (v === null ? '' : clean(String(v)))).join('\t')}`);
  };
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  lines.push(
    `ERMHDR\t19.12\t${stamp.slice(0, 10)}\tProject\tadmin\tAerolith Core\tdbxDatabaseNoName\tProject Management\tINR`,
  );
  const calId = new Map(p.calendars.map((c, i) => [c.id, 1000 + i]));
  const projId = 1;
  table(
    'CALENDAR',
    [
      'clndr_id',
      'default_flag',
      'clndr_name',
      'proj_id',
      'base_clndr_id',
      'last_chng_date',
      'clndr_type',
      'day_hr_cnt',
      'week_hr_cnt',
      'clndr_data',
    ],
    p.calendars.map((c) => [
      calId.get(c.id)!,
      c.id === p.calendarId ? 'Y' : 'N',
      c.name,
      projId,
      null,
      stamp,
      'CA_Project',
      8,
      8 * [0, 1, 2, 3, 4, 5, 6].filter((d) => c.workWeek & (1 << d)).length,
      clndrData(c),
    ]),
  );
  table(
    'PROJECT',
    [
      'proj_id',
      'proj_short_name',
      'clndr_id',
      'plan_start_date',
      'last_recalc_date',
      'scd_end_date',
    ],
    [
      [
        projId,
        p.name,
        calId.get(p.calendarId)!,
        `${p.startOn} 08:00`,
        `${p.startOn} 08:00`,
        p.finishOn ? `${p.finishOn} 17:00` : null,
      ],
    ],
  );
  const rootWbs = 1;
  const wbsId = new Map<string, number>();
  const summaries = p.activities.filter((a) => a.kind === 'summary');
  summaries.forEach((a, i) => wbsId.set(a.id, 100 + i));
  const parentWbs = (parentId: string | null) =>
    parentId ? (wbsId.get(parentId) ?? rootWbs) : rootWbs;
  table(
    'PROJWBS',
    [
      'wbs_id',
      'proj_id',
      'seq_num',
      'proj_node_flag',
      'wbs_short_name',
      'wbs_name',
      'parent_wbs_id',
      'status_code',
    ],
    [
      [rootWbs, projId, 0, 'Y', p.name.slice(0, 40), p.name, null, 'WS_Open'],
      ...summaries.map((a, i) => [
        wbsId.get(a.id)!,
        projId,
        i + 1,
        'N',
        a.code,
        a.name,
        parentWbs(a.parentId),
        'WS_Open',
      ]),
    ],
  );
  const taskId = new Map<string, number>();
  const tasks = p.activities.filter((a) => a.kind !== 'summary');
  tasks.forEach((a, i) => taskId.set(a.id, 10_000 + i));
  const hasPred = new Set(p.links.map((l) => l.succ));
  table(
    'TASK',
    [
      'task_id',
      'proj_id',
      'wbs_id',
      'clndr_id',
      'task_code',
      'task_name',
      'task_type',
      'duration_type',
      'status_code',
      'target_drtn_hr_cnt',
      'remain_drtn_hr_cnt',
      'cstr_type',
      'cstr_date',
      'early_start_date',
      'early_end_date',
      'late_start_date',
      'late_end_date',
      'target_start_date',
      'target_end_date',
      'total_float_hr_cnt',
      'free_float_hr_cnt',
    ],
    tasks.map((a) => [
      taskId.get(a.id)!,
      projId,
      parentWbs(a.parentId),
      calId.get(a.calendarId ?? p.calendarId)!,
      a.code,
      a.name,
      a.kind === 'milestone' ? (hasPred.has(a.id) ? 'TT_FinMile' : 'TT_Mile') : 'TT_Task',
      'DT_FixedDrtn',
      'TK_NotStart',
      a.duration * 8,
      a.duration * 8,
      a.constraintType ? CONSTRAINT_OUT[a.constraintType] : null,
      a.constraintDate ? `${a.constraintDate} 08:00` : null,
      a.earlyStart ? `${a.earlyStart} 08:00` : null,
      a.earlyFinish ? `${a.earlyFinish} 17:00` : null,
      a.lateStart ? `${a.lateStart} 08:00` : null,
      a.lateFinish ? `${a.lateFinish} 17:00` : null,
      a.earlyStart ? `${a.earlyStart} 08:00` : null,
      a.earlyFinish ? `${a.earlyFinish} 17:00` : null,
      a.totalFloat === null ? null : a.totalFloat * 8,
      a.freeFloat === null ? null : a.freeFloat * 8,
    ]),
  );
  table(
    'TASKPRED',
    [
      'task_pred_id',
      'task_id',
      'pred_task_id',
      'proj_id',
      'pred_proj_id',
      'pred_type',
      'lag_hr_cnt',
    ],
    p.links
      .filter((l) => taskId.has(l.pred) && taskId.has(l.succ))
      .map((l, i) => [
        50_000 + i,
        taskId.get(l.succ)!,
        taskId.get(l.pred)!,
        projId,
        projId,
        `PR_${l.type}`,
        l.lag * 8,
      ]),
  );
  lines.push('%E');
  return lines.join('\r\n') + '\r\n';
}
