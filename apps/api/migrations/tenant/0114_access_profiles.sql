-- Finer permissions (docs/wave8-plan.md step 8g.4): custom roles, kept as named access profiles. A manager or worker
-- given a profile has exactly its permissions in place of their role's (a designation may still add to them); admins
-- are never limited. Seeing salaries and buyers' details becomes a permission of its own, apart from changing them.
CREATE TABLE platform.access_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX access_profile_name ON platform.access_profile (lower(name));
SELECT platform.secure_table('platform.access_profile');

ALTER TABLE platform."user" ADD COLUMN access_profile_id uuid REFERENCES platform.access_profile (id);
