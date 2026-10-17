// Escalation done properly (docs/wave8-plan.md step 8d.1), by hand: lines left out of the formula, and a line
// escalated on its own index.
import { describe, expect, it } from 'vitest';
import { workBill, type BillTerms } from '../src/accounts/client-bill-math.js';

const terms = (escalation: BillTerms['escalation']): BillTerms => ({
  gstPct: '0',
  retentionPct: '0',
  retentionCap: null,
  advanceAmount: '0',
  advanceRecoveryPct: '0',
  escalation,
});
const lines = [
  { lineKey: 'earth', rate: '100', prevQty: '0', cumQty: '1000' }, // ₹1,00,000
  { lineKey: 'steel', rate: '60000', prevQty: '0', cumQty: '5' }, // ₹3,00,000
  { lineKey: 'extra', rate: '1000', prevQty: '0', cumQty: '100' }, // ₹1,00,000, an extra item
];
const work = (t: BillTerms, indices: Record<string, string>) =>
  workBill({
    terms: t,
    lines,
    indices,
    others: [],
    prior: { retention: '0', advanceRecovered: '0' },
    intra: true,
  });

describe('escalation (CPWD 10CC)', () => {
  it('works the formula on the whole value when nothing is set apart', () => {
    // ₹5,00,000 × 0.85 × 40% × (110 − 100) ÷ 100 = ₹17,000.
    const f = work(
      terms({
        factor: '0.85',
        components: [{ key: 'wpi', name: 'WPI', sharePct: '40', baseIndex: '100' }],
      }),
      { wpi: '110' },
    );
    expect(f.escalationTotal).toBe('17000.00');
  });

  it('leaves extra items out, and escalates steel on its own index', () => {
    // The formula on ₹1,00,000 only: ₹1,00,000 × 0.85 × 40% × 10% = ₹3,400. Steel: ₹3,00,000 × (54,000 − 50,000) ÷
    // 50,000 = ₹24,000.
    const f = work(
      terms({
        factor: '0.85',
        components: [{ key: 'wpi', name: 'WPI', sharePct: '40', baseIndex: '100' }],
        excludeLineKeys: ['extra'],
        items: [{ lineKey: 'steel', key: 'steel', name: 'Steel (JPC)', baseIndex: '50000' }],
      }),
      { wpi: '110', steel: '54000' },
    );
    expect(f.escalation.map((e) => [e.key, e.amount])).toEqual([
      ['wpi', '3400.00'],
      ['steel', '24000.00'],
    ]);
    expect(f.escalationTotal).toBe('27400.00');
  });
});

describe('the months of a bill period', () => {
  it('runs from the first month to the last', async () => {
    const { monthsOf } = await import('../src/accounts/price-index.service.js');
    expect(monthsOf('2026-11-16', '2027-02-10')).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
  });
});
