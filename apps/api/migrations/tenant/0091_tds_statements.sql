-- TDS returns and certificates (docs/wave8-plan.md step 8b.3): a supplier's lower-deduction certificate (section 197)
-- with its rate, limit and validity, applied to their bills; salary TDS (section 192) from the payroll runs deposited
-- in challans, for the 24Q; Form 16A and the 26Q/24Q text files are worked from these.
CREATE TABLE acc.tds_certificate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  section text NOT NULL CHECK (section IN ('194C', '194J', '194I', '194Q')),
  cert_no text NOT NULL CHECK (length(trim(cert_no)) BETWEEN 1 AND 40),
  rate numeric(6,3) NOT NULL CHECK (rate >= 0 AND rate < 30),
  limit_amount numeric(20,2) NOT NULL CHECK (limit_amount > 0),
  valid_from date NOT NULL,
  valid_to date NOT NULL CHECK (valid_to >= valid_from),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (entity_id, cert_no)
);
CREATE INDEX tds_certificate_party ON acc.tds_certificate (party_id, section, valid_from);
SELECT platform.secure_table('acc.tds_certificate');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.tds_certificate FROM aerolith_app;

ALTER TABLE acc.vendor_bill ADD COLUMN tds_certificate_id uuid REFERENCES acc.tds_certificate (id);

-- A payroll run's TDS deposited in one challan (section 192).
CREATE TABLE acc.tds_salary_challan_line (
  challan_id uuid NOT NULL REFERENCES acc.tds_challan (id),
  run_id uuid NOT NULL UNIQUE REFERENCES pay.run (id),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (challan_id, run_id)
);
SELECT platform.secure_table('acc.tds_salary_challan_line');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.tds_salary_challan_line FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.tds_certificate
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
