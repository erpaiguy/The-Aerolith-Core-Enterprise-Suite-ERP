# Phase 6: Pricing (locked rev 1, framework only)

Actual prices are set when the app goes commercial (owner decision). This phase fixes the **model**, so the licence,
payment and owner-console code can be built now and prices become configuration later.

## 1. Inputs already decided

- Same screens and features for every tenant. **Tiers differ by seat count only**, not by modules.
- Named-user seats. The licence carries the seat cap; the server enforces it.
- Trial: 120 days, 3 named seats (1 Admin, 1 Manager, 1 Worker), extendable/shortenable by the owner with notice.
- The tenant pays their own Supabase bill. **Our price covers the software only.**
- Currency INR, launch market India.

## 2. Proposed model

| Element | Proposal | Configurable in owner console |
|---------|----------|-------------------------------|
| Unit | Seat tiers (bundles), not per-seat arithmetic | Yes |
| Example tiers | Trial 3, then 5, 10, 25, 50, 100, Enterprise (custom) | Tier names, seat caps, prices |
| Billing period | Monthly and annual (annual discounted) | Discount % |
| Upgrade | Immediate; charge the prorated difference for the remaining period | Proration on/off |
| Downgrade | Takes effect at renewal. If users exceed the new cap, the admin must deactivate users before renewal, else renewal stays on the higher tier | Policy text |
| Trial end | Grace period, then read-only + export always allowed (03 §6) | Grace days |
| Lapse after paid | Same as trial end | Grace days |
| Self-hosted / own Postgres | Same seat tiers, annual only, signed offline licence | Price multiplier if any |
| Taxes | Prices shown exclusive of GST with GST added at checkout; B2B invoices carry the tenant's GSTIN | GST rate, SAC code |
| Coupons / extensions | Owner-issued codes and manual extensions | Yes |

## 3. Things the pricing page must say plainly

1. **"Your data lives in your own Supabase account. Light use fits Supabase's free plan; heavy use (very large BOQs, many documents) needs a paid Supabase plan billed by Supabase."** Hiding this produces angry tenants and refund requests.
2. What happens at trial end and on lapse (read-only, export always possible).
3. Seat definition: one named login per person; seats can be reassigned when a user is deactivated.

## 4. Things to verify before setting prices

- [Likely] GST on SaaS sold to Indian businesses is 18%, and GST registration becomes mandatory above the services turnover threshold. **Confirm both with a chartered accountant** before charging anyone.
- [Guessing] Competitor price points for Indian construction ERP/estimation software. Research at commercial release, not now, because they will have changed.

## 5. Decisions closed at lock

1. **Seats only** for now. Richer plan composition (storage, support, early access) later; the tier table keeps room for extra attributes.
2. **Seat reuse is immediate** when a user is deactivated (owner decision). Risk accepted: one seat can be rotated among several people. Cheap mitigation that does not block anyone: the owner console reports tenants whose seat reassignments per month exceed a threshold, so abuse is visible before pricing decisions are made.
