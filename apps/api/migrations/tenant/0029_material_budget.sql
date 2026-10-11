-- Wave 2b step 2 (docs/wave2b-plan.md): a project's material budget. Made once from the won tender's rate analyses (a
-- copy, never a link back to estimation), then revised by the project as it goes, each revision approved.

-- A tender's estimate is closed when its project takes its budget: frozen, and no new revision can be started.
ALTER TABLE est.boq
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid REFERENCES platform."user" (id),
  ADD COLUMN closed_reason text CHECK (closed_reason IS NULL OR length(closed_reason) <= 500);

-- The revisions of a project's material budget. Revision 0 is the first (from the tender, or started empty); each
-- later one starts as a copy of the budget in force. One revision is in force (approved) at a time; at most one is
-- being worked on (draft, submitted or rejected). A revision given up after it was submitted is kept, discarded.
CREATE TABLE proj.material_budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  revision int NOT NULL CHECK (revision >= 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'superseded', 'discarded')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 2000),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),   -- why this revision
  source text NOT NULL CHECK (source IN ('tender', 'blank', 'revision')),
  based_on uuid REFERENCES proj.material_budget (id),
  basis jsonb NOT NULL DEFAULT '{}',          -- revision 0 from a tender: which BOQs, versions, rate dates
  total numeric(20,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  approved_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, revision)
);
CREATE UNIQUE INDEX material_budget_in_force ON proj.material_budget (project_id) WHERE status = 'approved';
CREATE UNIQUE INDEX material_budget_open ON proj.material_budget (project_id)
  WHERE status IN ('draft', 'submitted', 'rejected');
SELECT platform.secure_table('proj.material_budget');

-- A revision's resources: what the project may use of each, at what rate. Code, name, kind and unit are copied, so
-- the budget reads as it was even if the rate library changes.
CREATE TABLE proj.material_budget_line (
  budget_id uuid NOT NULL REFERENCES proj.material_budget (id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  unit text NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty >= 0),
  rate numeric(20,4) CHECK (rate IS NULL OR rate >= 0),
  amount numeric(20,2),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  PRIMARY KEY (budget_id, resource_id)
);
SELECT platform.secure_table('proj.material_budget_line');

-- What one unit of each contract BOQ item takes of each resource, copied from its rate analysis (sub-analyses and
-- wastage worked in) when the budget was made: for requisitions from BOQ items and the look-ahead. `analysis_changed`:
-- the analysis was edited after the tender's version was frozen, so this may not be what was bid.
CREATE TABLE proj.material_norm (
  project_id uuid NOT NULL REFERENCES proj.project (id),
  line_key uuid NOT NULL,
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  per_unit numeric(28,12) NOT NULL CHECK (per_unit >= 0),
  analysis_code text NOT NULL,
  analysis_changed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (project_id, line_key, resource_id)
);
SELECT platform.secure_table('proj.material_norm');
REVOKE UPDATE, DELETE, TRUNCATE ON proj.material_norm FROM aerolith_app;
