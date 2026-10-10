-- Wave 2a step 1: projects (docs/04-features.md J1, docs/wave2a-plan.md). A project is what a won tender becomes, or a
-- job started directly. Visible to its team; the project's lead, and roles allowed to edit projects, change it.

CREATE SCHEMA proj;
GRANT USAGE ON SCHEMA proj TO aerolith_app;

CREATE TABLE proj.project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  number text NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 300),
  client_id uuid REFERENCES platform.party (id),
  tender_id uuid UNIQUE REFERENCES tender.tender (id),        -- the won tender it came from, if any
  client_ref text CHECK (client_ref IS NULL OR length(client_ref) <= 200),   -- work order / agreement number
  status text NOT NULL DEFAULT 'planned' CHECK (status IN
    ('planned', 'active', 'on_hold', 'completed', 'closed', 'cancelled')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 2000),
  contract_value numeric(20,2) CHECK (contract_value IS NULL OR contract_value >= 0),
  start_on date,
  planned_finish_on date,
  actual_finish_on date,
  location text CHECK (location IS NULL OR length(location) <= 300),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (planned_finish_on IS NULL OR start_on IS NULL OR planned_finish_on >= start_on),
  CHECK (actual_finish_on IS NULL OR start_on IS NULL OR actual_finish_on >= start_on)
);
CREATE INDEX project_status ON proj.project (status);
CREATE INDEX project_client ON proj.project (client_id);
SELECT platform.secure_table('proj.project');

-- Where the work is: a project can have several sites. The state decides GST's place of supply later (Wave 3).
CREATE TABLE proj.site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  address text CHECK (address IS NULL OR length(address) <= 1000),
  state_code text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),   -- GST state code, e.g. 27 Maharashtra
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX site_name ON proj.site (project_id, lower(name));
SELECT platform.secure_table('proj.site');

-- The team. lead: edits the project and its team; member: works on it; viewer: reads it.
CREATE TABLE proj.member (
  project_id uuid NOT NULL REFERENCES proj.project (id),
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  role text NOT NULL CHECK (role IN ('lead', 'member', 'viewer')),
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX member_user ON proj.member (user_id);
SELECT platform.secure_table('proj.member');

-- What happened on the project, newest first on its page.
CREATE TABLE proj.project_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES proj.project (id),
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  actor_id uuid REFERENCES platform."user" (id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_event_project ON proj.project_event (project_id, id DESC);
SELECT platform.secure_table('proj.project_event');
REVOKE UPDATE, DELETE, TRUNCATE ON proj.project_event FROM aerolith_app;
