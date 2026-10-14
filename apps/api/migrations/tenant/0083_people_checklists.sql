-- Joining and exit checklists (docs/wave7-plan.md step 7d.8): the steps when someone joins or leaves, per employee.
-- Steps the records answer (PAN, bank, UAN, a sign-in, a deployment; the sign-in closed, the settlement posted) are
-- worked out from them; the rest (letters, induction, handover, assets back) are ticked by HR with a note.
CREATE TABLE hr.checklist_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  kind text NOT NULL CHECK (kind IN ('joining', 'exit')),
  position int NOT NULL CHECK (position > 0),
  key text NOT NULL CHECK (key ~ '^[a-z_]{2,40}$'),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 200),
  done_on date,
  done_by uuid REFERENCES platform."user" (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, kind, key),
  UNIQUE (employee_id, kind, position)
);
SELECT platform.secure_table('hr.checklist_step');
REVOKE DELETE, TRUNCATE ON hr.checklist_step FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON hr.checklist_step
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
