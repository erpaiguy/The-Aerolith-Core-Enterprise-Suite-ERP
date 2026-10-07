-- Authentication (docs/03-architecture.md §6, docs/09-security.md §3.3-3.4, §7).
-- Tenant admins sign in with email + password + mandatory TOTP; their identity lives here. Staff identities live in
-- each tenant's own database. Platform operators (the owner console) are separate accounts with mandatory TOTP.

ALTER TABLE core.owner_account
  ADD COLUMN password_hash text,
  ADD COLUMN totp_secret text,          -- sealed
  ADD COLUMN totp_pending_secret text,  -- sealed, during enrolment
  ADD COLUMN totp_last_step bigint,     -- replay protection
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD COLUMN recovery_codes text[] NOT NULL DEFAULT '{}',  -- SHA-256 of unused codes
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

-- Password setup (new tenant) and reset (forgot password) links. Stored as HMACs.
CREATE TABLE core.owner_password_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL REFERENCES core.owner_account (id),
  purpose text NOT NULL CHECK (purpose IN ('setup', 'reset')),
  token_hmac text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_password_token_owner ON core.owner_password_token (owner_account_id);

CREATE TABLE core.operator (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'support', 'read_only')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  totp_secret text,
  totp_pending_secret text,
  totp_last_step bigint,
  mfa_enabled_at timestamptz,
  recovery_codes text[] NOT NULL DEFAULT '{}',
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX operator_email ON core.operator (lower(email));

CREATE TABLE core.operator_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES core.operator (id),
  refresh_hmac text NOT NULL,
  previous_hmac text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX operator_session_operator ON core.operator_session (operator_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['owner_password_token', 'operator', 'operator_session'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aerolith_api') THEN
      EXECUTE format('CREATE POLICY api_all ON core.%I TO aerolith_api USING (true) WITH CHECK (true)', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON core.%I TO aerolith_api', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA core FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA core FROM authenticated;
  END IF;
END $$;
