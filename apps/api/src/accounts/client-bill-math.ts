// A client RA bill's figures (docs/wave3-plan.md step 2), worked exactly: this bill's quantities and amounts from the
// cumulative and previous quantities, escalation by the contract's formula, GST on top, then the deductions after tax.
// Pure: the service brings the terms, the lines, what earlier certified bills deducted, and where the site is.
import { dec, div, fmt, mul, type Dec } from '../rates/decimal.js';

export interface EscalationTerms {
  /** The share of the work's value the formula applies to (0.85 in CPWD's clause). */
  factor: string;
  /**
   * Each component's share of the work and its base index; `seriesKey` names the index series whose average over the
   * bill's period stands as its index when none is typed (docs/wave8-plan.md step 8d.1).
   */
  components: {
    key: string;
    name: string;
    sharePct: string;
    baseIndex: string;
    seriesKey?: string | null;
  }[];
  /** Lines left out of the formula: extra items, and those escalated on their own. */
  excludeLineKeys?: string[];
  /** Lines escalated on their own index (steel, cement): the line's whole value × (index − base) ÷ base. */
  items?: {
    lineKey: string;
    key: string;
    name: string;
    baseIndex: string;
    seriesKey?: string | null;
  }[];
}
export interface BillTerms {
  gstPct: string;
  retentionPct: string;
  /** The most retention held over all bills, in rupees; null for no cap. */
  retentionCap: string | null;
  advanceAmount: string;
  advanceRecoveryPct: string;
  escalation: EscalationTerms | null;
}
export interface LineIn {
  lineKey: string;
  rate: string;
  prevQty: string;
  cumQty: string;
}
export interface Prior {
  /** Held on earlier certified bills. */
  retention: string;
  /** Recovered on earlier certified bills. */
  advanceRecovered: string;
}

const HUNDRED = dec('100');
const round2 = (v: Dec) => dec(fmt(v, 2));
const money = (v: Dec) => fmt(v, 2);
const max0 = (v: Dec) => (v > 0n ? v : 0n);
const min = (a: Dec, b: Dec) => (a < b ? a : b);

/**
 * Escalation (CPWD clause 10CC, docs/wave8-plan.md step 8d.1): the formula component by component on the work's value
 * less the lines left out or escalated on their own (value × factor × share% × (index − base) ÷ base), and each item
 * escalated on its own index (its value × (index − base) ÷ base); each to the paisa. A component without its index
 * comes to nothing.
 */
export function escalationOf(
  terms: EscalationTerms | null,
  lines: { lineKey: string; amount: string }[],
  indices: Record<string, string>,
) {
  if (!terms) return [] as { key: string; name: string; amount: string }[];
  const apart = new Set([
    ...(terms.excludeLineKeys ?? []),
    ...(terms.items ?? []).map((i) => i.lineKey),
  ]);
  const escalable = lines
    .filter((l) => !apart.has(l.lineKey))
    .reduce((s, l) => s + dec(l.amount), 0n);
  const change = (index: string | undefined, baseIndex: string) => {
    const base = dec(baseIndex);
    if (index === undefined || index === '' || base === 0n) return null;
    return div(dec(index) - base, base);
  };
  const components = terms.components.map((c) => {
    const ch = change(indices[c.key], c.baseIndex);
    if (ch === null) return { key: c.key, name: c.name, amount: '0.00' };
    const v = mul(mul(mul(escalable, dec(terms.factor)), div(dec(c.sharePct), HUNDRED)), ch);
    return { key: c.key, name: c.name, amount: money(round2(v)) };
  });
  const items = (terms.items ?? []).map((i) => {
    const ch = change(indices[i.key], i.baseIndex);
    const value = dec(lines.find((l) => l.lineKey === i.lineKey)?.amount ?? '0');
    return {
      key: i.key,
      name: i.name,
      amount: ch === null ? '0.00' : money(round2(mul(value, ch))),
    };
  });
  return [...components, ...items];
}

/** The index series each component and item takes its index from, where one is named. */
export const seriesOf = (terms: EscalationTerms | null) =>
  [...(terms?.components ?? []), ...(terms?.items ?? [])]
    .filter((c) => c.seriesKey)
    .map((c) => ({ key: c.key, seriesKey: c.seriesKey! }));

export function workBill(input: {
  terms: BillTerms;
  lines: LineIn[];
  /** This period's index per escalation component. */
  indices: Record<string, string>;
  others: { amount: string }[];
  prior: Prior;
  /** The site is in the company's GST state: CGST and SGST; otherwise IGST. */
  intra: boolean;
}) {
  const { terms, prior } = input;
  const lines = input.lines.map((l) => {
    const qty = dec(l.cumQty) - dec(l.prevQty);
    return {
      lineKey: l.lineKey,
      thisQty: fmt(qty, 4),
      amount: money(round2(mul(qty, dec(l.rate)))),
    };
  });
  const gross = lines.reduce((s, l) => s + dec(l.amount), 0n);
  const escalation = escalationOf(terms.escalation, lines, input.indices);
  const escalationTotal = escalation.reduce((s, e) => s + dec(e.amount), 0n);

  const taxable = gross + escalationTotal;
  const gst = dec(terms.gstPct);
  const [cgst, sgst, igst] = input.intra
    ? [round2(mul(taxable, div(gst, dec('200')))), round2(mul(taxable, div(gst, dec('200')))), 0n]
    : [0n, 0n, round2(mul(taxable, div(gst, HUNDRED)))];
  const invoiceTotal = taxable + cgst + sgst + igst;

  // Deductions after tax, on the gross value of work: retention up to its cap; the advance until it is recovered.
  let retention = max0(round2(mul(gross, div(dec(terms.retentionPct), HUNDRED))));
  if (terms.retentionCap !== null)
    retention = min(retention, max0(dec(terms.retentionCap) - dec(prior.retention)));
  const advanceLeft = max0(dec(terms.advanceAmount) - dec(prior.advanceRecovered));
  const advanceRecovery = min(
    max0(round2(mul(gross, div(dec(terms.advanceRecoveryPct), HUNDRED)))),
    advanceLeft,
  );
  const others = input.others.reduce((s, o) => s + dec(o.amount), 0n);
  const net = invoiceTotal - retention - advanceRecovery - others;

  return {
    lines,
    gross: money(gross),
    escalation,
    escalationTotal: money(escalationTotal),
    taxable: money(taxable),
    cgst: money(cgst),
    sgst: money(sgst),
    igst: money(igst),
    invoiceTotal: money(invoiceTotal),
    retention: money(retention),
    advanceRecovery: money(advanceRecovery),
    advanceLeftAfter: money(advanceLeft - advanceRecovery),
    otherDeductions: money(others),
    net: money(net),
  };
}
export type BillFigures = ReturnType<typeof workBill>;
