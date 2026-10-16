// The arithmetic of revenue on work done (docs/wave8-plan.md step 8a.1), apart from the books. Amounts in paise.
import { describe, expect, it } from 'vitest';
import { workDone } from '../src/control/revenue-recognition.service.js';

const L = 100_00_000_00n; // ₹1 crore in paise

describe('revenue on work done', () => {
  it('earns the contract in proportion to cost, and shows what the bills have not taken', () => {
    // ₹1 crore contract, ₹80 lakh estimated cost, ₹20 lakh spent: a quarter done, ₹25 lakh earned, ₹15 lakh billed.
    const r = workDone({
      contract: L,
      estimate: (L * 8n) / 10n,
      cost: (L * 2n) / 10n,
      measured: 0n,
      billed: (L * 15n) / 100n,
    });
    expect(r.method).toBe('cost');
    expect(r.pct).toBe(0.25);
    expect(r.recognised).toBe(L / 4n);
    expect(r.adjustment).toBe(L / 10n); // contract asset
    expect(r.lossProvision).toBe(0n);
    expect(r.margin).toBe(L / 20n); // 25 − 20 lakh
  });

  it('turns billing ahead of work into a contract liability', () => {
    const r = workDone({
      contract: L,
      estimate: (L * 8n) / 10n,
      cost: (L * 2n) / 10n,
      measured: 0n,
      billed: (L * 4n) / 10n,
    });
    expect(r.adjustment).toBe(-(L * 15n) / 100n);
  });

  it('provides at once for the rest of an expected loss', () => {
    // Estimate ₹1.2 crore against ₹1 crore: a ₹20 lakh loss; half done shows ₹10 lakh of it, the other ₹10 lakh provided.
    const r = workDone({
      contract: L,
      estimate: (L * 12n) / 10n,
      cost: (L * 6n) / 10n,
      measured: 0n,
      billed: 0n,
    });
    expect(r.pct).toBe(0.5);
    expect(r.recognised).toBe(L / 2n);
    expect(r.lossProvision).toBe(L / 10n);
    expect(r.margin).toBe(-(L * 2n) / 10n); // the whole loss, at once
  });

  it('uses measured value where there is no cost estimate, and never passes 100%', () => {
    const r = workDone({
      contract: L,
      estimate: 0n,
      cost: 0n,
      measured: (L * 3n) / 10n,
      billed: 0n,
    });
    expect([r.method, r.pct, r.recognised]).toEqual(['measured', 0.3, (L * 3n) / 10n]);
    const over = workDone({
      contract: L,
      estimate: (L * 5n) / 10n,
      cost: (L * 6n) / 10n,
      measured: 0n,
      billed: 0n,
    });
    expect([over.pct, over.recognised]).toEqual([1, L]);
  });
});
