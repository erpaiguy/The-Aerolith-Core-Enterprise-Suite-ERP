// Real estate sales and RERA arithmetic (docs/wave6-plan.md step 2), in paise so it stays exact: a unit's agreement
// value, a demand with its GST, RERA §13's 10% before the agreement, delay interest by day, the share of receipts that
// goes to the designated account (§4(2)(l)(D)) and how much may be withdrawn for the certified completion.

/** "12.34" (m², rupees or per cent) as hundredths. */
export function hundredths(v: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) throw new Error(`not a number: ${v}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}
export const rupees = (p: bigint) => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
};
const round = (num: bigint, den: bigint) => (num * 2n + den) / (2n * den);

/** Carpet area × rate per m², plus parking and other charges. */
export function agreementValue(u: {
  carpetSqm: string;
  ratePerSqm: string;
  parking: string;
  charges: string;
}): bigint {
  return (
    round(hundredths(u.carpetSqm) * hundredths(u.ratePerSqm), 100n) +
    hundredths(u.parking) +
    hundredths(u.charges)
  );
}

/** A stage's share of the value, and GST on it split into CGST and SGST halves (the odd paisa to CGST). */
export function demandOf(valuePaise: bigint, stagePct: string, gstPct: string) {
  const base = round(valuePaise * hundredths(stagePct), 10_000n);
  const gst = round(base * hundredths(gstPct), 10_000n);
  const sgst = gst / 2n;
  return { base, cgst: gst - sgst, sgst, total: base + gst };
}

/** RERA §13: before the agreement is registered, demands may not exceed 10% of the value (GST aside). */
export function withinTenPercent(
  valuePaise: bigint,
  demandedBasePaise: bigint,
  nextBasePaise: bigint,
) {
  return (demandedBasePaise + nextBasePaise) * 10n <= valuePaise;
}

/** Simple interest by day: amount × rate% × days / 365. */
export function delayInterest(amountPaise: bigint, ratePct: string, days: number) {
  if (days <= 0 || amountPaise <= 0n) return 0n;
  return round(amountPaise * hundredths(ratePct) * BigInt(days), 3_650_000n);
}

/** Days from a due date to a payment date (both YYYY-MM-DD). */
export function daysLate(dueOn: string, paidOn: string) {
  return Math.max(
    0,
    Math.round((Date.parse(`${paidOn}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) / 86_400_000),
  );
}

/** The part of a receipt that must go to the designated account: share% of what is not GST. */
export function reraShare(receiptPaise: bigint, gstPortionPaise: bigint, sharePct: string) {
  return round((receiptPaise - gstPortionPaise) * hundredths(sharePct), 10_000n);
}

/** What may still be withdrawn: deposits × certified completion%, less what has been withdrawn. */
export function withdrawable(
  depositedPaise: bigint,
  completionPct: string,
  withdrawnPaise: bigint,
) {
  const limit = (depositedPaise * hundredths(completionPct)) / 10_000n;
  return limit > withdrawnPaise ? limit - withdrawnPaise : 0n;
}

export interface Open {
  id: string;
  base: bigint;
  gst: bigint;
  open: bigint;
}
/**
 * A receipt allocated to demands oldest first; for each, the GST part paid in proportion to the demand's own GST
 * share. Returns the allocations and what is left unallocated (an advance).
 */
export function allocate(receiptPaise: bigint, demands: Open[]) {
  let left = receiptPaise;
  const out: { id: string; amount: bigint; gst: bigint }[] = [];
  for (const d of demands) {
    if (left <= 0n) break;
    if (d.open <= 0n) continue;
    const amount = left < d.open ? left : d.open;
    const total = d.base + d.gst;
    out.push({ id: d.id, amount, gst: total > 0n ? round(amount * d.gst, total) : 0n });
    left -= amount;
  }
  return { allocations: out, unallocated: left };
}
