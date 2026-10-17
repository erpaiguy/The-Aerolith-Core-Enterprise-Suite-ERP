-- Payroll gaps (docs/wave8-plan.md step 8c.4): staff overtime approved by the day and paid in the month's run;
-- loans and salary advances given from the bank and recovered by equal instalments in the runs; and employees' tax
-- declarations under the old regime, with proofs verified by payroll, which the run's TDS then counts.
CREATE TABLE pay.overtime (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  day date NOT NULL,
  hours numeric(4,1) NOT NULL CHECK (hours > 0 AND hours <= 16),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (employee_id, day)
);
SELECT platform.secure_table('pay.overtime');
REVOKE UPDATE, TRUNCATE ON pay.overtime FROM aerolith_app;

CREATE TABLE pay.loan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  kind text NOT NULL CHECK (kind IN ('loan', 'advance')),
  principal numeric(20,2) NOT NULL CHECK (principal > 0),
  emi numeric(20,2) NOT NULL CHECK (emi > 0),
  first_month date NOT NULL CHECK (extract(day FROM first_month) = 1),
  given_on date NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES acc.account (id),
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK (emi <= principal)
);
CREATE INDEX loan_employee ON pay.loan (employee_id);
SELECT platform.secure_table('pay.loan');
REVOKE UPDATE, DELETE, TRUNCATE ON pay.loan FROM aerolith_app;

CREATE TABLE pay.tax_declaration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  fy_start int NOT NULL CHECK (fy_start BETWEEN 2000 AND 2100),
  section text NOT NULL CHECK (section IN ('80C', '80CCD1B', '80D', '24b', 'HRA', '80E', '80G', 'other')),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  declared numeric(20,2) NOT NULL CHECK (declared >= 0),
  proved numeric(20,2) CHECK (proved >= 0),        -- what the proof shows, once verified
  verified_by uuid REFERENCES platform."user" (id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, fy_start, section, description)
);
SELECT platform.secure_table('pay.tax_declaration');
REVOKE DELETE, TRUNCATE ON pay.tax_declaration FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON pay.loan
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON pay.tax_declaration
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
