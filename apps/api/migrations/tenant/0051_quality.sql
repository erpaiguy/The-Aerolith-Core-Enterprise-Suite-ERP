-- Wave 3 step 14 (docs/wave3-plan.md): quality. Inspection requests covering measurement-book entries (and holding
-- uninspected work from billing when the project says so), checklist templates and filled checklists, test records
-- judged against criteria held as data, NCRs, snags, and material approvals a purchase order can require.
CREATE SCHEMA qa;
GRANT USAGE ON SCHEMA qa TO aerolith_app;

ALTER TABLE proj.project ADD COLUMN hold_uninspected boolean NOT NULL DEFAULT false;

CREATE TABLE qa.inspection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  site_id uuid REFERENCES proj.site (id),
  boq_id uuid NOT NULL REFERENCES est.boq (id),
  line_key uuid NOT NULL,
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 300),
  activity text NOT NULL DEFAULT '' CHECK (length(activity) <= 300),
  requested_for date NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'approved_with_comments', 'rejected')),
  inspector text CHECK (length(inspector) <= 120),
  comments text NOT NULL DEFAULT '' CHECK (length(comments) <= 2000),
  decided_on date,
  decided_by uuid REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  CHECK ((status = 'requested') = (decided_on IS NULL))
);
SELECT platform.secure_table('qa.inspection');
REVOKE DELETE, TRUNCATE ON qa.inspection FROM aerolith_app;

-- The measurement entries an inspection covers (each entry once while its inspection stands).
CREATE TABLE qa.inspection_measurement (
  inspection_id uuid NOT NULL REFERENCES qa.inspection (id),
  measurement_id uuid NOT NULL REFERENCES proj.measurement (id),
  PRIMARY KEY (inspection_id, measurement_id)
);
CREATE INDEX inspection_measurement_m ON qa.inspection_measurement (measurement_id);
SELECT platform.secure_table('qa.inspection_measurement');
REVOKE UPDATE, TRUNCATE ON qa.inspection_measurement FROM aerolith_app;

CREATE TABLE qa.checklist_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  work_type text NOT NULL DEFAULT '' CHECK (length(work_type) <= 60),
  -- [{text, kind: 'yes_no' | 'number' | 'note', required, min?, max?}]
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE UNIQUE INDEX checklist_template_name ON qa.checklist_template (lower(name));
SELECT platform.secure_table('qa.checklist_template');
REVOKE DELETE, TRUNCATE ON qa.checklist_template FROM aerolith_app;

CREATE TABLE qa.checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  site_id uuid REFERENCES proj.site (id),
  template_id uuid NOT NULL REFERENCES qa.checklist_template (id),
  inspection_id uuid REFERENCES qa.inspection (id),
  items jsonb NOT NULL,          -- the template's items as they were
  answers jsonb NOT NULL,        -- [{answer, note}] in the items' order
  result text NOT NULL CHECK (result IN ('passed', 'failed')),
  done_on date NOT NULL,
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX checklist_project ON qa.checklist (project_id, done_on DESC);
SELECT platform.secure_table('qa.checklist');
REVOKE UPDATE, DELETE, TRUNCATE ON qa.checklist FROM aerolith_app;

-- Photos of a checklist or a snag, kept in the file store.
CREATE TABLE qa.photo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id uuid REFERENCES qa.checklist (id),
  snag_id uuid,
  storage_key text NOT NULL,
  mime text NOT NULL,
  bytes int NOT NULL,
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK ((checklist_id IS NULL) <> (snag_id IS NULL))
);
SELECT platform.secure_table('qa.photo');
REVOKE UPDATE, TRUNCATE ON qa.photo FROM aerolith_app;

