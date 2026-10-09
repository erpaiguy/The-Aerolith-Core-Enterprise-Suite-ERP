// Exact decimal arithmetic for rate analysis (docs/05-database.md §1: money is never a float). Values are bigints
// scaled by 10^12, enough for 6-decimal coefficients × 4-decimal rates × percentages without losing paise. Every
// rounding is half away from zero, like Postgres numeric round().

export type Dec = bigint;

const PLACES = 12;
const SCALE = 10n ** BigInt(PLACES);

export const ZERO: Dec = 0n;

/** "1,234.5" is not accepted here: inputs come from the database or validated requests. */
export function dec(v: string | number): Dec {
  const s = typeof v === 'number' ? String(v) : v.trim();
  const m = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`not a decimal: ${v}`);
  const frac = (m[3] ?? '').padEnd(PLACES + 1, '0');
  let n = BigInt((m[2] || '0') + frac.slice(0, PLACES));
  if (Number(frac[PLACES]) >= 5) n += 1n;
  return m[1] === '-' ? -n : n;
}

const divRound = (a: bigint, b: bigint): bigint => {
  const neg = a < 0n !== b < 0n;
  const [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  const q = (x * 2n + y) / (y * 2n);
  return neg ? -q : q;
};

export const add = (...xs: Dec[]): Dec => xs.reduce((s, x) => s + x, 0n);
export const mul = (a: Dec, b: Dec): Dec => divRound(a * b, SCALE);
export const div = (a: Dec, b: Dec): Dec => {
  if (b === 0n) throw new Error('division by zero');
  return divRound(a * SCALE, b);
};
/** a × (1 + pct/100) */
export const plusPct = (a: Dec, pct: Dec): Dec => a + divRound(a * pct, SCALE * 100n);
/** a × pct/100 */
export const pctOf = (a: Dec, pct: Dec): Dec => divRound(a * pct, SCALE * 100n);

/** Rounded to `places` decimals, as a plain string without trailing zeros beyond `minPlaces`. */
export function fmt(a: Dec, places: number, minPlaces = places): string {
  const unit = 10n ** BigInt(PLACES - places);
  const r = divRound(a, unit);
  const neg = r < 0n;
  let s = (neg ? -r : r).toString().padStart(places + 1, '0');
  s = places > 0 ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
  if (places > minPlaces) {
    const keep = s.length - (places - minPlaces);
    s = s.slice(0, keep) + s.slice(keep).replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return neg && /[1-9]/.test(s) ? `-${s}` : s;
}
