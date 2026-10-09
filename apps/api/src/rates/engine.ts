// Rate analysis costing (docs/04-features.md E2). Pure: definitions and resource rates in, costs out.
//
//   line cost   = quantity × (1 + wastage %) × unit cost    (resource rate on the date, or a sub-analysis' unit rate)
//                 or a lump sum
//   subtotal    = Σ line costs                               for `output_qty` units of the item
//   additions   = percentages applied in order on the running total (water 1 %, then profit and overheads 15 %)
//   unit rate   = total ÷ output_qty
//
// A resource without a rate on the date costs nothing and is reported in `missing`, so a half-priced analysis is
// visible rather than silently cheap. Sub-analyses nest up to MAX_NESTING deep and may not form a cycle.
import { add, dec, div, fmt, mul, pctOf, plusPct, ZERO, type Dec } from './decimal.js';

export type ResourceKind = 'material' | 'labour' | 'equipment' | 'subcontract' | 'other';
export const RESOURCE_KINDS: ResourceKind[] = [
  'material',
  'labour',
  'equipment',
  'subcontract',
  'other',
];
export const MAX_NESTING = 10;

export interface ResourceInfo {
  id: string;
  code: string;
  name: string;
  kind: ResourceKind;
  unit: string;
  /** Rate on the costing date, or null when the resource has no rate yet on that date. */
  rate: string | null;
}

export interface LineDef {
  lineNo: number;
  kind: 'resource' | 'analysis' | 'lump_sum';
  resourceId: string | null;
  subAnalysisId: string | null;
  description: string;
  qty: string;
  wastagePct: string;
  amount: string | null;
}

export interface Addition {
  label: string;
  pct: string;
}

export interface AnalysisDef {
  id: string;
  code: string;
  description: string;
  unit: string;
  outputQty: string;
  additions: Addition[];
  lines: LineDef[];
}

export interface Costing {
  /** Per unit of the item, 4 decimals (what the analysis shows) and 2 decimals (what goes into a BOQ). */
  unitRate: string;
  boqRate: string;
  /** For output_qty units. */
  subtotal: string;
  total: string;
  lines: { lineNo: number; unitCost: string | null; cost: string }[];
  additions: { label: string; pct: string; amount: string }[];
  /** Per unit of the item: what the line costs are made of, by resource kind (lump sums count as "other"). */
  byKind: Record<ResourceKind, string>;
  /** Per unit of the item: the additions. */
  additionsPerUnit: string;
  /** Resources without a rate on the date, anywhere in the tree. */
  missing: { id: string; code: string; name: string }[];
}

export class CycleError extends Error {
  constructor(readonly path: string[]) {
    super(`Analyses refer to each other: ${path.join(' → ')}`);
  }
}
export class TooDeepError extends Error {
  constructor(readonly path: string[]) {
    super(`Sub-analyses nest deeper than ${MAX_NESTING} levels: ${path.join(' → ')}`);
  }
}

interface Raw {
  unitRate: Dec;
  byKind: Record<ResourceKind, Dec>; // per unit
  additions: Dec; // per unit
  missing: Map<string, { id: string; code: string; name: string }>;
  lines: { lineNo: number; unitCost: Dec | null; cost: Dec }[];
  addRows: { label: string; pct: string; amount: Dec }[];
  subtotal: Dec;
  total: Dec;
}

const emptyKinds = (): Record<ResourceKind, Dec> => ({
  material: ZERO,
  labour: ZERO,
  equipment: ZERO,
  subcontract: ZERO,
  other: ZERO,
});

export class CostingEngine {
  private readonly memo = new Map<string, Raw>();

  constructor(
    private readonly analyses: Map<string, AnalysisDef>,
    private readonly resources: Map<string, ResourceInfo>,
  ) {}

  hasResource = (id: string) => this.resources.has(id);
  hasAnalysis = (id: string) => this.analyses.has(id);

