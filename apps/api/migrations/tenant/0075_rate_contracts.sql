-- Rate contracts (docs/wave7-plan.md step 7c.5): rates agreed with a supplier for resources over a period, perhaps up
-- to a quantity. An order to that supplier for those resources in the period takes the agreed rate; what has been
-- ordered against each line is worked out from the orders.
CREATE TABLE proc.rate_contract (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),   -- the supplier's or our own number
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  CHECK (valid_to >= valid_from)
);
CREATE INDEX rate_contract_party ON proc.rate_contract (party_id, valid_from);
SELECT platform.secure_table('proc.rate_contract');
REVOKE DELETE, TRUNCATE ON proc.rate_contract FROM aerolith_app;

CREATE TABLE proc.rate_contract_line (
  contract_id uuid NOT NULL REFERENCES proc.rate_contract (id),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  rate numeric(20,4) NOT NULL CHECK (rate >= 0),             -- before GST
  gst_pct numeric(5,2) NOT NULL DEFAULT 18 CHECK (gst_pct BETWEEN 0 AND 28),
  max_qty numeric(20,4) CHECK (max_qty IS NULL OR max_qty > 0),
  PRIMARY KEY (contract_id, resource_id)
);
SELECT platform.secure_table('proc.rate_contract_line');
REVOKE UPDATE, DELETE, TRUNCATE ON proc.rate_contract_line FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON proc.rate_contract
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
