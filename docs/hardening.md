# Hardening (Wave 9, step 9b.5)

What protects a running installation, what to set, and how to prove it. Confidence tags as elsewhere: [Certain]
tested, [Likely] reasoned from the code, [Guessing] needs checking in your setting.

## Headers and content security policy

- **Web server (deploy/Caddyfile)**, on every page and API answer through it:
  - A content security policy allowing only the app's own scripts, styles (inline styles for charts), images (plus
    data: and blob: for photos and previews), frames only for blob: previews, and requests only to itself. No
    plugins, no base-URI changes, no framing by other sites, forms only to itself.
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
  - `Strict-Transport-Security` (honoured only over HTTPS), `Cross-Origin-Opener-Policy` and
    `Cross-Origin-Resource-Policy: same-origin`.
  - `Permissions-Policy`: no camera or microphone; location only for the app itself, because site photos record
    where they were taken.
- **The API itself** (apps/api/src/bootstrap.ts), even when reached without the web server: `nosniff`, `DENY`,
  `no-referrer`, `Cache-Control: no-store` unless a route sets its own; file downloads add `sandbox` CSPs. Every
  answer carries an `x-request-id` reference. [Certain: test/health.spec.ts]
- **Desktop app**: its own CSP on the bundled UI (apps/desktop/src/protocol.ts), no Node in the page, no permissions
  granted, navigation to other sites refused.

## Limits

- Sign-in, password reset and other sensitive routes are rate-limited per address (`@RateLimit`); repeated wrong
  passwords lock the account for a while; two-factor sign-in can be made compulsory.
- Uploads: `IMPORT_MAX_MB`, `DOCUMENT_MAX_MB`, one file per request; the outbound mail rate `EMAIL_MAX_PER_HOUR`.
- Database connections: the control pool holds 10; each company's pool `TENANT_POOL_MAX` (default 5), at most
  `MAX_TENANT_POOLS` (default 50) at once, idle ones closed after a minute. At start the server compares the most it
  could open with Postgres's `max_connections` and logs a warning if they do not fit; `/api/health/ready` shows the
  figures. [Certain: test/hardening.spec.ts] For one company on the bundled Postgres the defaults leave plenty of room;
  for many companies on a default Postgres (100 connections), lower `MAX_TENANT_POOLS` or raise `max_connections`.

## Health and readiness

- `GET /api/health`: the process is up (for restart policies).
- `GET /api/health/ready`: the control database answers within 3 seconds, with the connection budget; 503 if not.
  The API image's health check uses it, so the web server starts sending traffic only when the API can work.

## Logs

- `LOG_FORMAT=json` (the compose default): one JSON object per line — time, level, context, message, and `ref` when
  the line is about a request. Every server fault (5xx) is logged with the reference the person sees in the error
  dialog, next to the stack. Passwords, tokens and request bodies are never logged.
- Keep logs off the server: `docker compose logs --no-color api` into any log store you already have; nothing paid is
  needed.

## Dependencies

- CI fails on any known vulnerability of moderate or higher severity in shipped dependencies (`pnpm audit --prod`),
  and on any licence outside tools/license-policy.json. The debug pass (docs/debug-log.md D-1 to D-3) cleared the
  last ones.

## Load test

`pnpm --filter @aerolith/bench build && node tools/bench/dist/load.js --api <url> --key <licence key> --user <name>
--password <password> [--people 10 --rounds 5]` signs in and requests the ten heaviest lists from several people at
once, printing the median, 95th and 99th percentile times and any failures (with their references). Results at the
Wave 9 exit, on the demo company (about 2,200 daily reports, 825 orders and bills), are recorded below.

Results: see "Wave 9 exit" below.

## Backup restore drill

Every nightly backup is restored into a scratch database and compared table by table before it is called good
(docs/backup.md); the Backups screen shows "Restored and matched" for each. That is the drill, done every night. Once
a quarter, also do it the hard way, on another machine:

1. Copy the newest backup file and the documents volume off the server (D-9 in docs/debug-log.md).
2. On a spare machine with the same version: `pnpm --filter @aerolith/api restore:backup <file>` into a new
   database, start the app against it, sign in, and open last month's trial balance and a few documents.
3. Note the date and the result in your own register. If anything did not match, stop and fix before relying on
   backups again.

## Wave 9 exit

To be filled in at the exit run.
