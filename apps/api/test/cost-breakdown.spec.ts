import { describe, expect, it } from 'vitest';
import { breakdown } from '../src/reports/cost-breakdown.js';
import type { ResourceKind } from '../src/rates/engine.js';

const kinds = (k: Partial<Record<ResourceKind, string>>): Record<ResourceKind, string> => ({
  material: '0',
  labour: '0',
  equipment: '0',
  subcontract: '0',
  other: '0',
  ...k,
});
const amounts = (b: ReturnType<typeof breakdown>) =>
  Object.fromEntries(b.parts.map((p) => [p.part, p.amount]));

describe('cost breakdown', () => {
  it('splits each amount in its analysis proportions; additions take the rest', () => {
    // Per unit 300 = material 80 + labour 50 + equipment 100 + other 7 + additions 63.
    const wall = {
      unitRate: '300',
      byKind: kinds({ material: '80', labour: '50', equipment: '100', other: '7' }),
    };
    const b = breakdown(
      [
        { analysisId: 'wall', amount: '3000' },
        { analysisId: null, amount: '500' },
      ],
      (id) => (id === 'wall' ? wall : null),
    );
    expect(b.total).toBe('3500.00');
    expect(amounts(b)).toEqual({
      material: '800.00',
      labour: '500.00',
      equipment: '1000.00',
      subcontract: '0.00',
      other: '70.00',
      additions: '630.00',
      provisional: '0.00',
      not_analysed: '500.00',
    });
    expect(b.parts.find((p) => p.part === 'equipment')!.pct).toBe('28.57');
  });

  it('splits the amount as it stands, even when the rate was typed over', () => {
    // The analysis says 300, the item was priced at 330: proportions hold, money comes from the BOQ.
    const b = breakdown([{ analysisId: 'a', amount: '330' }], () => ({
      unitRate: '300',
      byKind: kinds({ material: '150', labour: '150' }),
    }));
    expect(amounts(b)).toMatchObject({ material: '165.00', labour: '165.00', additions: '0.00' });
  });

  it('keeps paise exact: the rounding goes to additions', () => {
    const b = breakdown([{ analysisId: 'a', amount: '100' }], () => ({
      unitRate: '3',
      byKind: kinds({ material: '1', labour: '1', equipment: '1' }),
    }));
    // 33.33 × 3 = 99.99; the paisa left over is in additions so the parts add up to 100.00.
    expect(amounts(b)).toMatchObject({
      material: '33.33',
      labour: '33.33',
      equipment: '33.33',
      additions: '0.01',
    });
  });

  it('counts uncostable and zero-rate analyses as not analysed; an empty BOQ has no percentages', () => {
    const b = breakdown(
      [
        { analysisId: 'cycle', amount: '40' },
        { analysisId: 'zero', amount: '60' },
      ],
      (id) => (id === 'zero' ? { unitRate: '0', byKind: kinds({}) } : null),
    );
    expect(amounts(b).not_analysed).toBe('100.00');
    expect(breakdown([], () => null).parts.every((p) => p.pct === null)).toBe(true);
  });
});
