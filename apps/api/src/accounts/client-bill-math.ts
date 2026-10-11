// A client RA bill's figures (docs/wave3-plan.md step 2), worked exactly: this bill's quantities and amounts from the
// cumulative and previous quantities, escalation by the contract's formula, GST on top, then the deductions after tax.
// Pure: the service brings the terms, the lines, what earlier certified bills deducted, and where the site is.
import { dec, div, fmt, mul, type Dec } from '../rates/decimal.js';

export interface EscalationTerms {
  /** The share of the work's value the formula applies to (0.85 in CPWD's clause). */
  factor: string;
  components: { key: string; name: string; sharePct: string; baseIndex: string }[];
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

  // Escalation, component by component: gross × factor × share% × (index − base) ÷ base, each to the paisa.
  const escalation = (terms.escalation?.components ?? []).map((c) => {
    const index = input.indices[c.key];
    const base = dec(c.baseIndex);
    if (index === undefined || index === '' || base === 0n)
      return { key: c.key, name: c.name, amount: '0.00' };
    const change = div(dec(index) - base, base);
    const v = mul(
      mul(mul(gross, dec(terms.escalation!.factor)), div(dec(c.sharePct), HUNDRED)),
      change,
    );
    return { key: c.key, name: c.name, amount: money(round2(v)) };
  });
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
