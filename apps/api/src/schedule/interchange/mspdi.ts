// MS Project XML (MSPDI, the public schema MS Project saves as "XML Format"), read and written by our own code
// (docs/04-features.md §X). Durations and lags in the file are in hours or tenths of minutes; here they are whole
// working days, converted with the file's minutes per day. Our activity IDs travel in Text1, named "Activity ID".
import type { ConstraintType, LinkType } from '@aerolith/shared';
import type { Link } from '../programme-model.js';
import type { ProgrammeView } from '../programme.service.js';
import { hoursToDays, type ImportedCalendar, type ImportedPlan } from './imported.js';
import { child, children, escapeXml, parseXml, text, type XmlNode } from './xml.js';

const TEXT1 = '188743731';
/** MSPDI constraint types: 0 as soon as possible, 1 as late as possible, then the six date constraints. */
const CONSTRAINT_IN: Record<string, ConstraintType | null> = {
  '0': null,
  '1': null,
  '2': 'MSO',
  '3': 'MFO',
  '4': 'SNET',
  '5': 'SNLT',
  '6': 'FNET',
  '7': 'FNLT',
};
const CONSTRAINT_OUT: Record<ConstraintType, number> = {
  MSO: 2,
  MFO: 3,
  SNET: 4,
  SNLT: 5,
  FNET: 6,
  FNLT: 7,
};
/** MSPDI link types: 0 finish-to-finish, 1 finish-to-start, 2 start-to-finish, 3 start-to-start. */
const LINK_IN: Record<string, LinkType> = { '0': 'FF', '1': 'FS', '2': 'SF', '3': 'SS' };
const LINK_OUT: Record<LinkType, number> = { FF: 0, FS: 1, SF: 2, SS: 3 };

const dateOf = (s: string) => /^\d{4}-\d{2}-\d{2}/.exec(s)?.[0] ?? null;

/** "PT40H0M0S" (or "PT40H", "P5D") as hours. */
export function durationHours(iso: string): number | null {
  const m =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      iso.trim(),
    );
  if (!m) return null;
  return (
    Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0) + Number(m[3] ?? 0) / 60 + Number(m[4] ?? 0) / 3600
  );
}

