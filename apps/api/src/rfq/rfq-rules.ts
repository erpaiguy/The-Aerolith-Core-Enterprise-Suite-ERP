// The comparative statement of an RFQ (docs/wave1-plan.md step 9): every vendor's rates side by side, compared before
// GST (a GST-registered contractor takes the vendor's GST as input credit, so it is not a cost), with the lowest
// (L1) per line, each vendor's total, and what the chosen rates add up to. Exact decimals throughout.
import { add, dec, div, fmt, mul, pctOf, type Dec } from '../rates/decimal.js';

export type GstMode = 'extra' | 'included' | 'exempt';

export interface CsLine {
  id: string;
  seq: number;
  code: string | null;
  description: string;
  unit: string | null;
  qty: string | null;
  /** The estimate's current rate for what the line prices (BOQ item or resource), if any. */
  ourRate: string | null;
  selectedPartyId: string | null;
}

export interface CsQuote {
  partyId: string;
  name: string;
  gstMode: GstMode;
  gstPct: string;
  rates: Map<string, { rate: string; remark: string }>;
}

export interface CsCell {
  /** As quoted (with GST when the quote includes it). */
  rate: string;
  /** Before GST, 4 decimals. */
  basic: string;
  /** basic × quantity, to the paisa; null for a line without a quantity. */
  amount: string | null;
  rank: number;
  remark: string;
}

const ONE = dec('1');
const HUNDRED = dec('100');

/** A quoted rate before GST: a quote that includes GST is divided back. */
export function basicRate(rate: string, mode: GstMode, gstPct: string): Dec {
  const r = dec(rate);
  return mode === 'included' ? div(r, add(ONE, div(dec(gstPct), HUNDRED))) : r;
}

const money = (x: Dec) => fmt(x, 2);
const amountOf = (rate: Dec, qty: string | null) => (qty === null ? null : mul(rate, dec(qty)));

/** Ranks of values, lowest first; equal values share a rank. */
function ranks(values: Dec[]): number[] {
  const sorted = [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return values.map((v) => sorted.indexOf(v) + 1);
}

export function comparativeStatement<L extends CsLine>(lines: L[], quotes: CsQuote[]) {
  const vendorBasic = new Map<string, Dec>(quotes.map((q) => [q.partyId, 0n]));
  const vendorQuoted = new Map<string, Dec>(quotes.map((q) => [q.partyId, 0n]));
  const vendorLines = new Map<string, number>(quotes.map((q) => [q.partyId, 0]));
  const vendorL1 = new Map<string, number>(quotes.map((q) => [q.partyId, 0]));
  let splitL1 = 0n;
  let selectedTotal = 0n;
  let ourTotal = 0n;
  let unpriced = 0;

  const rows = lines.map((l) => {
    const priced = quotes
      .map((q) => {
        const r = q.rates.get(l.id);
        if (!r) return null;
        const basic = dec(fmt(basicRate(r.rate, q.gstMode, q.gstPct), 4));
        return { q, r, basic };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const rk = ranks(priced.map((p) => p.basic));
    const cells: Record<string, CsCell> = {};
    priced.forEach((p, i) => {
      const amount = amountOf(p.basic, l.qty);
      cells[p.q.partyId] = {
        rate: fmt(dec(p.r.rate), 4),
        basic: fmt(p.basic, 4),
        amount: amount === null ? null : money(amount),
        rank: rk[i]!,
        remark: p.r.remark,
      };
      vendorBasic.set(
        p.q.partyId,
        vendorBasic.get(p.q.partyId)! + (amount === null ? 0n : dec(money(amount))),
      );
      const quoted = amountOf(dec(p.r.rate), l.qty);
      vendorQuoted.set(
        p.q.partyId,
        vendorQuoted.get(p.q.partyId)! + (quoted === null ? 0n : dec(money(quoted))),
      );
      vendorLines.set(p.q.partyId, vendorLines.get(p.q.partyId)! + 1);
      if (rk[i] === 1) vendorL1.set(p.q.partyId, vendorL1.get(p.q.partyId)! + 1);
    });
    const low = priced.filter((_, i) => rk[i] === 1);
    // A tie for L1 names no single vendor; the estimator chooses.
    const l1 = low.length === 1 ? low[0]!.q.partyId : null;
    if (priced.length === 0) unpriced++;
    else if (l.qty !== null) splitL1 += dec(money(mul(low[0]!.basic, dec(l.qty))));
    const chosen = l.selectedPartyId ? cells[l.selectedPartyId] : undefined;
    if (chosen?.amount) selectedTotal += dec(chosen.amount);
    const ourAmount =
      l.ourRate !== null && l.qty !== null ? money(mul(dec(l.ourRate), dec(l.qty))) : null;
    if (ourAmount) ourTotal += dec(ourAmount);
    return {
      ...l,
      cells,
      l1,
      lowest: low[0] ? fmt(low[0].basic, 4) : null,
      ourAmount,
      selected: chosen
        ? { partyId: l.selectedPartyId!, basic: chosen.basic, amount: chosen.amount }
        : null,
    };
  });

  const vendors = quotes.map((q) => {
    const basicTotal = vendorBasic.get(q.partyId)!;
    const gst =
      q.gstMode === 'extra'
        ? dec(money(pctOf(basicTotal, dec(q.gstPct))))
        : q.gstMode === 'included'
          ? vendorQuoted.get(q.partyId)! - basicTotal
          : 0n;
    const quoted = vendorLines.get(q.partyId)!;
    return {
      partyId: q.partyId,
      name: q.name,
      gstMode: q.gstMode,
      gstPct: q.gstPct,
      linesQuoted: quoted,
      complete: quoted === lines.length && lines.length > 0,
      linesL1: vendorL1.get(q.partyId)!,
      basicTotal: money(basicTotal),
      gst: money(gst),
      total: money(basicTotal + gst),
    };
  });
  // Ranking whole quotes only makes sense among those that price every line.
  const complete = vendors.filter((v) => v.complete);
  const vr = ranks(complete.map((v) => dec(v.basicTotal)));
  const rankOf = new Map(complete.map((v, i) => [v.partyId, vr[i]!]));

  return {
    lines: rows,
    vendors: vendors.map((v) => ({ ...v, rank: rankOf.get(v.partyId) ?? null })),
    totals: {
      /** Every line from whoever quoted it lowest. */
      splitL1: money(splitL1),
      /** The lines' chosen vendors. */
      selected: money(selectedTotal),
      linesSelected: rows.filter((r) => r.selected !== null).length,
      /** The estimate's current rates for the same quantities. */
      estimate: money(ourTotal),
      linesUnpriced: unpriced,
    },
  };
}

export type ComparativeStatement = ReturnType<typeof comparativeStatement<CsLine>>;

/** The rate the chosen quote puts into the estimate: before GST, to the paisa. */
export const rateToApply = (basic: string) => fmt(dec(basic), 2);
