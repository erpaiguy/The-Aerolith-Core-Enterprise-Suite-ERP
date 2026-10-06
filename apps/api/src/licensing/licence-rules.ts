// Pure licensing rules (docs/03-architecture.md §6, §10, §16; docs/06-pricing.md).

export type LicenceStatus = 'active' | 'suspended' | 'revoked';
/** What the app may do right now. `active` and `grace` unlock features; `read_only` allows viewing and export only. */
export type LicenceState = 'active' | 'grace' | 'read_only' | 'suspended' | 'revoked';
export type Role = 'admin' | 'manager' | 'worker';

const DAY_MS = 86_400_000;

export function licenceState(
  l: { status: LicenceStatus; endsAt: Date; graceDays: number },
  now: Date,
): LicenceState {
  if (l.status === 'revoked') return 'revoked';
  if (l.status === 'suspended') return 'suspended';
  if (now < l.endsAt) return 'active';
  if (now.getTime() < l.endsAt.getTime() + l.graceDays * DAY_MS) return 'grace';
  return 'read_only';
}

export const featuresUnlocked = (state: LicenceState): boolean =>
  state === 'active' || state === 'grace';

export type SeatCheck =
  { ok: true } | { ok: false; reason: 'seat_cap_reached' | 'role_cap_reached'; limit: number };

/** Can one more named user with `role` be added? `roleCaps` null means any mix of roles within the seat cap. */
export function checkSeat(
  tier: { seatCap: number; roleCaps: Partial<Record<Role, number>> | null },
  activeUsersByRole: Partial<Record<Role, number>>,
  role: Role,
): SeatCheck {
  const total = Object.values(activeUsersByRole).reduce((a, b) => a + (b ?? 0), 0);
  if (total >= tier.seatCap) return { ok: false, reason: 'seat_cap_reached', limit: tier.seatCap };
  if (tier.roleCaps) {
    const cap = tier.roleCaps[role] ?? 0;
    if ((activeUsersByRole[role] ?? 0) >= cap)
      return { ok: false, reason: 'role_cap_reached', limit: cap };
  }
  return { ok: true };
}

export type TrialChange =
  | { ok: true; kind: 'extended' | 'shortened' }
  | {
      ok: false;
      reason: 'unchanged' | 'before_start' | 'notice_too_short';
      earliestAllowed?: Date;
    };

/**
 * Extending is always allowed. Shortening must leave the tenant at least `minNoticeDays` of notice from now
 * (docs/03-architecture.md §16).
 */
export function validateTrialChange(
  current: { startsAt: Date; endsAt: Date },
  newEndsAt: Date,
  now: Date,
  minNoticeDays: number,
): TrialChange {
  if (newEndsAt.getTime() === current.endsAt.getTime()) return { ok: false, reason: 'unchanged' };
  if (newEndsAt <= current.startsAt) return { ok: false, reason: 'before_start' };
  if (newEndsAt > current.endsAt) return { ok: true, kind: 'extended' };
  const earliestAllowed = new Date(now.getTime() + minNoticeDays * DAY_MS);
  if (newEndsAt < earliestAllowed)
    return { ok: false, reason: 'notice_too_short', earliestAllowed };
  return { ok: true, kind: 'shortened' };
}

export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);
