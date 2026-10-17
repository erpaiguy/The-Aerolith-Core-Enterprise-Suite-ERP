// Who may be offered an enquiry or given an order (docs/wave8-plan.md step 8e.1). A blacklisted vendor never; one on
// hold not while the hold stands; and, where the company buys only from approved vendors, an approved one only, in
// the enquiry's trade category when it has one.
import { ConflictException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';

type Db = Sql | TransactionSql;

export const VENDOR_STATUSES = ['unvetted', 'approved', 'on_hold', 'blacklisted'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

/** Why the vendor may not be offered or given this, or null when it may. */
export function refusal(
  v: { name: string; status: VendorStatus; reason: string; trades: string[] },
  policy: { approvedOnly: boolean },
  category: string | null,
): string | null {
  if (v.status === 'blacklisted') return `${v.name} is blacklisted: ${v.reason}`;
  if (v.status === 'on_hold') return `${v.name} is on hold: ${v.reason}`;
  if (!policy.approvedOnly) return null;
  if (v.status !== 'approved') return `${v.name} is not an approved vendor yet.`;
  if (category && !v.trades.includes(category))
    return `${v.name} is not approved for this trade category.`;
  return null;
}

/** Throws when the vendor may not be offered the enquiry or given the order. */
export async function mustBeAllowed(db: Db, partyId: string, category: string | null) {
  const [v] = await db<{ name: string; status: VendorStatus; reason: string; trades: string[] }[]>`
    SELECT p.name, p.vendor_status AS status, p.vendor_status_reason AS reason,
      coalesce((SELECT array_agg(t.category) FROM platform.party_trade t WHERE t.party_id = p.id), '{}') AS trades
    FROM platform.party p WHERE p.id = ${partyId}`;
  if (!v) return;
  const [policy] = await db<
    { approved_only: boolean }[]
  >`SELECT approved_only FROM proc.vendor_policy`;
  const why = refusal(v, { approvedOnly: policy?.approved_only ?? false }, category);
  if (why) throw new ConflictException({ code: 'vendor_not_allowed', message: why });
}
