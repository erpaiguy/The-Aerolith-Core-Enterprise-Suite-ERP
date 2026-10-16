-- Material at site and accruals (docs/wave8-plan.md step 8a.2): at each month's end, per project, the goods received
-- and accepted but not yet invoiced (at order rates), the subcontract work measured but not yet in a certified bill
-- (at work-order rates), and the stock lying in the project's stores (moved out of expense into inventory). One
-- journal on the month's last day, reversed on the next month's first.
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, 'L4008', 'Subcontract work accrued', 'ordinary', 'subcontract_accrued'
FROM acc.account g
WHERE g.system_key = 'other_current_liabilities'
  AND NOT EXISTS (SELECT 1 FROM acc.account a
    WHERE lower(a.code) = 'l4008' OR lower(a.name) = 'subcontract work accrued' OR a.system_key = 'subcontract_accrued');

CREATE TABLE acc.month_end_accrual (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  goods_not_invoiced numeric(20,2) NOT NULL,
  work_not_billed numeric(20,2) NOT NULL,
  site_stock numeric(20,2) NOT NULL,
  voucher_id uuid REFERENCES acc.voucher (id),
  reversal_id uuid REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, month)
);
CREATE INDEX month_end_accrual_entity ON acc.month_end_accrual (entity_id, month);
SELECT platform.secure_table('acc.month_end_accrual');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.month_end_accrual FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.month_end_accrual
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
