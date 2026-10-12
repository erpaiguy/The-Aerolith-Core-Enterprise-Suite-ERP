// Safety's rates by hand (docs/wave3-plan.md step 15).
import { describe, expect, it } from 'vitest';
import { PRECAUTIONS, rates } from '../src/safety/safety-rules.js';

describe('safety rules', () => {
  it('works the frequency and severity rates', () => {
    // 2 lost-time injuries (5 and 12 days) in 250,000 man-hours: 8 per million; 17 days: 68 per million.
    expect(
      rates(250000, [
        { kind: 'lost_time', daysLost: 5 },
        { kind: 'lost_time', daysLost: 12 },
        { kind: 'first_aid', daysLost: 0 },
      ]),
    ).toEqual({
      manHours: 250000,
      lostTimeInjuries: 2,
      daysLost: 17,
      frequencyRate: 8,
      severityRate: 68,
    });
    // A fatality charges 6,000 days.
    expect(rates(400000, [{ kind: 'fatal', daysLost: 0 }])).toMatchObject({
      daysLost: 6000,
      severityRate: 15000,
    });
    expect(rates(0, []).frequencyRate).toBeNull();
  });

  it('lists precautions for every permit type', () => {
    for (const list of Object.values(PRECAUTIONS)) expect(list.length).toBeGreaterThanOrEqual(4);
  });
});
