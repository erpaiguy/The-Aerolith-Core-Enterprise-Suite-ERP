// TDS on a supplier's bill (docs/wave3-plan.md step 4), from the section's data. A bill above the single-bill
// threshold is taxed on itself; once the year's bills pass the annual threshold, the tax catches up on every bill of
// the year not taxed so far. Rounded to the rupee. [Guessing] The rules are the CA's to confirm.
import { dec, fmt, mul, div, type Dec } from '../rates/decimal.js';

export interface TdsSection {
  section: string;
  rateCompany: string;
  rateIndividual: string;
  rateNoPan: string;
  singleThreshold: string | null;
  yearThreshold: string | null;
}

/** Individuals and HUFs pay the lower rate: the 4th letter of the PAN is P or H. */
export const rateFor = (s: TdsSection, pan: string | null) =>
  !pan ? s.rateNoPan : /^...[PH]/.test(pan) ? s.rateIndividual : s.rateCompany;

export function workTds(input: {
  section: TdsSection;
  pan: string | null;
  /** This bill's value before GST. */
  taxable: string;
  /** Earlier bills of the year under the section: their value, and what of it was already taxed. */
  priorTaxable: string;
  priorTaxed: string;
}) {
  const t = dec(input.taxable);
  const year = dec(input.priorTaxable) + t;
  const s = input.section;
  let base: Dec = 0n;
  if (s.yearThreshold !== null && year > dec(s.yearThreshold)) base = year - dec(input.priorTaxed);
  else if (s.singleThreshold !== null && t > dec(s.singleThreshold)) base = t;
  const rate = rateFor(s, input.pan);
  const tds = base > 0n ? dec(fmt(mul(base, div(dec(rate), dec('100'))), 0)) : 0n;
  return { base: fmt(base, 2), rate, tds: fmt(tds, 2) };
}
