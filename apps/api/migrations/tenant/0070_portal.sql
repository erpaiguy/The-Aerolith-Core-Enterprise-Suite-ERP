-- Wave 6 step 5 (docs/wave6-plan.md): portals for vendors, subcontractors and clients. Their users are not staff:
-- their own table, sessions and token kind, each tied to one party; what they send waits for staff to accept it.
CREATE SCHEMA portal;
GRANT USAGE ON SCHEMA portal TO aerolith_app;

CREATE TABLE portal."user" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  kind text NOT NULL CHECK (kind IN ('vendor', 'subcontractor', 'client')),
  email text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'deactivated')),
  password_hash text,
  invite_hmac text,
  invite_expires_at timestamptz,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  invited_by uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR password_hash IS NOT NULL)
);
CREATE UNIQUE INDEX portal_user_email ON portal."user" (lower(email));
CREATE UNIQUE INDEX portal_user_invite ON portal."user" (invite_hmac) WHERE invite_hmac IS NOT NULL;
CREATE INDEX portal_user_party ON portal."user" (party_id);
SELECT platform.secure_table('portal."user"');
REVOKE DELETE, TRUNCATE ON portal."user" FROM aerolith_app;

CREATE TABLE portal.session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES portal."user" (id),
  refresh_hmac text NOT NULL,
  previous_hmac text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX portal_session_user ON portal.session (user_id) WHERE revoked_at IS NULL;
SELECT platform.secure_table('portal.session');

-- A quote, a measurement or an invoice from outside; it counts only once staff accept it.
CREATE TABLE portal.submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- shown as PS-000001
  user_id uuid NOT NULL REFERENCES portal."user" (id),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  kind text NOT NULL CHECK (kind IN ('quote', 'measurement', 'invoice')),
  rfq_id uuid REFERENCES tender.rfq (id),
  order_id uuid REFERENCES proc.purchase_order (id),
  project_id uuid REFERENCES proj.project (id),
  payload jsonb NOT NULL,
  storage_key text CHECK (storage_key IS NULL OR storage_key ~ '^[0-9a-f]{64}$'),
  file_name text CHECK (file_name IS NULL OR length(file_name) <= 255),
  mime text,
  size_bytes int,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'rejected', 'withdrawn')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  decided_by uuid REFERENCES platform."user" (id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'quote') = (rfq_id IS NOT NULL)),
  CHECK (kind = 'quote' OR order_id IS NOT NULL),
  CHECK ((kind = 'invoice') = (storage_key IS NOT NULL)),
  CHECK ((status IN ('accepted', 'rejected')) = (decided_at IS NOT NULL))
);
CREATE INDEX portal_submission_party ON portal.submission (party_id, created_at DESC);
CREATE INDEX portal_submission_open ON portal.submission (status, created_at) WHERE status = 'submitted';
SELECT platform.secure_table('portal.submission');
REVOKE DELETE, TRUNCATE ON portal.submission FROM aerolith_app;
