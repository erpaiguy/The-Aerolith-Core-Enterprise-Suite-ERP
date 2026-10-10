// Bid pricing (docs/04-features.md E5) and measurement quantities (E4). Pure, exact decimal arithmetic.
//
//   base       = the BOQ total (quantities × rates, which may already carry overheads from rate analyses)
//   provisional = the provisional sums inside it (fixed by the client: no markups on them)
//   markups    = in order; each a % of (base − provisional) or of the running total, or a fixed amount;
//                discounts reduce
//   before GST = base + markups          ← what the tender committee compares with its estimate
//   GST        = added on top, included in the rates already, or exempt
//   factor     = (before GST − provisional) ÷ (base − provisional)
//                                        ← loads the other items' rates so a submitted item-rate BOQ adds up
import { dec, div, fmt, mul, pctOf, type Dec } from '../rates/decimal.js';

export type MarkupKind =
  'overhead' | 'profit' | 'contingency' | 'escalation' | 'discount' | 'other';
export const MARKUP_KINDS: MarkupKind[] = [
  'overhead',
  'profit',
  'contingency',
  'escalation',
  'discount',
  'other',
];
export type GstMode = 'add' | 'included' | 'exempt';

export interface Markup {
  kind: MarkupKind;
  label: string;
  /** % of the BOQ base, or of the running total (compounding). Ignored for fixed amounts. */
  basis: 'base' | 'running';
  pct?: string | null | undefined;
  amount?: string | null | undefined;
}

export interface ScenarioInput {
  markups: Markup[];
  gstPct: string;
  gstMode: GstMode;
}

export interface Priced {
  base: string;
  /** Provisional sums inside the base: they take no markups and are not loaded. */
  provisional: string;
  markups: { kind: MarkupKind; label: string; basis: string; pct: string | null; amount: string }[];
  markupTotal: string;
  beforeGst: string;
  gst: string;
  /** GST contained in the value when rates already include it (for information). */
  gstIncluded: string | null;
  bid: string;
  /** before GST ÷ base, 6 decimals; 1 when the base is 0. */
  factor: string;
  /** Percent above (+) or below (−) the client's estimate, before GST; null without an estimate. */
  vsEstimatePct: string | null;
}

const money = (d: Dec) => dec(fmt(d, 2)); // rounded to paise, half away from zero

export function priceBid(
  baseText: string,
  s: ScenarioInput,
  estimate?: string | null,
  provisionalText = '0',
): Priced {
  const total = dec(baseText);
  const ps = dec(provisionalText);
  const base = total - ps; // what markups apply to
  let running = base;
  const markups: Priced['markups'] = [];
  for (const m of s.markups) {
    let amt =
      m.amount !== undefined && m.amount !== null && m.amount !== ''
        ? money(dec(m.amount))
        : money(pctOf(m.basis === 'running' ? running : base, dec(m.pct ?? '0')));
    if (m.kind === 'discount' && amt > 0n) amt = -amt;
    running += amt;
    markups.push({
      kind: m.kind,
      label: m.label,
      basis: m.basis,
      pct: m.amount ? null : (m.pct ?? '0'),
      amount: fmt(amt, 2),
    });
  }
  const beforeGst = running + ps;
  const gstPct = dec(s.gstPct);
  const gst = s.gstMode === 'add' ? money(pctOf(beforeGst, gstPct)) : 0n;
  const gstIncluded =
    s.gstMode === 'included' && gstPct > 0n
      ? fmt(div(mul(beforeGst, gstPct), gstPct + dec('100')), 2)
      : null;
  const est = estimate ? dec(estimate) : 0n;
  return {
    base: fmt(total, 2),
    provisional: fmt(ps, 2),
    markups,
    markupTotal: fmt(running - base, 2),
    beforeGst: fmt(beforeGst, 2),
    gst: fmt(gst, 2),
    gstIncluded,
    bid: fmt(beforeGst + gst, 2),
    factor: base === 0n ? '1.000000' : fmt(div(running, base), 6),
    vsEstimatePct: est > 0n ? fmt(div(mul(beforeGst - est, dec('100')), est), 2) : null,
  };
}

export interface MeasurementInput {
  description: string;
  nos: string | null;
  length: string | null;
  breadth: string | null;
  height: string | null;
  deduct: boolean;
}

/** One measurement row: the product of the dimensions given (blank ones are skipped), 4 decimals, signed. */
export function measuredQty(r: MeasurementInput): string {
  const dims = [r.nos, r.length, r.breadth, r.height].filter(
    (x): x is string => x !== null && x !== '',
  );
  if (dims.length === 0) throw new Error('a measurement row needs at least one dimension');
  const q = dims.slice(1).reduce((acc, x) => mul(acc, dec(x)), dec(dims[0]!));
  const rounded = dec(fmt(q, 4));
  return fmt(r.deduct ? -rounded : rounded, 4);
}

/** The item quantity: the sum of its rows. */
export const sumQty = (qtys: string[]): string =>
  fmt(
    qtys.reduce((s, q) => s + dec(q), 0n),
    4,
  );
