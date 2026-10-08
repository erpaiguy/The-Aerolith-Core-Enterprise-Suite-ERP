# Owner Console (Wave 0 step 8)

The owner console is where you run the business side of Aerolith Core: tenants, trial licences, their databases,
email delivery, schema rollouts and the audit trail.

- **Code:**
  - `apps/owner`: its own React app, separate from the tenant app.
  - `packages/ui`: the UI kit and theme it shares with the tenant app.
  - `apps/api/src/owner`: the API.
- **Tests:**
  - `apps/api/test/owner-console.int.spec.ts`
  - `apps/owner/src/api.test.ts`
  - `tests/e2e/tests/owner-console.spec.ts`

Tags: [Certain] tested here; [Likely] strong inference; [Guessing] check yourself.

## 1. Where it runs

[Certain] The console is served **only on the owner listener**, port `8081`, which Docker publishes on `127.0.0.1`
only (deployment-docker.md §1).
- The public site on `8080` does not contain the console's files and answers 404 to every `/api/owner*` request.
- CI checks both rules on every push.

| Where | How you open it |
|-------|-----------------|
| Your PC (local testing) | `http://127.0.0.1:8081` |
| The VM (tenants) | `ssh -L 8081:127.0.0.1:8081 <user>@<vm>`, then `http://127.0.0.1:8081` on your PC. Nothing on the VM's firewall opens 8081 |
| Development | `pnpm --filter @aerolith/owner dev` → `http://127.0.0.1:5174` (proxies `/api` to the API on port 3000) |

**Why a separate app instead of an admin page inside the tenant app:**
- The tenant app is public and also ships inside the Windows installer.
- Keeping the console out of it means no owner screens, routes or code ever reach tenants' machines.
- The login cookie (§3) and the security headers can be stricter.

## 2. Screens

Every change below needs the `owner` role. The API enforces this; the screens also hide the buttons.

| Screen | What you do there |
|--------|-------------------|
| **Overview** | Tenants, trials ending within 14 days, database problems, failed emails |
| **Tenants** | Search by company or admin email; **New trial** (emails the licence key and the admin's set-password link) |
| **Tenant** | See the licence: state, end date, seats, devices. You can also: <ul><li>email the key again</li><li>show the key (two clicks, recorded in the audit log)</li><li>change the trial end date (the tenant is emailed and sees a notice; shortening needs 14 days' notice)</li><li>revoke the licence (reason required, no undo)</li><li>remove a device</li><li>check the database status</li><li>email the Supabase connect link</li><li>use a local test database</li></ul> |
| **Email** | Delivery numbers, recent emails (never links, keys or bodies), retry failed ones, send a test, the do-not-send list |
| **Migrations** | Roll the newest tenant schema out to every ready database; recent rollouts with per-result counts |
| **Audit log** | Every change from the console, newest first; append-only |
| **Account** | Your role, remaining recovery codes, change password |

**Prefer "Email the key again" over "Show key".**
- The emailed key goes only to the tenant's registered address.
- A shown key is on your screen, and you then pass it on by some other channel.

## 3. Sign-in and session

The first sign-in follows the same steps as before (authentication.md): CLI one-time password, then authenticator
set-up, then 10 recovery codes, then a code, then your own password. Now it happens in the browser.

**[Certain] Session:**
- The access token is kept in page memory only (15 minutes).
- The refresh token is an `HttpOnly`, `SameSite=Strict` cookie, `aerolith_ort`, scoped to `/api/owner/auth`. Page scripts cannot read it.
- A refresh also needs the `x-aerolith-client: browser` header.
- The session ends after 30 minutes idle or 12 hours in total. A reload keeps you signed in within those limits.
- Reusing an old refresh cookie signs the session out.

**The cookie deliberately has no `Secure` flag.**
- It is only ever used over `http://127.0.0.1`: the loopback listener, or the SSH tunnel to it.
- [Likely] Some browsers drop `Secure` cookies set over plain http on `127.0.0.1`.
- The traffic never leaves the machine.

## 4. Break-glass: lost phone and recovery codes

You are the only operator, so nobody can reset you from the console. The root of trust is shell access to the server:

```sh
docker compose -f deploy/docker-compose.yml exec api node dist/cli/reset-operator.js --email you@<your-domain>
```

This does the following:
- prints a new one-time password;
- clears your authenticator and recovery codes;
- signs out every session;
- writes `operator.reset` to the audit log.

The next sign-in sets up the authenticator again. There is deliberately no web route for this.

## 5. API added in this step

All routes are under `/api/owner`, need an operator access token, and are served on `8081` only.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/me` | Name, email, role, recovery codes left. Allowed before the first password change |
| GET | `/overview` | Counts by licence state and database status, trials ending in 14 days, email health |
| GET | `/tenants?q=&limit=` | Newest first with the latest licence, active devices and database status. `q` matches company or admin email; `%` and `_` are literal |
| GET | `/tenants/:id` | One tenant plus its licence history |
| GET | `/audit?limit=&before=` | Newest first; `before` = the last `id` of the previous page |
| GET | `/migrations/runs` | Recent rollouts with result counts |
| POST | `/licences/:id/resend-key` | Queues the licence-key email to the tenant admin. Never returns the key |
| POST | `/auth/login` with `client: "browser"`; `/auth/refresh` with the cookie | Browser session as in §3. Scripts still use the body |

## 6. Not built yet

- Website signup and download pages: tenants still start as trials you create here.
- Paid licences and seat changes (Phase 7).
- Broadcast notices to all tenants.
- More than one operator: the CLI can already create `support` and `read_only` accounts.
- The VM itself: firewall, SSH keys, HTTPS for `app.<your-domain>`. That work belongs to the move (deployment-docker.md §6).