/** Every date from `from` to `to` (inclusive), at most `max` of them. */
function datesBetween(from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  for (let t = a; t <= b && out.length < max; t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function readMspdi(xml: string): ImportedPlan {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (err) {
    throw new Error(`This is not a readable XML file (${(err as Error).message}).`, { cause: err });
  }
  if (root.name !== 'Project')
    throw new Error(
      'This XML file is not an MS Project file: save it from MS Project as "XML Format (*.xml)".',
    );
  const warnings: string[] = [];
  const minutesPerDay = Number(text(root, 'MinutesPerDay')) || 480;
  const hoursPerDay = minutesPerDay / 60;

  // Calendars: base calendars first, then derived ones laid over their base.
  const raw = children(child(root, 'Calendars'), 'Calendar');
  const byUid = new Map(raw.map((c) => [text(c, 'UID'), c]));
  const resolved = new Map<string, ImportedCalendar>();
  const resolve = (uid: string, depth = 0): ImportedCalendar | null => {
    const done = resolved.get(uid);
    if (done) return done;
    const c = byUid.get(uid);
    if (!c || depth > 5) return null;
    const baseUid = text(c, 'BaseCalendarUID');
    const base = baseUid && baseUid !== '-1' ? resolve(baseUid, depth + 1) : null;
    let week = base?.workWeek ?? 0b0011111;
    const holidays = new Set(base?.holidays ?? []);
    const working = new Set(base?.workingDays ?? []);
    const exception = (e: XmlNode, isWorking: boolean) => {
      const tp = child(e, 'TimePeriod');
      const from = dateOf(text(tp, 'FromDate'));
      const to = dateOf(text(tp, 'ToDate')) ?? from;
      if (!from || !to) return;
      for (const d of datesBetween(from, to)) (isWorking ? working : holidays).add(d);
    };
    for (const wd of children(child(c, 'WeekDays'), 'WeekDay')) {
      const type = Number(text(wd, 'DayType'));
      const isWorking = text(wd, 'DayWorking') === '1';
      if (type >= 1 && type <= 7) {
        const bit = 1 << ((type + 5) % 7); // DayType 1 is Sunday; our bit 0 is Monday
        week = isWorking ? week | bit : week & ~bit;
      } else if (type === 0) exception(wd, isWorking);
    }
    for (const e of children(child(c, 'Exceptions'), 'Exception'))
      exception(e, text(e, 'DayWorking') === '1');
    const cal: ImportedCalendar = {
      key: uid,
      name: (text(c, 'Name') || `Calendar ${uid}`).slice(0, 100),
      workWeek: week,
      holidays: [...holidays].sort(),
      workingDays: [...working].sort(),
    };
    resolved.set(uid, cal);
    return cal;
  };

  const projectCal = text(root, 'CalendarUID');
  const usesText1AsId = children(child(root, 'ExtendedAttributes'), 'ExtendedAttribute').some(
    (x) => text(x, 'FieldID') === TEXT1 && /activity id/i.test(text(x, 'Alias')),
  );

  const activities: ImportedPlan['activities'] = [];
  const links: ImportedPlan['links'] = [];
  const stack: { level: number; key: string }[] = [];
  const usedCals = new Set<string>();
  let alap = 0;
  for (const t of children(child(root, 'Tasks'), 'Task')) {
    const uid = text(t, 'UID');
    const level = Number(text(t, 'OutlineLevel') || '1');
    if (text(t, 'IsNull') === '1' || uid === '0' || level < 1) continue; // blank rows and the project's own row
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    const parentKey = stack.at(-1)?.key ?? null;
    stack.push({ level, key: uid });
    const name = text(t, 'Name');
    const id = text(t, 'ID') || uid;
    const text1 = children(t, 'ExtendedAttribute').find((x) => text(x, 'FieldID') === TEXT1);
    const code = (usesText1AsId && text1 ? text(text1, 'Value') : '') || id;
    const milestone = text(t, 'Milestone') === '1';
    const hours = durationHours(text(t, 'Duration')) ?? 0;
    const ctype = CONSTRAINT_IN[text(t, 'ConstraintType') || '0'] ?? null;
    if (text(t, 'ConstraintType') === '1') alap++;
    const cdate = dateOf(text(t, 'ConstraintDate'));
    const calUid = text(t, 'CalendarUID');
    const calendarKey = calUid && calUid !== '-1' ? calUid : null;
    if (calendarKey) usedCals.add(calendarKey);
    activities.push({
      key: uid,
      parentKey,
      code,
      name: name || '(no name)',
      duration: milestone ? 0 : hoursToDays(hours, hoursPerDay, `${code} ${name}`, warnings),
      summary: text(t, 'Summary') === '1',
      calendarKey,
      constraint: ctype && cdate ? { type: ctype, date: cdate } : null,
    });
    for (const pl of children(t, 'PredecessorLink')) {
      const type = LINK_IN[text(pl, 'Type') || '1'] ?? 'FS';
      const fmt = text(pl, 'LagFormat');
      let lag = (Number(text(pl, 'LinkLag')) || 0) / 10 / minutesPerDay;
      if (fmt === '19' || fmt === '20') {
        warnings.push(`A link into ${code} has a lag in percent; it was set to no lag.`);
        lag = 0;
      }
      if (text(pl, 'CrossProject') === '1') {
        warnings.push(`A link into ${code} comes from another project; it was left out.`);
        continue;
      }
      links.push({ pred: text(pl, 'PredecessorUID'), succ: uid, type, lag: Math.round(lag) });
    }
  }
  if (alap)
    warnings.push(
      `${alap} activities were "as late as possible"; here they are scheduled as early as possible.`,
    );

  const calendarKeys = [projectCal, ...usedCals].filter((k) => k && byUid.has(k));
  const calendars = [...new Set(calendarKeys)].map((k) => resolve(k)).filter((c) => c !== null);
  if (!projectCal || !byUid.has(projectCal))
    warnings.push('The file names no project calendar; Mon–Fri is used.');
  return {
    format: 'mspdi',
    name: (text(root, 'Title') || text(root, 'Name') || 'Imported programme')
      .replace(/\.xml$/i, '')
      .slice(0, 200),
    startOn: dateOf(text(root, 'StartDate')) ?? new Date().toISOString().slice(0, 10),
    calendars,
    defaultCalendarKey: projectCal && byUid.has(projectCal) ? projectCal : null,
    activities,
    links,
    fileFinish: dateOf(text(root, 'FinishDate')),
    warnings,
  };
}

// --- writing ---

const WORK_TIMES =
  '<WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>' +
  '<WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes>';

/** The programme as MS Project XML: 8-hour days, our calendars, rows with their outline levels, links and lags. */
export function writeMspdi(p: ProgrammeView): string {
  const calUid = new Map(p.calendars.map((c, i) => [c.id, i + 1]));
  const rowUid = new Map(p.activities.map((a, i) => [a.id, i + 1]));
  const out: string[] = [];
  const el = (name: string, value: string | number) =>
    `<${name}>${escapeXml(String(value))}</${name}>`;
  const workDays = (bits: number) => [0, 1, 2, 3, 4, 5, 6].filter((d) => bits & (1 << d)).length;
  const def = p.calendars.find((c) => c.id === p.calendarId);
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<Project xmlns="http://schemas.microsoft.com/project">');
  out.push(el('SaveVersion', 14), el('Name', `${p.name}.xml`), el('Title', p.name));
  out.push(el('ScheduleFromStart', 1), el('StartDate', `${p.startOn}T08:00:00`));
  if (p.finishOn) out.push(el('FinishDate', `${p.finishOn}T17:00:00`));
  out.push(el('CalendarUID', calUid.get(p.calendarId) ?? 1));
  out.push(el('DefaultStartTime', '08:00:00'), el('DefaultFinishTime', '17:00:00'));
  out.push(
    el('MinutesPerDay', 480),
    el('MinutesPerWeek', 480 * (def ? workDays(def.workWeek) : 5)),
  );
  out.push(el('DaysPerMonth', 26), el('DurationFormat', 7));
  out.push(
    `<ExtendedAttributes><ExtendedAttribute>${el('FieldID', TEXT1)}${el('FieldName', 'Text1')}${el('Alias', 'Activity ID')}</ExtendedAttribute></ExtendedAttributes>`,
  );
  out.push('<Calendars>');
  for (const c of p.calendars) {
    out.push(
      `<Calendar>${el('UID', calUid.get(c.id)!)}${el('Name', c.name)}${el('IsBaseCalendar', 1)}${el('BaseCalendarUID', -1)}<WeekDays>`,
    );
    for (let type = 1; type <= 7; type++) {
      const working = (c.workWeek & (1 << ((type + 5) % 7))) !== 0;
      out.push(
        `<WeekDay>${el('DayType', type)}${el('DayWorking', working ? 1 : 0)}${working ? WORK_TIMES : ''}</WeekDay>`,
      );
    }
    for (const [days, working] of [
      [c.holidays, false],
      [c.workingDays, true],
    ] as const)
      for (const d of days)
        out.push(
          `<WeekDay>${el('DayType', 0)}${el('DayWorking', working ? 1 : 0)}<TimePeriod>${el('FromDate', `${d}T00:00:00`)}${el('ToDate', `${d}T23:59:00`)}</TimePeriod>${working ? WORK_TIMES : ''}</WeekDay>`,
        );
    out.push('</WeekDays></Calendar>');
  }
  out.push('</Calendars><Tasks>');
  const preds = new Map<string, Link[]>();
  for (const l of p.links) preds.set(l.succ, [...(preds.get(l.succ) ?? []), l]);
  p.activities.forEach((a, i) => {
    const t: string[] = [
      el('UID', i + 1),
      el('ID', i + 1),
      el('Name', a.name),
      el('Type', 0),
      el('IsNull', 0),
      el('OutlineLevel', a.depth + 1),
    ];
    if (a.earlyStart) t.push(el('Start', `${a.earlyStart}T08:00:00`));
    if (a.earlyFinish)
      t.push(el('Finish', `${a.earlyFinish}T${a.kind === 'milestone' ? '08:00:00' : '17:00:00'}`));
    t.push(el('Duration', `PT${a.duration * 8}H0M0S`), el('DurationFormat', 7));
    t.push(
      el('Milestone', a.kind === 'milestone' ? 1 : 0),
      el('Summary', a.kind === 'summary' ? 1 : 0),
    );
    t.push(el('ConstraintType', a.constraintType ? CONSTRAINT_OUT[a.constraintType] : 0));
    t.push(el('CalendarUID', a.calendarId ? (calUid.get(a.calendarId) ?? -1) : -1));
    if (a.constraintType && a.constraintDate)
      t.push(
        el(
          'ConstraintDate',
          `${a.constraintDate}T${/^F/.test(a.constraintType) || a.constraintType === 'MFO' ? '17' : '08'}:00:00`,
        ),
      );
    if (a.notes) t.push(el('Notes', a.notes));
    for (const l of preds.get(a.id) ?? [])
      t.push(
        `<PredecessorLink>${el('PredecessorUID', rowUid.get(l.pred)!)}${el('Type', LINK_OUT[l.type])}${el('CrossProject', 0)}${el('LinkLag', l.lag * 480 * 10)}${el('LagFormat', 7)}</PredecessorLink>`,
      );
    t.push(`<ExtendedAttribute>${el('FieldID', TEXT1)}${el('Value', a.code)}</ExtendedAttribute>`);
    out.push(`<Task>${t.join('')}</Task>`);
  });
  out.push('</Tasks></Project>');
  return out.join('\n');
}
