# Tenant Provisioning (Wave 0 step 4)

Code: `apps/api/src/provisioning`, `apps/api/src/onboarding`. Migrations: `apps/api/migrations/control-plane/0002_tenant_db.sql`
(registry) and `apps/api/migrations/tenant/` (everything inside a tenant's database).

## Flow

```
Owner/website creates tenant + trial (step 3)
        │
        ├─ Supabase tenant: POST /owner/tenants/:id/onboarding-link  → emailed link (7 days)
        │     website → GET /onboarding/supabase/authorize?token=…   → Supabase consent (OAuth + PKCE)
        │     Supabase → GET /onboarding/supabase/callback           → tokens sealed; 1 org → creating, several → awaiting_org
        │     website → POST /onboarding/supabase/organisation       → creating
        │
        └─ Local stand-in: POST /owner/tenants/:id/provision {provider: "local_postgres"} → creating

Background worker (every 5 s, row-locked, retried with backoff up to 10 attempts):
  creating ──► bootstrapping ──► migrating ──► ready
  (project/DB)  (roles+grants)   (tenant SQL)
```

`GET /owner/tenants/:id/database` and `GET /onboarding/status?token=…` show progress. Secrets are never returned.

## Isolation inside and between tenant databases

| Role | Kind | Can do |
|------|------|--------|
| `aerolith_owner` | group, no login | Owns every object; migrations run as this role |
| `aerolith_app` | group, no login | SELECT/INSERT/UPDATE/DELETE on tables (via default privileges); no DDL; cannot change or delete audit rows |
| `t<id>_migrator` | login, per tenant | Member of `aerolith_owner`; used only by the migration orchestrator |
| `t<id>_app` | login, per tenant | Member of `aerolith_app`; used by the API at runtime |

On a shared Postgres server (local provider) each tenant database is closed to PUBLIC, so tenant A's login roles
cannot even connect to tenant B's database. Integration tests prove this, along with "no DDL", "no audit tampering"
and "case-insensitive unique usernames". Every tenant table has row-level security with a single policy for the app
role, so the Supabase Data API roles see nothing.

## Migration orchestrator

`POST /owner/migrations/rollout {concurrency, failureThreshold}` applies pending files in `migrations/tenant/` to every
ready tenant with bounded concurrency. Each tenant's result (`applied`, `up_to_date`, `failed`, `unreachable`,
`not_attempted`) is stored in `core.migration_run_tenant`. When failures reach the threshold, no further tenants are
started and the run is marked `paused`; untouched tenants stay on the previous version, which expand-only migrations
keep working.

## Connections

`TenantConnections.forTenant(tenantId)` opens an app-role pool (5 connections) for a ready tenant, keeps pools in
least-recently-used order, and closes the oldest above `MAX_TENANT_POOLS`. Used by tenant modules from step 5.

## Known gaps (tracked)

1. **Supabase client is unverified against the live API.** Setup and verification steps: [supabase-oauth-setup.md](supabase-oauth-setup.md). Endpoint paths and payloads follow the public Management
   API docs. Verify once the OAuth app is registered: consent, organisation list, project creation, pooler config,
   role login through the pooler (`<role>.<project-ref>`).
2. **Document storage for Supabase tenants** is not built: tenants on our Postgres keep files in `DOCUMENT_DIR` (Wave 1 step 10); a Supabase-hosted tenant's uploads are refused with `storage_not_available` until the Storage adapter is built and verified together with gap 1.
3. A provisioning step holds a control-plane row lock while it calls the provider. Fine at trial scale; move slow
   external calls outside the transaction if many tenants sign up at once.
4. The website pages (`/onboarding`, `/onboarding/status`) don't exist yet; the API redirects to them.
5. The local provider needs a Postgres **superuser** URL. Use it only for development, CI and the owner-PC stage.
