-- Tenant database, first migration (docs/05-database.md §3). Runs as the group role `aerolith_owner`, which owns
-- every object; the app connects as a login role that is a member of `aerolith_app` only.

CREATE SCHEMA platform;
GRANT USAGE ON SCHEMA platform TO aerolith_app;

-- Every table gets RLS with a single policy for the app role, so the Supabase Data API roles see nothing even if
-- the schema is ever exposed by mistake (docs/05-database.md §9).
CREATE FUNCTION platform.secure_table(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY app_all ON %s TO aerolith_app USING (true) WITH CHECK (true)', t);
END $$;

CREATE TABLE platform.entity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  gstin text,
  state_code text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX entity_one_default ON platform.entity (is_default) WHERE is_default;
SELECT platform.secure_table('platform.entity');

CREATE TABLE platform.setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.secure_table('platform.setting');

-- Staff accounts (docs/03-architecture.md §6). Usernames are unique within the tenant, case-insensitively.
CREATE TABLE platform."user" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'worker')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  password_hash text,
  must_change_password boolean NOT NULL DEFAULT true,
  totp_secret text,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX user_username ON platform."user" (lower(username));
SELECT platform.secure_table('platform."user"');

CREATE TABLE platform.password_reset_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued', 'dismissed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  device_label text,
  actioned_by uuid REFERENCES platform."user" (id),
  actioned_at timestamptz
);
-- Repeated requests collapse into one pending request per user.
CREATE UNIQUE INDEX password_reset_one_pending ON platform.password_reset_request (user_id) WHERE status = 'pending';
SELECT platform.secure_table('platform.password_reset_request');

CREATE TABLE platform.notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES platform."user" (id),   -- NULL = everyone in the tenant
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  due_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_user ON platform.notification (user_id, created_at DESC);
SELECT platform.secure_table('platform.notification');

CREATE TABLE platform.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity ON platform.audit_log (entity, entity_id);
SELECT platform.secure_table('platform.audit_log');

-- The app may write audit rows but never change or delete them.
REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_log FROM aerolith_app;

INSERT INTO platform.entity (name, is_default) VALUES ('Main entity', true);
