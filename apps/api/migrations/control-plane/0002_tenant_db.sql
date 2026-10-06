-- Tenant database registry, onboarding and migration rollouts (docs/05-database.md §2, §10; infra-existing-stack.md §5).

CREATE TABLE core.tenant_db (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES core.tenant (id),
  provider text NOT NULL CHECK (provider IN ('supabase', 'local_postgres', 'byo_postgres')),
  status text NOT NULL DEFAULT 'awaiting_consent' CHECK (status IN (
    'awaiting_consent',   -- Supabase: tenant has not connected their account yet
    'awaiting_org',       -- Supabase: connected, more than one organisation, tenant must choose
    'creating',           -- project/database requested, waiting for it to come up
    'bootstrapping',      -- creating roles and privileges
    'migrating',          -- applying tenant migrations
    'ready',
    'paused', 'unreachable', 'full', 'failed')),
  role_prefix text NOT NULL UNIQUE,     -- per-tenant login role names: <prefix>_app, <prefix>_migrator
  external_ref text,                    -- Supabase project ref or local database name
  organisation_ref text,
  region text,
  admin_secret text,                    -- sealed: database admin password (bootstrap only)
  app_url_secret text,                  -- sealed: connection URL for the least-privilege app role
  migrator_url_secret text,             -- sealed: connection URL for the migration role
  oauth_secret text,                    -- sealed: Supabase OAuth tokens (JSON)
  schema_version text,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_db_due ON core.tenant_db (next_attempt_at)
  WHERE status IN ('creating', 'bootstrapping', 'migrating');

-- Link emailed to a new tenant to connect their Supabase account. Stored as an HMAC, like licence keys.
CREATE TABLE core.onboarding_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenant (id),
  token_hmac text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- OAuth "state" for the Supabase consent round trip, with the PKCE verifier sealed.
CREATE TABLE core.oauth_state (
  state_hmac text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES core.tenant (id),
  verifier_secret text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE core.migration_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_version text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'paused')),
  concurrency int NOT NULL,
  failure_threshold int NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE core.migration_run_tenant (
  run_id uuid NOT NULL REFERENCES core.migration_run (id),
  tenant_id uuid NOT NULL REFERENCES core.tenant (id),
  result text NOT NULL CHECK (result IN ('applied', 'up_to_date', 'failed', 'unreachable', 'not_attempted')),
  applied text[] NOT NULL DEFAULT '{}',
  error text,
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tenant_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_db', 'onboarding_token', 'oauth_state', 'migration_run', 'migration_run_tenant'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aerolith_api') THEN
      EXECUTE format('CREATE POLICY api_all ON core.%I TO aerolith_api USING (true) WITH CHECK (true)', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON core.%I TO aerolith_api', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aerolith_api') THEN
    GRANT DELETE ON core.oauth_state, core.onboarding_token TO aerolith_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA core FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA core FROM authenticated;
  END IF;
END $$;