  cost(id: string): Costing {
    const r = this.raw(id, []);
    return {
      unitRate: fmt(r.unitRate, 4),
      boqRate: fmt(r.unitRate, 2),
      subtotal: fmt(r.subtotal, 2),
      total: fmt(r.total, 2),
      lines: r.lines.map((l) => ({
        lineNo: l.lineNo,
        unitCost: l.unitCost === null ? null : fmt(l.unitCost, 4),
        cost: fmt(l.cost, 2),
      })),
      additions: r.addRows.map((x) => ({ label: x.label, pct: x.pct, amount: fmt(x.amount, 2) })),
      byKind: Object.fromEntries(
        Object.entries(r.byKind).map(([k, v]) => [k, fmt(v, 4)]),
      ) as Record<ResourceKind, string>,
      additionsPerUnit: fmt(r.additions, 4),
      missing: [...r.missing.values()],
    };
  }

  /** `path` holds the analyses being costed above this one (ids), to detect cycles and excessive nesting. */
  private raw(id: string, path: string[]): Raw {
    const a = this.analyses.get(id);
    if (!a) throw new Error(`analysis not loaded: ${id}`);
    const codes = () => [...path, id].map((x) => this.analyses.get(x)?.code ?? x);
    if (path.includes(id)) throw new CycleError(codes());
    if (path.length > MAX_NESTING) throw new TooDeepError(codes());
    const hit = this.memo.get(id);
    if (hit) return hit;
    const here = [...path, id];

    const outputQty = dec(a.outputQty);
    const kinds = emptyKinds();
    const missing = new Map<string, { id: string; code: string; name: string }>();
    const lines: Raw['lines'] = [];
    let subAdditions = ZERO; // additions inside sub-analyses, for output_qty units
    for (const l of [...a.lines].sort((x, y) => x.lineNo - y.lineNo)) {
      const factor = plusPct(dec(l.qty), dec(l.wastagePct));
      if (l.kind === 'lump_sum') {
        const cost = dec(l.amount ?? '0');
        kinds.other += cost;
        lines.push({ lineNo: l.lineNo, unitCost: null, cost });
      } else if (l.kind === 'resource') {
        const r = this.resources.get(l.resourceId!);
        if (!r) throw new Error(`resource not loaded: ${l.resourceId}`);
        if (r.rate === null) missing.set(r.id, { id: r.id, code: r.code, name: r.name });
        const unitCost = r.rate === null ? ZERO : dec(r.rate);
        const cost = mul(factor, unitCost);
        kinds[r.kind] += cost;
        lines.push({ lineNo: l.lineNo, unitCost: r.rate === null ? null : unitCost, cost });
      } else {
        const sub = this.raw(l.subAnalysisId!, here);
        for (const m of sub.missing.values()) missing.set(m.id, m);
        const cost = mul(factor, sub.unitRate);
        for (const k of Object.keys(kinds) as ResourceKind[])
          kinds[k] += mul(factor, sub.byKind[k]);
        subAdditions += mul(factor, sub.additions);
        lines.push({ lineNo: l.lineNo, unitCost: sub.unitRate, cost });
      }
    }
    const subtotal = add(...lines.map((l) => l.cost));
    let total = subtotal;
    const addRows: Raw['addRows'] = [];
    for (const x of a.additions) {
      const amount = pctOf(total, dec(x.pct));
      addRows.push({ label: x.label, pct: x.pct, amount });
      total += amount;
    }
    const ownAdditions = total - subtotal;
    const result: Raw = {
      unitRate: div(total, outputQty),
      byKind: Object.fromEntries(
        Object.entries(kinds).map(([k, v]) => [k, div(v, outputQty)]),
      ) as Record<ResourceKind, Dec>,
      additions: div(ownAdditions + subAdditions, outputQty),
      missing,
      lines,
      addRows,
      subtotal,
      total,
    };
    this.memo.set(id, result);
    return result;
  }
}
