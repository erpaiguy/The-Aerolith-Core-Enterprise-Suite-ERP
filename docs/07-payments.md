# Phase 7: Payments (locked rev 1)

Scope: how **tenants pay us** for seats. (Tenant-side bank transactions inside the ERP are a different thing, covered in 03 §14.)

## 1. Ground rules

- **No real money moves until commercial release.** Until then the gateway runs in **test mode** only, and every tenant is on the free 120-day trial.
- **We never see or store card/UPI/bank details.** Payment happens on the gateway's hosted checkout. This keeps us out of card-data compliance scope.
- **The licence changes only from a verified webhook,** never from the browser saying "payment succeeded".
- Gateway is behind a `PaymentGateway` adapter (Razorpay first). Manual bank transfer/UPI is always available as a zero-fee fallback.

## 2. Flows

**A. Trial to paid (website)**
1. Tenant admin clicks *Buy / Upgrade* in the app or on the website. The app opens the website checkout; no payment screens inside Electron.
2. Website server (Vercel route) creates an order for the chosen tier and period (price from `core.tier`, GST added).
3. Gateway hosted checkout. Tenant pays.
4. Gateway sends a webhook. Our server verifies the signature, stores the raw event (append-only `core.payment_event`), checks idempotency by event id, and only then:
   updates `core.subscription`, raises the licence seat cap, issues our GST invoice, emails invoice + confirmation, and posts an in-app notice.
5. The licence key does **not** change on upgrade. Same key, more seats.

**B. Upgrade mid-period**: prorated difference charged through the same flow. Seats unlock on webhook.

**C. Renewal**

| Option | How | Trade-off |
|--------|-----|-----------|
| Manual renewal | Reminder emails + in-app notices at 30/7/1 days with a payment link | Simple, no mandate rules; some tenants forget and lapse into read-only |
| **Auto-renew (decided)** | Gateway subscriptions using card/UPI e-mandates | Fewer lapses. [Likely] Indian recurring-payment rules require mandate registration and extra authentication above a set amount, and failures are common. More states to handle. |

**D. Manual bank transfer/UPI (fallback, also for self-hosted and Enterprise)**: we issue a proforma invoice; tenant pays to our account; owner marks it paid in the owner console with the bank reference; the same licence update runs; audit entry recorded.

**E. Failed or disputed payments**: payment failed = nothing changes, tenant is told. Chargeback/dispute = owner console flag; licence moves to grace, never instantly locked.

**F. Refunds**: none by default (see §8). Owner may issue a discretionary credit; any invoice correction uses a GST credit note.

## 3. Lapse rules (from Phase 6)

Paid period ends without payment → grace period → read-only with export always available → reactivated instantly on payment.

## 4. Our invoices

- Sequential numbering per financial year, our GSTIN, tenant's GSTIN and state (place of supply decides CGST+SGST vs IGST), SAC code, tax breakup.
- PDF stored in the control plane and emailed. Credit notes for refunds.
- Retained for the statutory period (we decided 3-5 years for the control plane; **confirm the GST record-keeping period with your accountant**, because if it is longer, the longer one wins for invoices).

## 5. Data model additions (`core`)

`order` (tier, period, amounts, GST breakup, status), `payment_event` (raw verified webhook, append-only),
`subscription` (tier, period start/end, renewal mode, status), `invoice`, `credit_note`, `manual_payment` (reference,
recorded_by, evidence file), `dunning_step` (reminder sent at).

## 6. Security checklist (feeds Phase 9)

1. Webhook signature verified with a secret stored only in server environment variables.
2. Idempotent processing by gateway event id; replays ignored.
3. Amount and tier re-checked on the server against `core.order`; the client's claimed price is never trusted.
4. Gateway API keys: test and live keys separated by environment; live keys exist only after commercial release.
5. Owner-console "mark as paid" requires MFA and is audited.

## 7. What the gateway will need from you before going live

[Likely] Razorpay (and every Indian gateway) activates live mode only after business KYC: a business entity or proprietorship, PAN,
bank account, and a website with **terms, privacy policy, refund/cancellation policy, pricing and contact details**. Test mode
works without KYC. Check their current activation checklist at the time.

## 8. Decisions closed at lock

1. **Entity:** private limited company, GST-registered. **Demo/test mode only**: no live bank account and no live gateway keys connected until the owner decides to go commercial.
2. **Auto-renewal** via gateway subscriptions with e-mandates. Requirements this adds:
   - **Pre-debit notice** to the tenant before each renewal charge (email + in-app). [Likely] Indian e-mandate rules require a pre-debit notification; the gateway sends one, we send our own too.
   - **"Cancel auto-renew" available to the tenant admin at any time**, effective at the end of the paid period. Hard-to-cancel renewals are the biggest source of disputes.
   - Failed debit: retry schedule, then a payment-link fallback, then the normal lapse rules (§3).
3. **No refunds by default.** This does **not** remove dispute handling:
   - [Certain] A card or UPI payer can raise a chargeback/dispute with their bank whatever our policy says. Flow E (§2) stays.
   - [Likely] The gateway and Indian e-commerce rules still require a **published** refund/cancellation policy. Ours will state "no refunds; cancel auto-renew anytime before the renewal date".
   - Auto-renew + no refunds is the combination most likely to produce disputes ("I forgot it renews"). The pre-debit notice and easy cancellation are the mitigation.
   - Credit notes remain in the design for owner-discretion goodwill credits and invoice corrections.
