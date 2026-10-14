-- Meetings and actions (docs/wave7-plan.md step 7d.1): a project's minutes (who came, what was decided) and the
-- actions agreed, each with an owner and a date; open actions wait in their owner's work until done.
CREATE TABLE proj.meeting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,                                       -- MOM-001, per project
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  held_on date NOT NULL,
  place text NOT NULL DEFAULT '' CHECK (length(place) <= 200),
  attendees text NOT NULL DEFAULT '' CHECK (length(attendees) <= 4000),
  minutes text NOT NULL DEFAULT '' CHECK (length(minutes) <= 20000),
  decisions text NOT NULL DEFAULT '' CHECK (length(decisions) <= 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, number)
);
CREATE INDEX meeting_project ON proj.meeting (project_id, held_on DESC);
SELECT platform.secure_table('proj.meeting');
REVOKE DELETE, TRUNCATE ON proj.meeting FROM aerolith_app;

CREATE TABLE proj.meeting_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES proj.meeting (id),
  position int NOT NULL CHECK (position > 0),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 1000),
  owner_id uuid NOT NULL REFERENCES platform."user" (id),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_at timestamptz,
  done_by uuid REFERENCES platform."user" (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  UNIQUE (meeting_id, position),
  CHECK ((status = 'done') = (done_at IS NOT NULL))
);
CREATE INDEX meeting_action_owner ON proj.meeting_action (owner_id) WHERE status = 'open';
SELECT platform.secure_table('proj.meeting_action');
REVOKE DELETE, TRUNCATE ON proj.meeting_action FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON proj.meeting
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
