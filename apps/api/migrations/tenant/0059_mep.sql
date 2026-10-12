-- Wave 4 step 7 (docs/wave4-plan.md): the MEP pack's project records. An equipment schedule, commissioned only on a
-- passed testing and commissioning checklist (Wave 3's quality checklists), and a coordination and clash log.
CREATE TABLE ctl.mep_equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  tag text NOT NULL CHECK (length(trim(tag)) BETWEEN 1 AND 60),
  system text NOT NULL CHECK (system IN ('hvac', 'electrical', 'plumbing', 'fire', 'elv')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 500),
  capacity text NOT NULL DEFAULT '' CHECK (length(capacity) <= 100),
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 200),
  make text NOT NULL DEFAULT '' CHECK (length(make) <= 200),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'ordered', 'delivered', 'installed', 'tested', 'commissioned')),
  checklist_id uuid REFERENCES qa.checklist (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, tag)
);
SELECT platform.secure_table('ctl.mep_equipment');

CREATE TABLE ctl.coordination_issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  systems text[] NOT NULL CHECK (cardinality(systems) BETWEEN 1 AND 6),
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 200),
  drawing_ref text NOT NULL DEFAULT '' CHECK (length(drawing_ref) <= 200),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 2000),
  raised_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution text,
  resolved_on date,
  UNIQUE (project_id, number)
);
SELECT platform.secure_table('ctl.coordination_issue');
