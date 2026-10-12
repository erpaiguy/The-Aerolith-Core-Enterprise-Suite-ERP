// Portal rules (docs/wave6-plan.md step 5), kept free of the database so they are tested directly.

export type PortalKind = 'vendor' | 'subcontractor' | 'client';
export const PORTAL_KINDS: PortalKind[] = ['vendor', 'subcontractor', 'client'];
export const INVITE_DAYS = 7;
export const PORTAL_IDLE_MS = 2 * 3_600_000;
export const PORTAL_ABSOLUTE_MS = 30 * 86_400_000;

/** The party must carry the role its portal is for: a vendor for the vendor portal, and so on. */
export function partyFits(
  party: { is_vendor: boolean; is_subcontractor: boolean; is_client: boolean },
  kind: PortalKind,
): boolean {
  if (kind === 'vendor') return party.is_vendor;
  if (kind === 'subcontractor') return party.is_subcontractor;
  return party.is_client;
}

/** Invited and active users count against the fair-use cap of their kind; deactivated ones free their place. */
export function capCheck(
  inUse: number,
  cap: number,
): { ok: true } | { ok: false; reason: 'portal_cap_reached' } {
  return inUse < cap ? { ok: true } : { ok: false, reason: 'portal_cap_reached' };
}

/** What a submission is shown as: PS-000042. */
export const submissionNumber = (seq: number | string) => `PS-${String(seq).padStart(6, '0')}`;