-- Acceptance criteria by kind of test, as data a quality engineer can change (a new version from a date).
CREATE TABLE qa.test_criteria (
  kind text NOT NULL CHECK (kind IN ('cube', 'slump', 'steel', 'soil', 'brick')),
  effective_from date NOT NULL,
  data jsonb NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (kind, effective_from)
);
SELECT platform.secure_table('qa.test_criteria');
REVOKE UPDATE, DELETE, TRUNCATE ON qa.test_criteria FROM aerolith_app;
INSERT INTO qa.test_criteria (kind, effective_from, data, note) VALUES
  ('cube', '2000-01-01', '{"individualBelowFck": 3, "individualBelowFckLow": 2, "lowGradeUpTo": 15, "maxSpread": 15, "sevenDayShare": 65}',
    'IS 456: a sample (mean of 3 cubes) at least fck − 3 (M20 and above) or fck − 2 (M15); no cube more than 15% from the mean; 7 days indicative'),
  ('slump', '2000-01-01', '{"tolerance": 25}', 'Within the specified slump ± 25 mm'),
  ('steel', '2000-01-01', '{"Fe415": {"yield": 415, "tensile": 485, "ratio": 1.10, "elongation": 14.5},
    "Fe500": {"yield": 500, "tensile": 545, "ratio": 1.08, "elongation": 12}, "Fe500D": {"yield": 500, "tensile": 565,
    "ratio": 1.10, "elongation": 16}, "Fe550": {"yield": 550, "tensile": 585, "ratio": 1.06, "elongation": 10}}',
    'IS 1786'),
  ('soil', '2000-01-01', '{"compaction": 95}', 'Field density at least 95% of the maximum dry density, unless specified'),
  ('brick', '2000-01-01', '{"waterAbsorption": 20}', 'IS 1077: compressive strength at least the class; absorption at most 20%');

CREATE TABLE qa.test (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cube', 'slump', 'steel', 'soil', 'brick')),
  sample_ref text NOT NULL DEFAULT '' CHECK (length(sample_ref) <= 60),
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 300),
  sampled_on date NOT NULL,
  tested_on date NOT NULL,
  spec jsonb NOT NULL,           -- what it must meet (grade, specified slump, class, ...)
  results jsonb NOT NULL,        -- what was measured
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'indicative')),
  findings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, number)
);
SELECT platform.secure_table('qa.test');
REVOKE UPDATE, DELETE, TRUNCATE ON qa.test FROM aerolith_app;

CREATE TABLE qa.ncr (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  source text NOT NULL CHECK (source IN ('test', 'inspection', 'checklist', 'manual')),
  test_id uuid REFERENCES qa.test (id),
  inspection_id uuid REFERENCES qa.inspection (id),
  checklist_id uuid REFERENCES qa.checklist (id),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 2000),
  root_cause text NOT NULL DEFAULT '' CHECK (length(root_cause) <= 2000),
  corrective_action text NOT NULL DEFAULT '' CHECK (length(corrective_action) <= 2000),
  responsible text NOT NULL DEFAULT '' CHECK (length(responsible) <= 120),
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'action_taken', 'closed')),
  action_by uuid REFERENCES platform."user" (id),
  action_on date,
  closed_by uuid REFERENCES platform."user" (id),
  closed_on date,
  closing_note text NOT NULL DEFAULT '' CHECK (length(closing_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  CHECK (closed_by IS NULL OR closed_by IS DISTINCT FROM action_by)
);
SELECT platform.secure_table('qa.ncr');
REVOKE DELETE, TRUNCATE ON qa.ncr FROM aerolith_app;

CREATE TABLE qa.snag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  area text NOT NULL CHECK (length(trim(area)) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'closed')),
  fixed_on date,
  closed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX snag_project ON qa.snag (project_id, area);
SELECT platform.secure_table('qa.snag');
REVOKE DELETE, TRUNCATE ON qa.snag FROM aerolith_app;
ALTER TABLE qa.photo ADD FOREIGN KEY (snag_id) REFERENCES qa.snag (id);

-- An item a project buys only in an approved make.
CREATE TABLE qa.make_required (
  project_id uuid NOT NULL REFERENCES proj.project (id),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  PRIMARY KEY (project_id, resource_id)
);
SELECT platform.secure_table('qa.make_required');

CREATE TABLE qa.material_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  make text NOT NULL CHECK (length(trim(make)) BETWEEN 2 AND 120),
  sample_ref text NOT NULL DEFAULT '' CHECK (length(sample_ref) <= 60),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  comments text NOT NULL DEFAULT '' CHECK (length(comments) <= 1000),
  decided_on date,
  decided_by uuid REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX material_approval_item ON qa.material_approval (project_id, resource_id);
SELECT platform.secure_table('qa.material_approval');
REVOKE DELETE, TRUNCATE ON qa.material_approval FROM aerolith_app;
