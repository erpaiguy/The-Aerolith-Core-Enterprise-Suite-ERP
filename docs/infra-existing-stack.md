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

## 5. Tenant database provisioning (revised after owner input)

**Owner decision (final):** every tenant has **their own Supabase organisation and their own Supabase project**. The owner holds none.
Everything the tenant does in the app (users, app-level "projects", BOQs, tenders, schedules, documents, files) is rows and files
inside that one Supabase project. App-level projects are table rows, not Supabase projects.

**Onboarding flow this requires:**
1. Signup on the website, email verified.
2. **"Connect your Supabase"**: the tenant signs in to (or creates) their Supabase account and authorises our OAuth app to create a project in their organisation. [Certain] We cannot create anything in someone else's organisation without this one-time consent. "Background" creation starts *after* it. [Likely] Supabase offers OAuth for third-party integrations with project-management scopes; verify before Wave 0.
3. Our server creates the project (Mumbai region), generates a strong database password, creates the app and migration roles, runs migrations, creates the private storage bucket, and records it in `core.tenant_db`.
4. Licence key issued and emailed; download proceeds.

**Consequences accepted:**
- Signup has one extra step (a Supabase account). Expect some trial drop-off there; measure it.
- The tenant's Supabase bill is theirs. Free is enough for light use; heavy use (1M-line BOQs, many documents) moves them to a paid Supabase plan. **Our pricing must say this plainly**, so nobody is surprised by a second bill.
- If the tenant pauses, deletes, or lets their project hit a limit, only that tenant is affected. The app detects it and shows the fix.
- We store the OAuth token only if it is needed for status checks or resuming a paused project, encrypted, with minimal scopes. Database credentials are envelope-encrypted.
- Mode H (hosted by us) is dropped as the default and kept only as a documented fallback. Mode P (tenant's own Postgres) remains for tenants who refuse Supabase.

**What is solid:** Supabase is plain Postgres underneath. Our app connects with a normal connection string and never uses
Supabase's REST/Auth/Realtime for tenant data, so any Supabase project can be a tenant database. `ltree`, `pg_trgm`,
partitioning and `COPY` work on it [Likely, verify at spike time].

**What breaks (verify limits against current Supabase pricing before relying on them):**
1. [Certain] Free plan allows only **2 active projects per organisation**. Tenant #3 forces a paid project if projects are created in *our* organisation.
2. [Certain] Free projects **pause after ~1 week of inactivity** and have **no point-in-time recovery**. A paused tenant database means that tenant is down until someone resumes it.
3. [Likely] Free database size is about **500 MB**. A tenant with a few large BOQs (the 1M-line requirement) exceeds that. At the cap the database goes read-only.
4. [Likely] Free tier compute is shared and small, which interacts with the performance targets in 03 §13.

**Provisioning modes considered (owner chose S):**

| Mode | Where the DB lives | Who pays / owns | Use |
|------|--------------------|------------------|-----|
| H. Hosted by us | One shared Postgres server we run, one **database** per tenant, size-capped | Us (a single server, not one-project-per-tenant) | **Default for trials** (3 users) |
| S. Tenant's own Supabase | A project in the **tenant's own Supabase organisation**, connected through Supabase's OAuth/API ("Connect your Supabase" button) [Likely available, verify] | Tenant (their free limits and their plan) | Light-load tenants who want their data under their own account |
| P. Tenant's own Postgres | Tenant's server or any managed Postgres | Tenant | Heavy-load, compliance-minded, self-hosted |

[Likely] Mode H avoids the 2-project cap and the signup friction of making every trial user create a Supabase account.
A free ARM VM from an always-free cloud tier could host mode H during the trial period. [Guessing] Check region, terms and
account-termination risk before depending on it.

**Our responsibilities in S and P modes:** we hold the tenant's connection credentials (the server must connect), so they are
envelope-encrypted and never logged; the app detects "paused / unreachable / nearly full" and shows the tenant exactly what to do; the P13
scheduled export is on by default and shows backup status prominently, because free tiers have no backups and tenant data loss lands on our reputation too.

## 6. Retention (control plane only, draft)

Tenant business data in S/P modes is in the tenant's account: we do not keep it. We still hold, and must define retention for:

| Data we hold | Proposed retention | Why |
|--------------|--------------------|-----|
| Tenant account, contacts | Until deletion request or N months after last activity | DPDP: purpose limitation, erasure on request |
| Licence, device and seat history | Duration of contract + short tail | Dispute handling |
| **Invoices and payment records we issue** | **Statutory period for tax records (GST law is multi-year; verify the exact period with an accountant)** | We are a seller in India, so this applies to us regardless of where tenant data lives |
| Download/purchase events | Aggregated after 12 months | Analytics |
| Mode H tenant databases | After subscription ends: read-only export window (e.g. 30 days), then deletion with a deletion record | We host it, so we are the processor |
