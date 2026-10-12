-- Wave 4 step 6 (docs/wave4-plan.md): the risk register. Risks per project (or company-wide) on the company's scales,
-- mitigation actions, and the contingency held in a project's budget drawn down against risks that occur.
CREATE TABLE ctl.risk_scale (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  probability jsonb NOT NULL,                      -- [{level 1-5, label, pct}]
  impact jsonb NOT NULL,                           -- [{level 1-5, label}]
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('ctl.risk_scale');

CREATE TABLE ctl.risk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES proj.project (id),    -- NULL: the company's
  number text NOT NULL,
  category text NOT NULL CHECK (category IN ('commercial', 'design', 'site', 'safety', 'regulatory', 'schedule', 'other')),
  cause text NOT NULL DEFAULT '' CHECK (length(cause) <= 2000),
  event text NOT NULL CHECK (length(trim(event)) BETWEEN 3 AND 1000),
  effect text NOT NULL DEFAULT '' CHECK (length(effect) <= 2000),
  probability int NOT NULL CHECK (probability BETWEEN 1 AND 5),
  impact int NOT NULL CHECK (impact BETWEEN 1 AND 5),
  cost_impact numeric(20,2) NOT NULL DEFAULT 0 CHECK (cost_impact >= 0),
  time_impact int NOT NULL DEFAULT 0 CHECK (time_impact >= 0),
  owner_id uuid REFERENCES platform."user" (id),
  wbs_id uuid REFERENCES proj.wbs (id),
  cost_code_id uuid REFERENCES platform.cost_code (id),
  plan_id uuid,
  activity_id bigint,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'occurred')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX risk_number ON ctl.risk (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), number);
SELECT platform.secure_table('ctl.risk');
REVOKE DELETE, TRUNCATE ON ctl.risk FROM aerolith_app;

CREATE TABLE ctl.risk_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_id uuid NOT NULL REFERENCES ctl.risk (id),
  action text NOT NULL CHECK (length(trim(action)) BETWEEN 3 AND 1000),
  due_on date,
  done_on date
);
SELECT platform.secure_table('ctl.risk_action');

CREATE TABLE ctl.contingency (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  held numeric(20,2) NOT NULL CHECK (held >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('ctl.contingency');

CREATE TABLE ctl.contingency_draw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  risk_id uuid NOT NULL REFERENCES ctl.risk (id),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  drawn_on date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX contingency_draw_project ON ctl.contingency_draw (project_id);
SELECT platform.secure_table('ctl.contingency_draw');
REVOKE UPDATE, DELETE, TRUNCATE ON ctl.contingency_draw FROM aerolith_app;
