-- Free-issue material to subcontractors (docs/wave8-plan.md step 8a.3): an issue from stores can name the work order
-- the material goes to; each work order says, per line, how much of a material a unit of its work should take, the
-- wastage allowed over that, and the penal rate for what goes beyond; the excess over the allowance, for the work
-- certified by a bill's date, is proposed as a back-charge on the bill and recorded once recovered.
ALTER TABLE proc.stock_issue ADD COLUMN order_id uuid REFERENCES proc.purchase_order (id);
CREATE INDEX stock_issue_order ON proc.stock_issue (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE acc.wo_material (
  order_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  line_key uuid NOT NULL,                                -- the work order line
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  per_unit numeric(20,6) NOT NULL CHECK (per_unit >= 0),
  wastage_pct numeric(6,2) NOT NULL DEFAULT 0 CHECK (wastage_pct BETWEEN 0 AND 100),
  penal_rate numeric(20,4) NOT NULL CHECK (penal_rate >= 0),
  PRIMARY KEY (order_id, line_key, resource_id)
);
SELECT platform.secure_table('acc.wo_material');
REVOKE TRUNCATE ON acc.wo_material FROM aerolith_app;

CREATE TABLE acc.wo_recovery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  bill_id uuid NOT NULL REFERENCES acc.subcontract_bill (id),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  rate numeric(20,4) NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (bill_id, resource_id)
);
SELECT platform.secure_table('acc.wo_recovery');
REVOKE UPDATE, TRUNCATE ON acc.wo_recovery FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.wo_material
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.wo_recovery
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
