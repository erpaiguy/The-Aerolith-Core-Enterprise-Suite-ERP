-- Admin-configurable permissions per role (owner decision, Wave 1). Only overrides are stored; the defaults live in
-- code (src/auth/permissions.ts) so permissions added in later releases need no data migration. Admins can always
-- do everything.
CREATE TABLE platform.role_permission (
  role text NOT NULL CHECK (role IN ('manager', 'worker')),
  permission text NOT NULL CHECK (permission ~ '^[a-z]+\.[a-z_]+$'),
  granted boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (role, permission)
);
SELECT platform.secure_table('platform.role_permission');
