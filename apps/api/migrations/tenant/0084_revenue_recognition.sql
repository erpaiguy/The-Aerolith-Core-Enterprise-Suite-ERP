-- Revenue on work done (docs/wave8-plan.md step 8a.1, Ind AS 115): each month, per project, the share of the contract
-- complete (cost to date over estimated total cost, or measured value over contract value where there is no
-- estimate), the revenue that share earns, and the difference from what the bills have taken as revenue: a contract
-- asset (unbilled revenue) or a contract liability (billed in excess), with a provision for the rest of an expected
-- loss. Posted on the month's last day and reversed on the next month's first, so each month stands on its own.
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, x.code, x.name, 'ordinary', x.key
FROM (VALUES
  ('loans_and_advances', 'A5010', 'Unbilled revenue (contract asset)', 'unbilled_revenue'),
  ('other_current_liabilities', 'L4007', 'Billing in excess of revenue (contract liability)', 'billing_in_excess'),
  ('provisions', 'L6001', 'Provision for expected contract losses', 'contract_loss_provision'),
  ('other_expenses', 'X7005', 'Expected contract losses', 'contract_loss_expense')
) AS x(parent, code, name, key)
JOIN acc.account g ON g.system_key = x.parent
WHERE NOT EXISTS (SELECT 1 FROM acc.account a
  WHERE lower(a.code) = lower(x.code) OR lower(a.name) = lower(x.name) OR a.system_key = x.key);

CREATE TABLE acc.revenue_recognition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  method text NOT NULL CHECK (method IN ('cost', 'measured')),
  contract_value numeric(20,2) NOT NULL,
  estimated_cost numeric(20,2) NOT NULL,
  cost_to_date numeric(20,2) NOT NULL,
  measured_value numeric(20,2) NOT NULL,
  pct_complete numeric(9,6) NOT NULL CHECK (pct_complete BETWEEN 0 AND 1),
  recognised numeric(20,2) NOT NULL,      -- revenue earned to date
  billed numeric(20,2) NOT NULL,          -- what the bills have taken to revenue to date
  adjustment numeric(20,2) NOT NULL,      -- recognised − billed: > 0 contract asset, < 0 contract liability
  loss_provision numeric(20,2) NOT NULL DEFAULT 0 CHECK (loss_provision >= 0),
  voucher_id uuid REFERENCES acc.voucher (id),
  reversal_id uuid REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, month)
);
CREATE INDEX revenue_recognition_entity ON acc.revenue_recognition (entity_id, month);
SELECT platform.secure_table('acc.revenue_recognition');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.revenue_recognition FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.revenue_recognition
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
