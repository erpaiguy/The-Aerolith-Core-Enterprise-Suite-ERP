# Existing Infrastructure and Hardening Plan

Facts supplied by the owner: domain and mailbox from GoDaddy, marketing/download site on Vercel, source on GitHub,
installers on GitHub Releases, downloads and purchases tracked in Supabase.

Legend: [Certain] documented/structural, [Likely] strong inference, [Guessing] needs checking against current vendor terms.

## 1. Role of each piece

| Piece | Role in our design | Verdict |
|-------|--------------------|---------|
| GoDaddy domain | Brand domain, DNS | Fine. Add SPF, DKIM, DMARC records for the sending domain |
| GoDaddy mailbox | Sender of licence-key and notification emails | **Risky at volume.** [Likely] Mailbox SMTP has daily send limits and weak bulk deliverability. OK for early trial volume. Put sending behind an `EmailAdapter` so it can move to a free-tier transactional provider or a self-hosted MTA later. Test limits before launch. |
| Vercel (site) | Marketing, trial signup, download page, customer portal | **Check the plan.** [Certain] Vercel's free Hobby plan is for personal, non-commercial use. A commercial product site is outside it. Options: Vercel Pro (paid), or move the static/Next.js site to a free host whose terms allow commercial use (e.g. Cloudflare Pages). [Guessing] verify current terms for whichever you choose. |
| GitHub (source) | Private repo for source | Fine |
| GitHub Releases (installers) | Installer and auto-update hosting | Works with **electron-updater** only if the **releases are public**. A private repo needs a token, and a token must never ship inside an installer. Use a **separate public "releases" repo** (installers only, no source). Installers are public by design: the **licence key gates features, not the download**. |
| Supabase | Control-plane store: downloads, purchases, tenants, licences, subscriptions | See §2 and §3 |

## 2. Supabase: what it can and cannot be

- [Certain] Supabase is open source (Apache-2.0) Postgres + auth + storage + API. Its hosted free tier allows commercial use, with limits.
- [Certain] **Free-tier projects pause after about a week of inactivity**, and the free tier has no point-in-time recovery. A paused licence/auth database means nobody can activate. Not acceptable for production. Options: (a) keep it only for early development, (b) move to **self-hosted Supabase or plain PostgreSQL** (both free) at launch, (c) accept the paid tier consciously. This is your call because of the "no paid tools" rule. I recommend (b) for production.
- **Supabase holds control-plane data only** (tenants, licences, subscriptions, download/purchase events). **It does not hold tenant business data.** Database-per-tenant on hosted Supabase would mean one paid project per tenant.
- **Offline tolerance, so a control-plane outage does not lock customers:** the server issues a signed entitlement token (Ed25519, short validity such as 7 days with a grace window). Apps keep working on the cached token if the licence service is briefly down.

## 3. Supabase hardening checklist (input to Phase 9)

1. **Row Level Security ON for every table, default deny.** No table is readable by the `anon` key. Revoke default grants on `anon` and `authenticated` for all control-plane tables.
2. **Keep control-plane tables out of the public API.** Put them in a non-exposed schema (e.g. `core`) so PostgREST cannot reach them. Access only through server code.
3. **`service_role` key lives only in server environment variables** (never in the browser, the Electron app, GitHub, or a `NEXT_PUBLIC_` variable). Rotate on any suspicion. Separate keys per environment.
4. **No client writes for downloads/purchases/licences.** The browser calls our server routes, the server writes. Purchase state changes only from verified payment-gateway webhooks.
5. **Webhooks:** verify the gateway signature (HMAC), reject replays by event ID, handle idempotently, store the raw event in an append-only table.
6. **Append-only event tables** for downloads, purchases, key issuance, key revocation (no UPDATE/DELETE grants). Add the `pgaudit`-style logging for admin actions where available.
7. **Licence keys:** random, long, with a checksum so typos are rejected locally; look-ups rate limited per IP and per key; store a keyed hash (HMAC) in addition to the display value; never log full keys.
8. **Auth settings:** email verification required before key release (03 §10), rate limits on signup/OTP/reset, MFA on every Supabase dashboard account and on the GitHub and Vercel/hosting accounts, no shared logins.
9. **Network and secrets:** restrict database access to the server's addresses where the plan allows it. Force SSL. No database password in client code or in git. Secret scanning enabled on GitHub (push protection).
10. **Backups:** [Likely] do not rely on the free tier's backups. Run scheduled encrypted `pg_dump` to a second location and **test a restore** monthly.
11. **Region:** choose the Mumbai region for residency and latency [Likely] available, verify at creation.
12. **Least-privilege roles:** one role for the licence service, one for the billing webhook, one read-only for reporting. No role has superuser.
13. **Monitoring:** alerts on failed-login spikes, key-lookup spikes, webhook signature failures, and unusual download counts.

## 4. Where the real tenant databases and API will run (unresolved)

[Certain] A 1M-row multi-tenant ERP backend cannot run on Vercel serverless functions (connection pooling, long jobs,
WebSockets, per-tenant connection management) and cannot use free hosted Postgres tiers. It needs a server
(VPS or similar) running Postgres, PgBouncer, Valkey, SeaweedFS and the API. **Free is not possible for this layer.**
The "no paid tools" rule covers software licences. Compute and storage are operating costs. This is a decision for Phase 10 and I need your position on it.
