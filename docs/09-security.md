# Phase 9: Security (draft v0)

Tags: [Certain] structural fact, [Likely] strong inference, [Guessing] verify before relying on it.
Legal points are not legal advice; confirm with a lawyer before commercial release.

## 1. The single biggest risk in this architecture

[Certain] **Our control plane holds the database credentials (and possibly OAuth tokens) for every tenant's Supabase
project.** One breach of the control plane or the API server is a breach of every tenant at once. Physical isolation
between tenants is strong; this one place undoes it if it is weak. Everything in §3 exists mainly to protect it.

## 2. Assets and threats

| Asset | Main threats |
|-------|--------------|
| Tenant credentials vault (control plane) | Server compromise, leaked env vars, insider, backup leak |
| Tenant business data (tenant's Supabase) | Cross-tenant mix-up in our API, broken permissions (IDOR), stolen sessions, exposed Supabase API |
| Licence and seat system | Key sharing, tampering, brute-force key lookup |
| Update channel (GitHub Releases) | Hijacked GitHub account or CI publishes a malicious installer to every tenant |
| Owner console | Phished owner account = control of all tenants' licences and credentials |
| Payment webhooks | Forged "paid" events |
| Accounts (admin, staff) | Credential stuffing, weak passwords, social-engineered recovery |

## 3. Controls

### 3.1 Tenant credential vault
- Envelope encryption: each tenant secret encrypted with its own data key; data keys encrypted by a master key that lives **only** in the API server's secret store, never in the database, git, or the Electron app.
- Decrypted only in API memory, per request, never logged, never returned by any endpoint.
- Least privilege per tenant: the stored credential is the app role (no superuser). The migration role's credential is used only by the orchestrator and stored separately.
- OAuth tokens to the tenant's Supabase organisation: keep only if needed, minimal scopes, same encryption.
- Rotation runbook: rotate the master key and every tenant's app-role password without downtime.

### 3.2 The desktop app holds no secrets
[Certain] Anything inside an installer is public. The Electron app **never connects to Supabase directly**; it talks only to our API. No database URLs, service keys, or gateway keys in the client. The tenant's database credentials never leave our server.

### 3.3 Authentication
- Argon2id (memory-hard parameters tuned on the production server), breached-password check, minimum 10 characters.
- Rate limiting and progressive lockout per account and per IP; identical responses for unknown users.
- Sessions: short access token (~15 min) + rotating refresh token. Desktop stores the refresh token in the OS keychain (`safeStorage`). Browser uses `HttpOnly`, `Secure`, `SameSite` cookies with CSRF protection.
- Password change and admin-issued reset revoke all other sessions.
- **MFA (TOTP):** mandatory for the owner console. Tenant admins: see open questions.

### 3.4 Sole-admin support recovery (03 §6)
Written checklist; all of: request logged with ticket id; identity checked against at least two facts we hold (company GSTIN, licence key last 4, registered email domain, recent device names); confirmation sent to the registered email with a **24-hour hold** before the reset window opens so a real owner can object; owner-console action requires MFA and is audited. Never verify by reply-to-email alone.

### 3.5 Authorization and tenant isolation
- Tenant is resolved **only from the authenticated session**, never from a URL, header, or body the client controls.
- Every endpoint checks `module.resource.action` + project scope on the server. Deny by default.
- Automated tests: every endpoint is called as a user of tenant A with tenant B's ids, and as a Worker against Manager actions. Must fail.
- Supabase Data API: module schemas not exposed; RLS on with no `anon`/`authenticated` policies (05 §9). Provisioning verifies this and the owner console flags drift.

### 3.6 Data protection
- TLS everywhere, including API to Supabase. HSTS on our domains.
- Files: private buckets, server-issued signed URLs valid for minutes.
- Sensitive HR/finance fields (bank accounts, PAN, ID numbers) in Wave 3: field-level encryption and masked display. [Likely] Aadhaar numbers carry specific storage restrictions; avoid storing them at all unless legally required.
- No secrets, passwords, keys or full licence keys in logs.

### 3.7 Input, files, and rendering
- Upload limits, type checks by content, not extension; files never executed or served inline from our domain.
- Excel/CSV export escapes leading `= + - @` to block formula injection.
- PDF rendering in headless Chromium with **network disabled** and a sandbox, so a crafted document cannot reach internal services (SSRF).
- API: request size limits, page-size caps, timeouts, generic error messages (no stack traces), strict CORS, CSP and security headers on the SPA.

### 3.8 Electron hardening
`contextIsolation` on, `nodeIntegration` off, `sandbox` on, strict IPC allowlist, no remote content in privileged windows, navigation and `window.open` blocked to unknown origins, deep links validated.

### 3.9 Supply chain and release integrity
- GitHub: MFA on every account, branch protection, required reviews, releases only from CI, no personal-machine builds.
- Signed installers (code-signing certificates), SHA-256 checksums published with each release, auto-updater verifies signatures.
- Dependency scanning with free tools (Dependabot, OSV-Scanner), secret scanning (Gitleaks + GitHub push protection), static analysis with a free scanner, licence gate (licensing-policy).
- Lockfiles committed; reproducible CI builds.

### 3.10 Licence system
Key lookups rate limited; keys stored as HMAC; signed entitlement tokens (Ed25519) with short validity; device activation limits; owner can revoke instantly.

### 3.11 Supabase control plane
Hardening checklist in infra-existing-stack.md §3, plus the keep-alive ping so the free project does not pause during trials.

## 4. Monitoring, logging, incident response

- Security events (logins, failures, resets, permission denials, key lookups, webhook failures, owner actions) to an append-only log.
- [Likely] CERT-In directions require Indian service providers to report certain cyber incidents within a short window (hours) and to retain logs for a set period (around 180 days) in India. **Verify current requirements**; they set our log retention and incident timelines.
- [Likely] The DPDP Act requires notifying the Data Protection Board and affected people of personal-data breaches. Verify the timelines in the current rules.
- Incident runbook: contain (revoke keys, rotate master key, disable tenant), assess, notify, fix, post-mortem.
- `security.txt` on the website with a contact for vulnerability reports.

## 5. Privacy (DPDP)

Privacy notice at signup; purpose-limited collection; telemetry opt-in (Phase 8); erasure of control-plane personal data on request, except records we must keep by law (invoices); tenants are the data fiduciaries for their own business data in their own Supabase; our terms describe our processor role for data passing through our API.

## 6. Testing before commercial release

OWASP ASVS Level 2 as the checklist; OWASP ZAP (free) in CI against staging; the isolation test suite (§3.5); one external penetration test before taking real money (a cost, not a tool).

## 7. Open questions

1. **MFA for tenant admins:** mandatory, optional, or mandatory only on paid plans? (Recommended: mandatory for all admins. The admin account controls every user and the licence.)
2. **Idle session timeout:** recommended 30 minutes idle on the browser, 12 hours on the desktop with the OS keychain. Accept or change?
3. Will anyone other than you have owner-console access? If yes, owner-console roles are needed (support vs full owner).
