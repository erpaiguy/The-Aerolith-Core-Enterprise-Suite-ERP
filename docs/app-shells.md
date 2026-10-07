# App Shells: Browser and Windows Desktop (Wave 0 step 6)

One UI bundle (`apps/web`) runs in the browser and inside the Electron desktop app (`apps/desktop`). All business
logic stays on the server.

## Screens

| Screen | Who | Notes |
|--------|-----|-------|
| Activate this device | Everyone, first run | Licence key; typos caught instantly by the shared checksum (`@aerolith/shared`) before any server call |
| Sign in | Everyone | Username (staff) or email (admin). Admins enter an authenticator code; first time, they set one up via QR code and get 10 recovery codes shown once |
| Forgot password | Everyone | Staff: request goes to the admin. Admin: emailed link. Same reply whether or not the account exists |
| Set / reset password | Admin, from email links | `/account/set-password?token=…`, `/account/reset-password?token=…`; work without an activated licence |
| Choose your own password | Staff after a one-time password | Everything else is blocked until done |
| Home | Everyone | Inbox (due items, unread count, mark read), personal reminders, licence card, notices from Aerolith, pending reset requests for admins |
| Users | Admin | Seats used / cap, add manager or worker (one-time password shown once), change role, deactivate / reactivate |
| Reset requests | Admin | Issue a one-time password or dismiss |
| Licence banner | Everyone | Trial countdown (last 14 days), grace period warning, read-only notice |

Module entries (Estimation, Tenders, Documents, Projects) appear in the sidebar as "Soon" until Wave 1.

## How sessions are kept

| | Browser | Desktop |
|---|---|---|
| Access token (15 min) | Memory only | Memory only |
| Refresh token | **HttpOnly, SameSite=Strict cookie** scoped to `/api/auth` (Secure on https). Page scripts can never read it. Refresh also needs the `x-aerolith-client` header, which a cross-site page cannot send | **OS keychain** via Electron `safeStorage` (Windows DPAPI). If no keychain exists, kept in memory only, never plain text |
| Device id | Random UUID in local storage | Random UUID in the app's data folder (not hardware-derived) |
| Entitlement token | Local storage (signed, not secret) | Same |

The API client refreshes once for any number of concurrent expired requests, then retries them.

## Desktop security (docs/09-security.md §3.8)

- UI served from the bundled files over a private `app://aerolith` scheme; requests can't leave the web root
  (unit-tested against path traversal).
- Content-Security-Policy: scripts only from the app, network calls only to the configured API, no `eval`, no plugins.
- `contextIsolation`, `sandbox`, no `nodeIntegration`: the smoke test confirms `require` and `process` are undefined in the page.
- A narrow bridge (`window.aerolithDesktop`): API URL, platform, version, device id, refresh-token get/set. IPC is
  answered only for our own UI's origin and validates its input.
- Navigation away from the app is blocked; `https` links open in the user's browser; every permission request
  (camera, microphone, location…) is denied.
- Packaged builds refuse a non-https API URL.
- The API's CORS allow-list contains only `app://aerolith` by default (`CORS_ORIGINS`), without credentials.

## Running locally

```sh
pnpm build
pnpm --filter @aerolith/api start            # API on :3000 (uses apps/api/.env)
pnpm --filter @aerolith/web dev              # browser UI on :5173, proxies /api
pnpm --filter @aerolith/desktop start        # desktop app pointing at http://127.0.0.1:3000 (dev only)
pnpm --filter @aerolith/api dev:outbox       # see emailed links (set-password, reset) until email sending exists
```

The desktop app reads its API address from `apps/desktop/resources/app-config.json` (see the `.example` file); set
`AEROLITH_API_URL` to override in development.

## Tests

| Layer | What |
|-------|------|
| API integration (`apps/api/test/shell-api.int.spec.ts`) | Cookie attributes, CSRF header, rotation and reuse, CORS allow/deny, inbox and reminders, ownership checks |
| Web unit (`apps/web/src/**/*.test.ts(x)`) | Single-flight refresh, desktop keychain path, lost session, instant typo detection |
| Desktop unit (`apps/desktop/src/web-root.test.ts`) | Path traversal, SPA fallback, CSP |
| Desktop smoke (`pnpm --filter @aerolith/desktop smoke`) | Real Electron: UI loads, bridge present, no Node APIs in the page, API reachable through CORS + CSP |
| Browser end-to-end (`tests/e2e`, Playwright) | Activate → admin sets password from the email link → authenticator enrolment → recovery codes → sign-in → add worker → worker's forced password change → reload keeps the session (cookie not visible to the page) → reminder appears in the inbox |
| CI | `check` (all of the above except the desktop smoke), `e2e`, and `desktop-windows` (builds the unsigned installer) |

## Not yet built

Auto-update, code signing, the installer's icon and branding, email sending, a dedicated owner-console UI, offline
use (out of scope for v1), and the Wave 1 modules.
