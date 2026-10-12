-- Wave 3 step 15 (docs/wave3-plan.md): safety. Incidents investigated to closure, permits to work, toolbox talks.
-- (Safety inspections are step 14's checklists; man-hours come from attendance and musters.)
CREATE SCHEMA hse;
GRANT USAGE ON SCHEMA hse TO aerolith_app;

CREATE TABLE hse.incident (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  site_id uuid REFERENCES proj.site (id),
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('near_miss', 'first_aid', 'medical', 'lost_time', 'fatal', 'property_damage')),
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 300),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 3000),
  employee_id uuid REFERENCES hr.employee (id),
  worker_id uuid REFERENCES lab.worker (id),
  injured_name text NOT NULL DEFAULT '' CHECK (length(injured_name) <= 200),
  days_lost int NOT NULL DEFAULT 0 CHECK (days_lost >= 0),
  root_cause text NOT NULL DEFAULT '' CHECK (length(root_cause) <= 3000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigated', 'closed')),
  closed_by uuid REFERENCES platform."user" (id),
  closed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  CHECK (kind IN ('lost_time', 'fatal') OR days_lost = 0)
);
CREATE INDEX incident_project ON hse.incident (project_id, occurred_at);
SELECT platform.secure_table('hse.incident');
REVOKE DELETE, TRUNCATE ON hse.incident FROM aerolith_app;

CREATE TABLE hse.incident_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES hse.incident (id),
  action text NOT NULL CHECK (length(trim(action)) BETWEEN 3 AND 1000),
  owner text NOT NULL DEFAULT '' CHECK (length(owner) <= 120),
  due_on date,
  done_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('hse.incident_action');
REVOKE DELETE, TRUNCATE ON hse.incident_action FROM aerolith_app;

CREATE TABLE hse.permit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  site_id uuid REFERENCES proj.site (id),
  kind text NOT NULL CHECK (kind IN ('height', 'hot_work', 'confined_space', 'excavation', 'electrical')),
  location text NOT NULL CHECK (length(trim(location)) BETWEEN 2 AND 300),
  work text NOT NULL CHECK (length(trim(work)) BETWEEN 3 AND 1000),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  precautions jsonb NOT NULL DEFAULT '[]',     -- [{text, confirmed}]
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'issued', 'closed', 'cancelled')),
  requested_by uuid NOT NULL REFERENCES platform."user" (id),
  issued_by uuid REFERENCES platform."user" (id),
  issued_at timestamptz,
  closed_by uuid REFERENCES platform."user" (id),
  closed_at timestamptz,
  closing_note text NOT NULL DEFAULT '' CHECK (length(closing_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  CHECK (valid_to > valid_from AND valid_to <= valid_from + interval '12 hours'),
  CHECK (issued_by IS NULL OR issued_by <> requested_by)
);
SELECT platform.secure_table('hse.permit');
REVOKE DELETE, TRUNCATE ON hse.permit FROM aerolith_app;

CREATE TABLE hse.toolbox_talk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  site_id uuid REFERENCES proj.site (id),
  held_on date NOT NULL,
  topic text NOT NULL CHECK (length(trim(topic)) BETWEEN 3 AND 200),
  speaker text NOT NULL DEFAULT '' CHECK (length(speaker) <= 120),
  employee_ids uuid[] NOT NULL DEFAULT '{}',
  worker_ids uuid[] NOT NULL DEFAULT '{}',
  others int NOT NULL DEFAULT 0 CHECK (others >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX toolbox_project ON hse.toolbox_talk (project_id, held_on);
SELECT platform.secure_table('hse.toolbox_talk');
REVOKE UPDATE, DELETE, TRUNCATE ON hse.toolbox_talk FROM aerolith_app;
