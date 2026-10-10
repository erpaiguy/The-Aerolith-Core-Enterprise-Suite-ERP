-- Wave 2a step 3: WBS and cost codes (docs/04-features.md J3, docs/wave2a-plan.md). A project's work breakdown
-- structure; the company's cost codes (master data, docs/04-features.md P10); and each BOQ line of a project mapped to
-- a WBS element and a cost code.

-- The company's cost codes: a short tree (groups and codes), each of a kind of cost. Never deleted: retired codes are
-- made inactive, so what was mapped to them stays readable.
CREATE TABLE platform.cost_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES platform.cost_code (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'other'
    CHECK (kind IN ('material', 'labour', 'equipment', 'subcontract', 'overhead', 'other')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX cost_code_code ON platform.cost_code (lower(code));
CREATE INDEX cost_code_parent ON platform.cost_code (parent_id);
SELECT platform.secure_table('platform.cost_code');
REVOKE DELETE, TRUNCATE ON platform.cost_code FROM aerolith_app;

-- A project's WBS: a tree of elements, each with a code unique in the project. Siblings are ordered by position.
CREATE TABLE proj.wbs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  parent_id uuid,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, id),
  -- A parent in the same project.
  FOREIGN KEY (project_id, parent_id) REFERENCES proj.wbs (project_id, id),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX wbs_code ON proj.wbs (project_id, lower(code));
CREATE INDEX wbs_parent ON proj.wbs (project_id, parent_id, position);
SELECT platform.secure_table('proj.wbs');

-- BOQ lines of a project mapped to a WBS element and a cost code. By line key, so a contract BOQ line and its budget
-- line (copies share their key) are mapped together, and the mapping survives revisions.
CREATE TABLE proj.boq_line_map (
  project_id uuid NOT NULL REFERENCES proj.project (id),
  line_key uuid NOT NULL,
  wbs_id uuid,
  cost_code_id uuid REFERENCES platform.cost_code (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (project_id, line_key),
  FOREIGN KEY (project_id, wbs_id) REFERENCES proj.wbs (project_id, id)
);
CREATE INDEX boq_line_map_wbs ON proj.boq_line_map (project_id, wbs_id) WHERE wbs_id IS NOT NULL;
CREATE INDEX boq_line_map_cost_code ON proj.boq_line_map (cost_code_id) WHERE cost_code_id IS NOT NULL;
SELECT platform.secure_table('proj.boq_line_map');
