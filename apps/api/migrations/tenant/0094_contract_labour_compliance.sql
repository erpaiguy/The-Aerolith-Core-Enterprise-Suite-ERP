-- Contract labour compliance (docs/wave8-plan.md step 8c.1). As principal employer the company answers for a labour
-- contractor's PF and ESI on its workers: each wage sheet works them out, the contractor's challans (with the TRRN or
-- challan number) are recorded against the month, and a subcontract bill waits while the licence has lapsed, a wage
-- sheet is below the minimum wage, or a month's PF or ESI is unpaid.
ALTER TABLE lab.wage_sheet
  ADD COLUMN pf_due numeric(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN esi_due numeric(20,2) NOT NULL DEFAULT 0;

CREATE TABLE lab.contractor_challan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES lab.contractor (party_id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  kind text NOT NULL CHECK (kind IN ('pf', 'esi')),
  reference text NOT NULL CHECK (length(trim(reference)) BETWEEN 3 AND 40),   -- TRRN for PF, challan no. for ESI
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  paid_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (party_id, kind, reference)
);
CREATE INDEX contractor_challan_month ON lab.contractor_challan (party_id, month);
SELECT platform.secure_table('lab.contractor_challan');
REVOKE UPDATE, DELETE, TRUNCATE ON lab.contractor_challan FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON lab.contractor_challan
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
