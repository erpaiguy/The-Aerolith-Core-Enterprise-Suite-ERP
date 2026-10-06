# Phase 10: Deployment (locked rev 1)

Two stages: **Trial launch** (free tiers, demo payments, 120-day trials) and **Commercial launch** (owner may change
domain, DNS, VPN, database and deployment method, per owner decision). This document fixes the trial launch and lists what
must change for commercial.

## 1. What runs where (trial launch)

| Component | Where | Cost during trial |
|-----------|-------|-------------------|
| Marketing site, signup, download page, customer portal | Vercel (current). **Commercial use on the Hobby plan is outside its terms** (infra §1); move to a free host that allows commercial use or upgrade before selling | Free / check terms |
| DNS | GoDaddy (current) | Already paid |
| Licence and notification email | GoDaddy mailbox via SMTP, behind `EmailAdapter` | Already paid |
| Control plane | Supabase, **owner's** organisation, Mumbai, schema `core` not exposed, keep-alive ping | Free tier |
| **API + workers** (NestJS, BullMQ, Valkey) | **Stage 0: owner's PC (Docker) behind an outbound tunnel; Stage 1: free VM in India.** Docker Compose + Caddy (Apache-2.0) | See §2 and §10.1 |
| Browser app (SPA) | Static files served by Caddy on the same VM at `app.<domain>` | Included |
| Tenant databases and files | **Each tenant's own Supabase organisation/project**, created via OAuth at signup | Tenant's free tier |
| Desktop installers and auto-update | **Public releases-only GitHub repo** (source stays private) | Free |
| CI/CD | GitHub Actions | Free minutes; [Likely] macOS runners consume minutes at a multiple, so build macOS only on release tags |
| Monitoring | Uptime Kuma (MIT) + GlitchTip (MIT) + Prometheus on the same VM | Free |

## 2. The API server: the one piece that cannot be avoided

[Certain] Something must run our API around the clock: it holds the encrypted tenant credentials, enforces licences and
seats, runs migrations across tenant projects, and serves the browser app. Vercel functions don't fit (long jobs, WebSockets,
per-tenant pools). Options:

| Option | Cost | Risk |
|--------|------|------|
| Always-free cloud VM (e.g. an ARM instance in an Indian region) | ₹0 | [Guessing] Free-tier accounts can be reclaimed for idle use or terminated with little notice; check current terms and Indian region availability |
| Small paid VPS in India | Low monthly fee | Predictable; a cost, not a tool (licensing-policy §6) |

During trial, load is small because heavy data work happens in each tenant's own Supabase. Recommended: start on a free VM if one is
available, with the whole stack in Docker Compose so moving to a paid VPS is a one-hour job.

## 3. Domains

`<domain>` website · `app.<domain>` browser app · `api.<domain>` API · `status.<domain>` uptime page.
Email DNS: SPF, DKIM, DMARC (start at `p=none`, move to `quarantine` after checking reports).

## 4. Environments

| Env | Purpose | Data |
|-----|---------|------|
| Local | Development | Docker Compose with local Postgres standing in for tenant Supabase projects |
| Staging | Release testing, migration dry-runs | A **separate test Supabase organisation** with synthetic tenants, including the 1M-line BOQ benchmark tenant; gateway test mode |
| Production (trial) | Real trial tenants | Real tenant Supabase projects; gateway still test/demo mode |

## 5. Release pipeline

1. Merge to `main` → CI: lint, type-check, unit + isolation tests, licence gate, dependency and secret scans, build.
2. Tag `vX.Y.Z` → CI builds API image, SPA, and Electron installers (Windows first; see §7), signs where certificates exist, publishes checksums.
3. Staging deploy → migration dry-run across staging tenants → smoke tests.
4. Production deploy: **migrations first (expand only)**, orchestrated per tenant project with a failure threshold; then API; then SPA; then publish the desktop release.
5. Desktop update channel: `stable` and `beta`; `mandatory` flag for security fixes; staged rollout by percentage.
6. Owner notice (in-app + email) for notable releases, same channel as trial notices.
7. **Rollback:** previous API image and SPA redeployed; desktop pins the previous version; because migrations are expand-only, the old version still runs. Contract steps ship one release later.

