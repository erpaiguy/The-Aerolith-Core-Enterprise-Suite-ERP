-- Safety inspections (docs/wave7-plan.md step 7d.5): a site walk (where, when, who walked, the safety checklist filled
-- on it if any) and what it found, each finding with a severity, an owner on the project's team and a date. The owner
-- or a safety manager closes a finding with what was done; a walk is closed when all its findings are.
CREATE TABLE hse.site_walk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,                                       -- SW-001, per project
  walked_on date NOT NULL,
  area text NOT NULL CHECK (length(trim(area)) BETWEEN 2 AND 300),
  walked_by text NOT NULL DEFAULT '' CHECK (length(walked_by) <= 300),
  checklist_id uuid REFERENCES qa.checklist (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, number)
);
CREATE INDEX site_walk_project ON hse.site_walk (project_id, walked_on DESC);
SELECT platform.secure_table('hse.site_walk');
REVOKE DELETE, TRUNCATE ON hse.site_walk FROM aerolith_app;

CREATE TABLE hse.walk_finding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  walk_id uuid NOT NULL REFERENCES hse.site_walk (id),
  position int NOT NULL CHECK (position > 0),
  observation text NOT NULL CHECK (length(trim(observation)) BETWEEN 2 AND 1000),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  action text NOT NULL DEFAULT '' CHECK (length(action) <= 1000),
  owner_id uuid NOT NULL REFERENCES platform."user" (id),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_on date,
  closed_by uuid REFERENCES platform."user" (id),
  closure text NOT NULL DEFAULT '' CHECK (length(closure) <= 1000),
  UNIQUE (walk_id, position),
  CHECK ((status = 'closed') = (closed_on IS NOT NULL))
);
CREATE INDEX walk_finding_owner ON hse.walk_finding (owner_id) WHERE status = 'open';
SELECT platform.secure_table('hse.walk_finding');
REVOKE DELETE, TRUNCATE ON hse.walk_finding FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON hse.site_walk
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON hse.walk_finding
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
