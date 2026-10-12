// Earned value's arithmetic (docs/wave4-plan.md step 3): variances, indices and estimates at completion by the usual
// methods, from figures in paise. Pure. An index over nothing is null, and so is any estimate that needs it.

export type Method = 'cpi' | 'budget_rate' | 'cpi_spi' | 'bottom_up';
export const METHODS: Method[] = ['cpi', 'budget_rate', 'cpi_spi', 'bottom_up'];
export const METHOD_LABELS: Record<Method, string> = {
  cpi: 'BAC ÷ CPI (performance continues)',
  budget_rate: 'AC + (BAC − EV) (the rest at budget)',
  cpi_spi: 'AC + (BAC − EV) ÷ (CPI × SPI)',
  bottom_up: 'Actual + cost to complete (cost control)',
};

/** a ÷ b to 4 decimals, rounded; null when b is nothing. */
export function index(a: bigint, b: bigint): string | null {
  if (b === 0n) return null;
  const neg = a < 0n !== b < 0n;
  const [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  const q = (x * 100_000n) / y;
  const r = (q + 5n) / 10n;
  return `${neg ? '-' : ''}${r / 10_000n}.${(r % 10_000n).toString().padStart(4, '0')}`;
}

/** v × 10⁴ ÷ i (i an index to 4 decimals, as text): money divided by an index, rounded to the paisa. */
function over(v: bigint, i: string): bigint {
  const [w = '0', f = ''] = i.split('.');
  const d = BigInt(w) * 10_000n + BigInt((f + '0000').slice(0, 4));
  return (v * 10_000n * 2n + d) / (2n * d);
}

export function earnedValue(f: {
  bac: bigint;
  pv: bigint | null;
  ev: bigint;
  ac: bigint;
  bottomUp: bigint;
}) {
  const spi = f.pv === null ? null : index(f.ev, f.pv);
  const cpi = index(f.ev, f.ac);
  const left = f.bac - f.ev;
  const both =
    spi && cpi
      ? index(
          BigInt(Math.round(Number(spi) * 10_000)) * BigInt(Math.round(Number(cpi) * 10_000)),
          100_000_000n,
        )
      : null;
  const eac: Record<Method, bigint | null> = {
    cpi: cpi && cpi !== '0.0000' ? over(f.bac, cpi) : null,
    budget_rate: f.ac + left,
    cpi_spi: both && both !== '0.0000' ? f.ac + over(left, both) : null,
    bottom_up: f.bottomUp,
  };
  return {
    sv: f.pv === null ? null : f.ev - f.pv,
    cv: f.ev - f.ac,
    spi,
    cpi,
    eac,
  };
}
