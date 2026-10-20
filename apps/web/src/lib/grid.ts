// Where a data grid keeps its layout (docs/wave9-plan.md step 9a.5): in the person's own settings on the server, under
// `grid.<id>`, so columns, widths, sort and saved views follow them to any device. Plus small helpers for the plain
// values a grid sorts and exports by.
import type { GridState, GridStorage } from '@aerolith/ui';
import { usePref } from './prefs';

export function useGridStorage(id: string): GridStorage {
  const [value, set] = usePref<GridState | null>(`grid.${id}`, null);
  return { get: () => value ?? undefined, set };
}

/** A 'YYYY-MM-DD' day as a local date, so Excel shows the same day. */
export function day(iso: string | null | undefined): Date | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** An amount the server sends as a decimal string, as a number. */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
