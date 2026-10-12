// Earned value's arithmetic by hand (docs/wave4-plan.md step 3).
import { describe, expect, it } from 'vitest';
import { earnedValue, index } from '../src/control/ev-rules.js';

describe('earned value rules', () => {
  it('works variances, indices and the four estimates at completion', () => {
    // BAC 10,00,000; planned 5,00,000, earned 4,00,000, spent 4,44,444.44: SPI 0.8, CPI 0.9.
    const r = earnedValue({
      bac: 100_000_000n,
      pv: 50_000_000n,
      ev: 40_000_000n,
      ac: 44_444_444n,
      bottomUp: 115_000_000n,
    });
    expect([r.sv, r.cv, r.spi, r.cpi]).toEqual([-10_000_000n, -4_444_444n, '0.8000', '0.9000']);
    expect(r.eac).toEqual({
      // 10,00,000 ÷ 0.9 = 11,11,111.11
      cpi: 111_111_111n,
      // 4,44,444.44 + 6,00,000
      budget_rate: 104_444_444n,
      // 4,44,444.44 + 6,00,000 ÷ 0.72 = 4,44,444.44 + 8,33,333.33
      cpi_spi: 127_777_777n,
      bottom_up: 115_000_000n,
    });
  });

  it('leaves blank what divides by nothing', () => {
    expect(index(5n, 0n)).toBeNull();
    expect(index(2n, 3n)).toBe('0.6667');
    const r = earnedValue({ bac: 1000n, pv: null, ev: 0n, ac: 0n, bottomUp: 1000n });
    expect([r.sv, r.spi, r.cpi, r.eac.cpi, r.eac.cpi_spi, r.eac.budget_rate]).toEqual([
      null,
      null,
      null,
      null,
      null,
      1000n,
    ]);
    // Nothing earned yet but money spent: CPI 0, no estimate by it.
    expect(
      earnedValue({ bac: 1000n, pv: 500n, ev: 0n, ac: 100n, bottomUp: 0n }).eac.cpi,
    ).toBeNull();
  });
});
