// HR's rules worked exactly (docs/wave3-plan.md step 11): working days by a calendar, leave accrued in a year, a
// biometric device's punches made into days, and how far a phone was from its site. Pure: the services bring the rows.
import { BadRequestException } from '@nestjs/common';
import { readDate } from '../accounts/bank-parse.js';
import { addDays } from '../accounts/depreciation.js';

/** Four hours or more between the first punch and the last is a full day; less is a half day. */
export const FULL_DAY_HOURS = 4;
/** A site with a location but no radius: within this many metres is at the site. */
export const DEFAULT_RADIUS_M = 200;

/** Monday = 1, Tuesday = 2 … Sunday = 64 (as the programme's calendars). */
export function weekdayBit(day: string) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // Sunday 0
  return 1 << (dow === 0 ? 6 : dow - 1);
}

export type DayKind = 'work' | 'holiday' | 'week_off';
export function dayKind(day: string, workWeek: number, holidays: ReadonlySet<string>): DayKind {
  if (holidays.has(day)) return 'holiday';
  return workWeek & weekdayBit(day) ? 'work' : 'week_off';
}

export function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const halfDown = (x: number) => Math.floor(x * 2 + 1e-9) / 2;

/**
 * Leave a type gives in a calendar year up to a date: credited whole on 1 January (or on joining, for the months
 * left), or a twelfth on the first of each month in service; rounded down to a half day.
 */
export function accrued(
  type: { daysPerYear: string; accrual: 'annual' | 'monthly' },
  year: number,
  joinedOn: string,
  asOf: string,
) {
  const perYear = Number(type.daysPerYear);
  const yearStart = `${year}-01-01`;
  if (asOf < yearStart || joinedOn > `${year}-12-31` || joinedOn > asOf) return 0;
  // The first month in service this year (1–12).
  const firstMonth = joinedOn < yearStart ? 1 : Number(joinedOn.slice(5, 7));
  if (type.accrual === 'annual') return halfDown((perYear * (13 - firstMonth)) / 12);
  const lastMonth = asOf > `${year}-12-31` ? 12 : Number(asOf.slice(5, 7));
  return halfDown((perYear * Math.max(0, lastMonth - firstMonth + 1)) / 12);
}

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export interface PunchDay {
  code: string;
  day: string;
  /** India's times, HH:MM. */
  first: string;
  last: string;
  punches: number;
  status: 'present' | 'half_day';
  flag: 'single_punch' | null;
}

const bad = (message: string) => new BadRequestException({ code: 'bad_attendance_file', message });

function readTime(v: string) {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(v.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[4].toUpperCase() === 'PM' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * A device's export: a header row naming the employee code, the date and the time (or one date-and-time column),
 * then a row per punch. Dates as DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD. Each employee's day: first punch in, last out.
 */
export function punchDays(rows: string[][]): { days: PunchDay[]; skipped: number[] } {
  const headerAt = rows.findIndex((r) => r.some((c) => /code|emp/i.test(c)));
  if (headerAt < 0) throw bad('No header row naming the employee code.');
  const head = rows[headerAt]!.map((c) => c.trim().toLowerCase());
  const col = (re: RegExp, not?: RegExp) =>
    head.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const code = col(/code/) >= 0 ? col(/code/) : col(/emp|id/, /name/);
  const date = col(/date/, /time/);
  const time = col(/time/, /date/);
  const both = date >= 0 && time >= 0 ? -1 : col(/date.*time|time.*date|punch|log/);
  if (both < 0 && (date < 0 || time < 0))
    throw bad('The file needs columns for the employee code, the date and the time.');
  const byDay = new Map<string, { code: string; day: string; times: string[] }>();
  const skipped: number[] = [];
  const spelling = new Map<string, string>();
  for (const [i, r] of rows.entries()) {
    if (i <= headerAt || r.every((c) => !c.trim())) continue;
    const c = (r[code] ?? '').trim();
    const dateText = both >= 0 ? (r[both] ?? '') : (r[date] ?? '');
    const timeText = both >= 0 ? (r[both] ?? '').trim().replace(/^\S+\s+/, '') : (r[time] ?? '');
    const d = readDate(dateText.trim().split(/\s+/)[0] ?? '', 'DD/MM/YYYY');
    const t = readTime(timeText);
    if (!c || !d || !t) {
      skipped.push(i + 1);
      continue;
    }
    const key = `${c.toLowerCase()}|${d}`;
    if (!spelling.has(c.toLowerCase())) spelling.set(c.toLowerCase(), c);
    const e = byDay.get(key) ?? { code: spelling.get(c.toLowerCase())!, day: d, times: [] };
    e.times.push(t);
    byDay.set(key, e);
  }
  const days = [...byDay.values()].map((e) => {
    const times = [...new Set(e.times)].sort();
    const first = times[0]!;
    const last = times[times.length - 1]!;
    const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const single = times.length === 1;
    const full = single || minutes(last) - minutes(first) >= FULL_DAY_HOURS * 60;
    return {
      code: e.code,
      day: e.day,
      first,
      last,
      punches: times.length,
      status: full ? ('present' as const) : ('half_day' as const),
      flag: single ? ('single_punch' as const) : null,
    };
  });
  days.sort((a, b) =>
    a.code.toLowerCase() < b.code.toLowerCase()
      ? -1
      : a.code.toLowerCase() > b.code.toLowerCase()
        ? 1
        : a.day.localeCompare(b.day),
  );
  return { days, skipped };
}

/** A PAN, checked by its shape (five letters, four digits, a letter). */
export const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
/** What someone without `hr.edit` sees of a number: its last four characters. */
export const mask = (v: string | null) =>
  v ? `${'•'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}` : null;
