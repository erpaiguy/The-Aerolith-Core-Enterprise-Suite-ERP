// How dates and numbers are written for this person (docs/wave9-plan.md step 9b.1), chosen in Settings and kept on
// this device: dates as 20 Oct 2026, 20/10/2026 or 2026-10-20; amounts in Indian grouping (1,00,000) or international
// (100,000). Every formatter in the app reads these, so a change shows everywhere after the app redraws.
import { load, save } from './storage';

export type DateStyle = 'medium' | 'numeric' | 'iso';
export type NumberStyle = 'indian' | 'international';
export interface Formats {
  date: DateStyle;
  number: NumberStyle;
}

const KEY = 'aerolith.formats';
const DEFAULTS: Formats = { date: 'medium', number: 'indian' };

function read(): Formats {
  try {
    const v = JSON.parse(load(KEY) ?? '{}') as Partial<Formats>;
    return {
      date: v.date === 'numeric' || v.date === 'iso' ? v.date : 'medium',
      number: v.number === 'international' ? 'international' : 'indian',
    };
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export const formats = (): Formats => current;

/** Saves the choice and reloads the app, so every figure on every screen is written the new way. */
export function setFormats(next: Formats) {
  current = next;
  save(KEY, JSON.stringify(next));
  for (const l of listeners) l();
  if (typeof location !== 'undefined' && import.meta.env.MODE !== 'test') location.reload();
}

export function onFormatsChange(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The locale numbers are written in: Indian grouping, or international with the same digits and symbols. */
export const numberLocale = (): string => (current.number === 'indian' ? 'en-IN' : 'en-GB');

/** A calendar date in the chosen style. */
export function dateText(d: Date): string {
  if (current.date === 'iso') {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return d.toLocaleDateString(current.date === 'numeric' ? 'en-GB' : 'en-IN', {
    day: current.date === 'numeric' ? '2-digit' : 'numeric',
    month: current.date === 'numeric' ? '2-digit' : 'short',
    year: 'numeric',
  });
}
