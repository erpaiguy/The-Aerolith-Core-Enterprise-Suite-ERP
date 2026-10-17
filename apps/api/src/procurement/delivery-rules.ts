// Delivery follow-up rules (docs/wave8-plan.md step 8e.2): what has come is set against an order line's instalments
// in date order, so each instalment is received, part received, due, or overdue once its day has passed.
import { dec, fmt } from '../rates/decimal.js';

export type SlotState = 'received' | 'part' | 'due' | 'overdue';

/** Each instalment with what of it has come and its state, given what has come against the line in all. */
export function slotsAgainst(
  slots: { dueOn: string; qty: string }[],
  received: string,
  today: string,
): { dueOn: string; qty: string; came: string; short: string; state: SlotState }[] {
  let left = dec(received);
  return [...slots]
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
    .map((s) => {
      const q = dec(s.qty);
      const came = left >= q ? q : left > 0n ? left : 0n;
      left -= came;
      const short = q - came;
      const state: SlotState =
        short === 0n ? 'received' : s.dueOn < today ? 'overdue' : came > 0n ? 'part' : 'due';
      return { dueOn: s.dueOn, qty: s.qty, came: fmt(came, 4), short: fmt(short, 4), state };
    });
}

/** Whole days from one date (YYYY-MM-DD) to another; null when either is missing. */
export function daysBetween(from: string | null, to: string | null) {
  if (!from || !to) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
