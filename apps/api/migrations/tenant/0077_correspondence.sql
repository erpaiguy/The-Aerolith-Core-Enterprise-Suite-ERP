-- Correspondence register (docs/wave7-plan.md step 7d.2): a project's letters in and out, numbered IN-001 and
-- OUT-001, with the other side's reference, a reply owed by a date, the letter it answers, and the scan in the
-- project's documents.
CREATE TABLE proj.letter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  number text NOT NULL,
  letter_date date NOT NULL,
  party text NOT NULL CHECK (length(trim(party)) BETWEEN 2 AND 200),   -- from (in) or to (out)
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),  -- their number on it
  subject text NOT NULL CHECK (length(trim(subject)) BETWEEN 3 AND 300),
  summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 4000),
  reply_to uuid REFERENCES proj.letter (id),
  reply_by date,                                                        -- an answer owed by
  document_id uuid REFERENCES doc.document (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, number)
);
CREATE INDEX letter_project ON proj.letter (project_id, letter_date DESC);
SELECT platform.secure_table('proj.letter');
REVOKE DELETE, TRUNCATE ON proj.letter FROM aerolith_app;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON proj.letter
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
