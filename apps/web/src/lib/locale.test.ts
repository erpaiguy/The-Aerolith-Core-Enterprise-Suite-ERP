// Dates and amounts as the person chose (docs/wave9-plan.md step 9b.1).
import { afterEach, describe, expect, it } from 'vitest';
import { formatDate, formatInr } from './format';
import { dateText, numberLocale, setFormats } from './locale';

afterEach(() => setFormats({ date: 'medium', number: 'indian' }));

describe('formats', () => {
  it('writes a date in each style, the same calendar day whatever the time zone', () => {
    const d = new Date(2026, 9, 20);
    expect(dateText(d)).toBe('20 Oct 2026');
    setFormats({ date: 'numeric', number: 'indian' });
    expect(dateText(d)).toBe('20/10/2026');
    setFormats({ date: 'iso', number: 'indian' });
    expect(formatDate('2026-10-20')).toBe('2026-10-20');
  });

  it('groups amounts the Indian way by default, or internationally', () => {
    expect(numberLocale()).toBe('en-IN');
    expect((100000).toLocaleString(numberLocale())).toBe('1,00,000');
    setFormats({ date: 'medium', number: 'international' });
    expect((100000).toLocaleString(numberLocale())).toBe('100,000');
    expect(formatInr('100000')).toBe('₹1,00,000'); // made at load: the app reloads on a change
  });
});
