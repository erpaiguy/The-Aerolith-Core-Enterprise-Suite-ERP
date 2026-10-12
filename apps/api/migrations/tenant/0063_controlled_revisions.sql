-- Wave 5 step 4 (docs/wave5-plan.md): controlled revisions. A project's revision series, enforced on the drawings
-- register; who gets which disciplines (people inside acknowledge receipt, parties outside get a draft transmittal);
-- and each revision's check code behind the QR printed on its controlled copy.
CREATE TABLE dms.revision_rule (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  enabled boolean NOT NULL DEFAULT true,
  construction text NOT NULL DEFAULT 'numbers' CHECK (construction IN ('numbers', 'letters', 'r_numbers')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('dms.revision_rule');

CREATE TABLE dms.distribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  discipline text CHECK (discipline IS NULL OR discipline IN ('architectural', 'structural', 'electrical', 'plumbing',
    'hvac', 'fire', 'landscape', 'interiors', 'other')),            -- NULL: every discipline
  user_id uuid REFERENCES platform."user" (id),                       -- inside
  party_id uuid REFERENCES platform.party (id),                       -- outside
  name text,                                                          -- outside: who, as on a transmittal
  email text CHECK (email IS NULL OR length(email) <= 254),
  every_purpose boolean NOT NULL DEFAULT false,                       -- false: construction revisions only
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK ((user_id IS NULL) <> (name IS NULL)),
  CHECK (name IS NULL OR length(trim(name)) BETWEEN 2 AND 200)
);
CREATE INDEX distribution_project ON dms.distribution (project_id);
SELECT platform.secure_table('dms.distribution');

CREATE TABLE dms.distribution_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES proj.drawing_revision (id),
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (revision_id, user_id)
);
CREATE INDEX distribution_receipt_user ON dms.distribution_receipt (user_id) WHERE acknowledged_at IS NULL;
SELECT platform.secure_table('dms.distribution_receipt');
REVOKE DELETE, TRUNCATE ON dms.distribution_receipt FROM aerolith_app;

-- The QR's code: random, so revisions cannot be listed by walking codes.
ALTER TABLE proj.drawing_revision ADD COLUMN check_code uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX drawing_revision_check ON proj.drawing_revision (check_code);
