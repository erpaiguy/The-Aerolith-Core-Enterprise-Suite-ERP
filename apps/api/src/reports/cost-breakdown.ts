// What a BOQ's value is made of (docs/04-features.md E11, docs/08-dashboard.md §2.4). Pure: item amounts grouped
// by their rate analysis in, amounts by resource kind out.
//
// Each item linked to a rate analysis is split in the proportions that analysis gives on the BOQ's rate date:
// material, labour, equipment, subcontract, other (lump sums), and the analysis' own additions (overheads and
// profit inside the rates). The item's amount is split as it stands, even when its rate was typed over or the
// analysis changed since: the proportions come from the analysis, the money from the BOQ. Items without an
// analysis, or whose analysis gives a zero rate, are "not analysed". Every split is rounded to paise and the
// rounding goes to the additions, so the parts always add up to the BOQ exactly.
import { dec, div, fmt, mul, ZERO, type Dec } from '../rates/decimal.js';
import { RESOURCE_KINDS, type Costing, type ResourceKind } from '../rates/engine.js';

export type BreakdownPart = ResourceKind | 'additions' | 'not_analysed';
export const BREAKDOWN_PARTS: BreakdownPart[] = [...RESOURCE_KINDS, 'additions', 'not_analysed'];

export interface AnalysedGroup {
  /** The rate analysis, or null for items without one. */
  analysisId: string | null;
  /** Σ item amounts, as stored. */
  amount: string;
}

export interface Breakdown {
  total: string;
  parts: { part: BreakdownPart; amount: string; pct: string | null }[];
}

const paise = (d: Dec) => dec(fmt(d, 2));

/**
 * `costOf` gives the analysis' costing per unit, or null when it cannot be costed (a cycle, say); such items count as
 * not analysed.
 */
export function breakdown(
  groups: AnalysedGroup[],
  costOf: (analysisId: string) => Pick<Costing, 'unitRate' | 'byKind'> | null,
): Breakdown {
  const sums = new Map<BreakdownPart, Dec>(BREAKDOWN_PARTS.map((p) => [p, ZERO]));
  const bump = (p: BreakdownPart, d: Dec) => sums.set(p, sums.get(p)! + d);
  let total = ZERO;
  for (const g of groups) {
    const amount = dec(g.amount);
    total += amount;
    const c = g.analysisId ? costOf(g.analysisId) : null;
    const unit = c ? dec(c.unitRate) : ZERO;
    if (!c || unit === ZERO) {
      bump('not_analysed', amount);
      continue;
    }
    let split = ZERO;
    for (const k of RESOURCE_KINDS) {
      const part = paise(div(mul(amount, dec(c.byKind[k])), unit));
      bump(k, part);
      split += part;
    }
    bump('additions', amount - split);
  }
  return {
    total: fmt(total, 2),
    parts: BREAKDOWN_PARTS.map((part) => ({
      part,
      amount: fmt(sums.get(part)!, 2),
      pct: total === ZERO ? null : fmt(div(sums.get(part)! * 100n, total), 2),
    })),
  };
}
