import { describe, expect, it } from 'vitest';
import { mayMove, probabilityOf, stageFromTender, weighted } from '../src/crm/crm-rules.js';

describe('CRM rules', () => {
  it('takes the stage’s probability unless the lead sets its own; won and lost are fixed', () => {
    expect(probabilityOf('qualified', null)).toBe(25);
    expect(probabilityOf('qualified', 50)).toBe(50);
    expect(probabilityOf('won', 20)).toBe(100);
    expect(probabilityOf('lost', 80)).toBe(0);
  });

  it('weighs value by probability, exactly in paise', () => {
    expect(weighted(1_000_000_00n, 25)).toBe(250_000_00n);
    expect(weighted(333n, 50)).toBe(167n);
    expect(weighted(null, 60)).toBe(0n);
  });

  it('follows the tender once converted', () => {
    expect(stageFromTender('bidding')).toBe('tender');
    expect(stageFromTender('won')).toBe('won');
    expect(stageFromTender('no_bid')).toBe('lost');
  });

  it('allows the moves a person makes by hand', () => {
    expect(mayMove('new', 'qualified')).toBe(true);
    expect(mayMove('qualified', 'tender')).toBe(false);
    expect(mayMove('won', 'new')).toBe(false);
    expect(mayMove('dropped', 'qualified')).toBe(true);
    expect(mayMove('dropped', 'won')).toBe(false);
  });
});
