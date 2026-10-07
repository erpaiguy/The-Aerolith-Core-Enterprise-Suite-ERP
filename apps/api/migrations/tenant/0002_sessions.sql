-- Sessions and the link between the tenant admin (identity in the control plane) and their user row here.

-- The tenant admin's row: no password here; `owner_account_id` points at the control-plane identity.
ALTER TABLE platform."user" ADD COLUMN owner_account_id uuid UNIQUE;
ALTER TABLE platform."user" ADD CONSTRAINT user_admin_identity
  CHECK ((role = 'admin') = (owner_account_id IS NOT NULL));

CREATE TABLE platform.session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  client text NOT NULL CHECK (client IN ('browser', 'desktop')),
  refresh_hmac text NOT NULL,
  previous_hmac text,           -- presenting this again means the refresh token was stolen and reused
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX session_by_user ON platform.session (user_id) WHERE revoked_at IS NULL;
SELECT platform.secure_table('platform.session');
