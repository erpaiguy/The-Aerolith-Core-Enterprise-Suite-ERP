// Contracts' arithmetic (docs/wave4-plan.md step 5): the days an extension of time rests on, counted from the daily
// reports' hindrances, and when reminders fall. Pure.

export interface Hindrance {
  date: string;
  cause: string;
  hours: number;
  account: 'client' | 'contractor' | 'neutral';
}

/** Hours of hindrance on the client's or a neutral account in a day that make it a day lost. */
export const DAY_LOST_HOURS = 4;

/**
 * Days lost: each date whose client and neutral hindrances add up to DAY_LOST_HOURS or more counts once. By cause,
 * a counted day goes to the cause with the most hours that day (the first, on a tie).
 */
export function eotDays(hs: Hindrance[]) {
  const byDate = new Map<string, Map<string, number>>();
  for (const h of hs) {
    if (h.account === 'contractor') continue;
    const d = byDate.get(h.date) ?? new Map<string, number>();
    d.set(h.cause, (d.get(h.cause) ?? 0) + h.hours);
    byDate.set(h.date, d);
  }
  const byCause: Record<string, number> = {};
  const dates: string[] = [];
  for (const [date, causes] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const total = [...causes.values()].reduce((a, x) => a + x, 0);
    if (total < DAY_LOST_HOURS) continue;
    dates.push(date);
    const [top] = [...causes.entries()].sort((a, b) => b[1] - a[1]);
    byCause[top![0]] = (byCause[top![0]] ?? 0) + 1;
  }
  return { days: dates.length, byCause, dates };
}

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Reminder dates `before` days ahead of `due` (09:00 IST), keeping those still to come. */
export function reminderDates(due: string, before: number[], now: Date) {
  return before
    .map((n) => ({ days: n, at: new Date(`${addDays(due, -n)}T09:00:00+05:30`) }))
    .filter((r) => r.at > now);
}

export { addDays };
