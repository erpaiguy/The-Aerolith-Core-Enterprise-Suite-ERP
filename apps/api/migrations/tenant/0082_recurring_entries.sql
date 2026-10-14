-- Recurring entries (docs/wave7-plan.md step 7d.7): a voucher or a supplier bill that comes round monthly, quarterly
-- or yearly (rent, AMCs, hire, insurance, an accrual). On each due day a draft of it waits for accounts, who post it as
-- it stands (or with the bill's number) or skip it; nothing reaches the books without a person posting it.
CREATE TABLE acc.recurring (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  kind text NOT NULL CHECK (kind IN ('voucher', 'bill')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  frequency text NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  day_of_month int NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  starts_on date NOT NULL,
  ends_on date,
  body jsonb NOT NULL,              -- a voucher's type, narration, reference and lines; a bill's party and lines
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX recurring_entity ON acc.recurring (entity_id);
SELECT platform.secure_table('acc.recurring');
REVOKE DELETE, TRUNCATE ON acc.recurring FROM aerolith_app;

CREATE TABLE acc.recurring_draft (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_id uuid NOT NULL REFERENCES acc.recurring (id),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'posted', 'skipped')),
  voucher_id uuid REFERENCES acc.voucher (id),
  bill_id uuid REFERENCES acc.vendor_bill (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  done_at timestamptz,
  done_by uuid REFERENCES platform."user" (id),
  UNIQUE (recurring_id, due_on),
  CHECK ((status = 'due') = (done_at IS NULL)),
  CHECK (status <> 'posted' OR voucher_id IS NOT NULL OR bill_id IS NOT NULL)
);
SELECT platform.secure_table('acc.recurring_draft');
REVOKE DELETE, TRUNCATE ON acc.recurring_draft FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.recurring
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.recurring_draft
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
