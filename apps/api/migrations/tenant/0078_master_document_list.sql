-- Master document list (docs/wave7-plan.md step 7d.3): the documents a project expects (drawings, approvals, test
-- certificates, method statements…) with who owes each and when; when it comes, the date and the file in the
-- project's documents. One still to come past its date is late.
CREATE TABLE proj.expected_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 60),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 300),
  category text NOT NULL DEFAULT 'drawing'
    CHECK (category IN ('drawing', 'specification', 'approval', 'method_statement', 'test_certificate', 'report', 'other')),
  from_party text NOT NULL DEFAULT '' CHECK (length(from_party) <= 200),   -- who owes it
  planned_on date NOT NULL,
  received_on date,
  document_id uuid REFERENCES doc.document (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, code)
);
CREATE INDEX expected_document_project ON proj.expected_document (project_id, planned_on);
SELECT platform.secure_table('proj.expected_document');
REVOKE TRUNCATE ON proj.expected_document FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON proj.expected_document
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
