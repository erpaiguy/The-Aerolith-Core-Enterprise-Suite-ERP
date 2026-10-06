-- Control plane schema (docs/05-database.md §2). Lives on the owner's Supabase project, schema `core`,
-- which is NOT exposed through the Supabase Data API. Holds no tenant business data.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE core.owner_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX owner_account_email ON core.owner_account (lower(email));

CREATE TABLE core.tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL REFERENCES core.owner_account (id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_owner ON core.tenant (owner_account_id);

-- Seat tiers (Phase 6). role_caps limits seats per role; NULL means any mix of roles.
CREATE TABLE core.tier (
  id text PRIMARY KEY,
  name text NOT NULL,
  seat_cap int NOT NULL CHECK (seat_cap > 0),
  role_caps jsonb,
  price_inr_month numeric(12,2),
  price_inr_year numeric(12,2),
  is_trial boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);
INSERT INTO core.tier (id, name, seat_cap, role_caps, is_trial)
VALUES ('trial', 'Trial', 3, '{"admin": 1, "manager": 1, "worker": 1}', true);

CREATE TABLE core.licence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenant (id),
  tier_id text NOT NULL REFERENCES core.tier (id),
  kind text NOT NULL CHECK (kind IN ('trial', 'paid', 'self_hosted')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  key_hmac text NOT NULL UNIQUE,
  key_last4 text NOT NULL,
  key_cipher text NOT NULL,
  seat_cap int NOT NULL CHECK (seat_cap > 0),
  max_devices int NOT NULL CHECK (max_devices > 0),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  grace_days int NOT NULL DEFAULT 7 CHECK (grace_days >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at)
);
CREATE INDEX licence_tenant ON core.licence (tenant_id);

CREATE TABLE core.device_activation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id uuid NOT NULL REFERENCES core.licence (id),
  device_hash text NOT NULL,
  platform text NOT NULL,
  label text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (licence_id, device_hash)
);

CREATE TABLE core.trial_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id uuid NOT NULL REFERENCES core.licence (id),
  old_ends_at timestamptz NOT NULL,
  new_ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.owner_notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES core.tenant (id), -- NULL = broadcast to every tenant
  kind text NOT NULL CHECK (kind IN ('trial_extended', 'trial_shortened', 'licence_revoked', 'update', 'maintenance', 'general')),
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX owner_notice_tenant ON core.owner_notice (tenant_id, created_at DESC);

-- Outgoing email queue; a worker delivers it through the EmailAdapter (infra-existing-stack.md §1).
CREATE TABLE core.email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email text NOT NULL,
  template text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_outbox_queued ON core.email_outbox (created_at) WHERE status = 'queued';

-- Append-only event tables.
CREATE TABLE core.licence_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  licence_id uuid NOT NULL REFERENCES core.licence (id),
  kind text NOT NULL CHECK (kind IN ('issued', 'emailed', 'resent', 'activated', 'device_revoked', 'rotated',
                                     'revoked', 'extended', 'shortened', 'seats_changed')),
  actor text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX licence_event_licence ON core.licence_event (licence_id, id);

CREATE TABLE core.download_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('trial', 'paid')),
  seats_requested int NOT NULL CHECK (seats_requested > 0),
  platform text NOT NULL,
  app_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.owner_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  target text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION core.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER licence_event_append_only BEFORE UPDATE OR DELETE ON core.licence_event
  FOR EACH ROW EXECUTE FUNCTION core.reject_change();
CREATE TRIGGER licence_event_no_truncate BEFORE TRUNCATE ON core.licence_event
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_change();
CREATE TRIGGER download_event_append_only BEFORE UPDATE OR DELETE ON core.download_event
  FOR EACH ROW EXECUTE FUNCTION core.reject_change();
CREATE TRIGGER download_event_no_truncate BEFORE TRUNCATE ON core.download_event
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_change();
CREATE TRIGGER owner_audit_append_only BEFORE UPDATE OR DELETE ON core.owner_audit
  FOR EACH ROW EXECUTE FUNCTION core.reject_change();
CREATE TRIGGER owner_audit_no_truncate BEFORE TRUNCATE ON core.owner_audit
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_change();

-- Supabase hardening (infra-existing-stack.md §3). Row Level Security on every table with no policies for the
-- Data API roles, and no grants to them. The API connects as the table owner or as `aerolith_api` (policy below).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'core' LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aerolith_api') THEN
      EXECUTE format('CREATE POLICY api_all ON core.%I TO aerolith_api USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA core FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA core FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA core FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA core FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aerolith_api') THEN
    GRANT USAGE ON SCHEMA core TO aerolith_api;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO aerolith_api;
    GRANT DELETE ON core.device_activation TO aerolith_api;
  END IF;
END $$;
