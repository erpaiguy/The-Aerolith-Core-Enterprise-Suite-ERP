import { describe, expect, it } from 'vitest';
import {
  addDays,
  checkSeat,
  featuresUnlocked,
  licenceState,
  validateTrialChange,
} from '../src/licensing/licence-rules.js';

const now = new Date('2026-10-07T00:00:00Z');

describe('licenceState', () => {
  const endsAt = addDays(now, 10);
  it.each([
    [now, 'active'],
    [addDays(endsAt, 3), 'grace'],
    [addDays(endsAt, 7), 'read_only'],
  ] as const)('at %s is %s', (at, expected) => {
    expect(licenceState({ status: 'active', endsAt, graceDays: 7 }, at)).toBe(expected);
  });

  it('revoked and suspended override dates', () => {
    expect(licenceState({ status: 'revoked', endsAt, graceDays: 7 }, now)).toBe('revoked');
    expect(licenceState({ status: 'suspended', endsAt, graceDays: 7 }, now)).toBe('suspended');
  });

  it('only active and grace unlock features', () => {
    expect(featuresUnlocked('active')).toBe(true);
    expect(featuresUnlocked('grace')).toBe(true);
    expect(featuresUnlocked('read_only')).toBe(false);
    expect(featuresUnlocked('revoked')).toBe(false);
  });
});

describe('checkSeat (trial: 1 admin, 1 manager, 1 worker)', () => {
  const trial = { seatCap: 3, roleCaps: { admin: 1, manager: 1, worker: 1 } };
  it('allows the preset mix and nothing beyond it', () => {
    expect(checkSeat(trial, { admin: 1 }, 'manager')).toEqual({ ok: true });
    expect(checkSeat(trial, { admin: 1, manager: 1 }, 'manager')).toEqual({
      ok: false,
      reason: 'role_cap_reached',
      limit: 1,
    });
    expect(checkSeat(trial, { admin: 1, manager: 1, worker: 1 }, 'worker')).toEqual({
      ok: false,
      reason: 'seat_cap_reached',
      limit: 3,
    });
  });

  it('paid tiers allow any mix within the cap', () => {
    const paid = { seatCap: 5, roleCaps: null };
    expect(checkSeat(paid, { admin: 1, worker: 3 }, 'worker')).toEqual({ ok: true });
    expect(checkSeat(paid, { admin: 1, worker: 4 }, 'manager')).toEqual({
      ok: false,
      reason: 'seat_cap_reached',
      limit: 5,
    });
  });
});

describe('validateTrialChange', () => {
  const current = { startsAt: addDays(now, -20), endsAt: addDays(now, 100) };
  it('always allows extending', () => {
    expect(validateTrialChange(current, addDays(now, 130), now, 14)).toEqual({
      ok: true,
      kind: 'extended',
    });
  });
  it('allows shortening only with enough notice', () => {
    expect(validateTrialChange(current, addDays(now, 30), now, 14)).toEqual({
      ok: true,
      kind: 'shortened',
    });
    expect(validateTrialChange(current, addDays(now, 5), now, 14)).toEqual({
      ok: false,
      reason: 'notice_too_short',
      earliestAllowed: addDays(now, 14),
    });
  });
  it('rejects no-ops and dates before the start', () => {
    expect(validateTrialChange(current, current.endsAt, now, 14)).toEqual({
      ok: false,
      reason: 'unchanged',
    });
    expect(validateTrialChange(current, addDays(now, -30), now, 0)).toEqual({
      ok: false,
      reason: 'before_start',
    });
  });
});
