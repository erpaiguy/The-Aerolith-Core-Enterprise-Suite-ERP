# Control Plane API (Wave 0 step 3)

Implemented in `apps/api` (NestJS). Schema: `apps/api/migrations/control-plane/0001_core.sql`. All routes are under `/api`.

## App and website routes

| Method | Path | Who calls it | Purpose |
|--------|------|--------------|---------|
| POST | `/licences/activate` | Desktop/browser app | `{ key, deviceId, platform, label }` → signed entitlement token. Accepts any case, spaces, dashes, O/0 and I/L/1 mix-ups. Typos are caught by the checksum before any lookup |
| POST | `/licences/refresh` | App | `{ token }` → new token. Accepts an expired token (app was offline) but re-checks licence and device in the database |
| GET | `/licences/notices` | App | `Authorization: Bearer <entitlement token>` → in-app notices (trial extended/shortened, revoked, broadcasts) |
| POST | `/downloads` | Website | Records a download event (append-only) |

## Owner routes (`/owner/...`)

**Interim auth:** `Authorization: Bearer <OWNER_API_TOKEN>`. Replaced by owner login with mandatory MFA in step 5.
Until then, never expose these routes publicly: bind the API to localhost or the tunnel only.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/owner/tenants` | `{ email, tenantName }` → owner account + tenant + 120-day trial (3 seats: 1 admin, 1 manager, 1 worker) + queued licence email. One trial per email |
| GET | `/owner/licences/:id` | Licence, current state, devices, full event history |
| POST | `/owner/licences/:id/trial-end` | `{ newEndsAt, reason }`. Extending is always allowed. Shortening needs at least `MIN_SHORTEN_NOTICE_DAYS` (default 14) of notice. Creates an in-app notice and a queued email |
| POST | `/owner/licences/:id/revoke` | `{ reason }`. Blocks activation and refresh |
| POST | `/owner/licences/:id/devices/:deviceId/revoke` | Frees a device slot; that device cannot re-activate |
| POST | `/owner/licences/:id/reveal-key` | Decrypts the stored key for resending. Audited |

## Rules implemented

| Rule | Where |
|------|-------|
| Key format `AERO-XXXXX-XXXXX-XXXXX-XXXXX`, 95 random bits, Luhn mod-32 check character | `src/licensing/licence-key.ts` |
| Keys stored as HMAC (lookup) + AES-256-GCM ciphertext (resend); never in plaintext, never in the email outbox | `licence-key.ts`, `src/crypto/secretbox.ts` |
| Licence states: active → grace (7 days) → read-only; revoked/suspended | `src/licensing/licence-rules.ts` |
| Seat check: trial role caps (1/1/1); paid tiers any mix within the cap. Enforced when users are created (step 5) | `licence-rules.ts` `checkSeat` |
| Devices per licence = seats × 2 (trial: 6) | `DEVICES_PER_SEAT` |
| Entitlement tokens: Ed25519-signed, valid up to 7 days, never past the end of grace | `src/licensing/entitlement.ts` |
| Append-only `licence_event`, `download_event`, `owner_audit` (UPDATE/DELETE/TRUNCATE rejected by triggers) | migration |
| Supabase hardening: RLS on every `core` table, no grants to `anon`/`authenticated` | migration |
| Production refuses to start without every secret; development uses throwaway secrets and warns | `src/config/config.ts` |

## Not yet built (later steps)

Email sending (the outbox is filled; a worker sends it via the EmailAdapter), owner login with MFA (step 5),
rate limiting on public routes (step 5), paid tiers and payment webhooks (Phase 7 work, demo mode).

## Running it

```sh
pnpm --filter @aerolith/api build
pnpm --filter @aerolith/api secrets:generate      # once; store output in apps/api/.env (never commit)
CONTROL_DATABASE_URL=... pnpm --filter @aerolith/api migrate:control
pnpm --filter @aerolith/api start
```
