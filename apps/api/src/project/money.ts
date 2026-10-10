// Money as whole paise in bigint: sums and differences of numeric(…,2) values without floating point.
export function cents(v: string): bigint {
  const neg = v.startsWith('-');
  const [i = '0', f = ''] = (neg ? v.slice(1) : v).split('.');
  const c = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
}
export function fromCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}
export const add = (a: string, b: string) => fromCents(cents(a) + cents(b));
export const sub = (a: string, b: string) => fromCents(cents(a) - cents(b));
/** a ÷ b to 8 decimals (truncated). */
export function ratio(a: bigint, b: bigint): string {
  const neg = a < 0n !== b < 0n;
  const q = ((a < 0n ? -a : a) * 100_000_000n) / (b < 0n ? -b : b);
  return `${neg ? '-' : ''}${q / 100_000_000n}.${(q % 100_000_000n).toString().padStart(8, '0')}`;
}
/** a as a percentage of b, 2 decimals. */
export const pct = (a: string, b: string) => {
  const r = ratio(cents(a) * 100n, cents(b));
  return Number(r).toFixed(2);
};
