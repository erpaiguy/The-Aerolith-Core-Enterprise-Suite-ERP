-- Statutory payments and returns (docs/wave8-plan.md step 8c.3): each payroll run's PF, ESI, professional tax and
-- labour welfare fund paid by challan (PF with its TRRN), posted against the payables the run credited. The
-- Maharashtra PT return and Form 16 Part B with 12BA are worked from the runs.
CREATE TABLE pay.statutory_challan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES pay.run (id),
  kind text NOT NULL CHECK (kind IN ('pf', 'esi', 'pt', 'lwf')),
  reference text NOT NULL CHECK (length(trim(reference)) BETWEEN 3 AND 40),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  paid_on date NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES acc.account (id),
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (kind, reference)
);
CREATE INDEX statutory_challan_run ON pay.statutory_challan (run_id, kind);
SELECT platform.secure_table('pay.statutory_challan');
REVOKE UPDATE, DELETE, TRUNCATE ON pay.statutory_challan FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON pay.statutory_challan
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
