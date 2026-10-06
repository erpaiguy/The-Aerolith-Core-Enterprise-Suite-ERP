# Phase 6: Pricing (draft v0, framework only)

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

## 5. Open questions

1. Do you agree that tiers differ by seats only, or will some tiers ever unlock storage, support level, or priority updates?
2. Should seat reassignment be unlimited, or limited (e.g. a deactivated user's seat frees after N days) to stop one seat being shared by rotating users?