## 6. Self-hosted / own-Postgres tenants (mode P)

A Docker Compose bundle (API, worker, Valkey, Caddy, SPA) pointing at the tenant's Postgres, with an offline signed licence file.
Only permissively licensed components inside (licensing-policy §2). Same release tags and migrations as cloud.

## 7. Code signing (decide now; it affects trial conversion)

[Certain] Unsigned Windows installers trigger SmartScreen warnings, and unsigned/un-notarised macOS apps are blocked by
Gatekeeper unless the user overrides it. Both cost money (certificates / Apple developer membership).
Options for the trial: (a) ship unsigned with clear install instructions and accept lower conversion; (b) sign Windows
only; (c) sign both.
[Likely] Most Indian contractor offices run Windows, so Windows-first is reasonable; macOS can follow.

## 8. Backups (per owner decision)

Trial: no owner-run backups of the control plane. In-app tenant export stays on by default (infra §5). Commercial: scheduled
encrypted dumps of the control plane with monthly restore tests (infra §3.10).

## 9. Launch checklists

**Trial launch**
- [ ] Wave 0 benchmark targets met (03 §13)
- [ ] Isolation test suite green; OWASP ZAP baseline clean
- [ ] Supabase OAuth onboarding verified end to end with a fresh Supabase account
- [ ] Control plane hardening checklist done (infra §3), keep-alive running
- [ ] MFA on all six owner accounts; break-glass codes stored offline
- [ ] Email deliverability tested (SPF/DKIM/DMARC pass; GoDaddy send limit known)
- [ ] Website hosting terms allow the use (Vercel plan question resolved)
- [ ] Privacy policy, terms, telemetry opt-in text published
- [ ] Code-signing decision (§7) applied

**Commercial launch (additional)**
- [ ] Gateway KYC done, live keys only in production secrets, auto-renew + pre-debit notices tested
- [ ] GST invoicing reviewed by a chartered accountant
- [ ] Control-plane backups running with a tested restore
- [ ] External penetration test; CERT-In/DPDP obligations confirmed with a lawyer
- [ ] Re-evaluate hosting, DNS, VPN and database choices (owner decision)

## 10. Decisions closed at lock

1. **Code signing: Windows only** (option b). macOS is not shipped at trial launch, so it needs no signing.
   - [Likely] Windows code-signing certificates now require the private key on a hardware token or cloud HSM, which affects how CI signs. Cloud signing services are an option; [Guessing] check eligibility for an Indian private limited company. Decide the provider before the first public installer.
2. **Desktop platform at trial launch: Windows only.** The CI builds Windows installers only; macOS/Linux build jobs are added later without code changes (Electron is cross-platform).
3. **API server: Docker on the owner's PC first, then a free VM if available.**

### 10.1 Owner-PC hosting: stage 0 rules

[Certain] The owner's PC becomes the server every tenant depends on and the place where the master key for all tenant
database credentials lives (09 §1). Rules while it is the server:

| Risk | Mitigation (required) |
|------|------------------------|
| Exposing a home connection to the internet; [Likely] Indian ISPs often use CGNAT/dynamic IPs, so port forwarding may not even work | **No inbound ports.** Publish `api.`/`app.` through an outbound tunnel (e.g. Cloudflare Tunnel, free) |
| Master key on a daily-use machine (browsing, email, downloads) | Run the stack under a **separate Windows user or WSL2/VM**; full-disk encryption (BitLocker); master key in a file readable only by that user, never in the repo; no other software in the server environment |
| PC off, asleep, rebooting for updates, power cuts | Tenants are down during those times. Disable sleep, auto-start Docker and the stack on boot, UPS if possible. **Tell trial tenants this is a beta with possible downtime** |
| Disk failure | Control-plane data is on Supabase, not the PC. Keep an encrypted offline copy of the master key and `.env`. Losing the master key means re-issuing every tenant's database credential |
| Malware on the PC | Updated OS and antivirus; no admin rights for the daily-use account |

**Recommended move trigger:** move to a VM **before the first tenant you don't personally know** signs up, or at the
first outage that a tenant notices, whichever comes first. The Docker Compose stack moves unchanged.
