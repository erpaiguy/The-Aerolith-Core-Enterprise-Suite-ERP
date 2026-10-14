-- Inspection and test plans (docs/wave7-plan.md step 7d.4): for each activity of a project, the checklist to fill and
-- the test to run, how often, and whether work stops for it (a hold point). What has been done against each line is
-- worked out from the project's checklists and tests.
CREATE TABLE qa.itp_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  position int NOT NULL CHECK (position > 0),
  activity text NOT NULL CHECK (length(trim(activity)) BETWEEN 2 AND 300),
  stage text NOT NULL DEFAULT 'during' CHECK (stage IN ('before', 'during', 'after')),
  checklist_template_id uuid REFERENCES qa.checklist_template (id),
  test_kind text CHECK (test_kind IN ('cube', 'slump', 'steel', 'soil', 'brick')),
  frequency text NOT NULL DEFAULT '' CHECK (length(frequency) <= 200),   -- "each pour", "per 50 cum"
  hold_point boolean NOT NULL DEFAULT false,
  responsible text NOT NULL DEFAULT '' CHECK (length(responsible) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, position),
  CHECK (checklist_template_id IS NOT NULL OR test_kind IS NOT NULL)
);
SELECT platform.secure_table('qa.itp_line');
REVOKE TRUNCATE ON qa.itp_line FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON qa.itp_line
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
