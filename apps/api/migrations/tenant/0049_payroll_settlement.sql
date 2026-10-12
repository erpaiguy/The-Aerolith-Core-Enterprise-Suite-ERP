-- Wave 3 step 12b (docs/wave3-plan.md): the full and final settlement (gratuity, leave encashment, notice) and the
-- gratuity rule as data with effective dates.
ALTER TABLE pay.rule
  DROP CONSTRAINT rule_kind_check,
  ADD CONSTRAINT rule_kind_check CHECK (kind IN ('wages', 'pf', 'esi', 'pt', 'lwf', 'income_tax', 'gratuity'));
INSERT INTO pay.rule (kind, state_code, effective_from, data, note) VALUES
  ('gratuity', NULL, '2025-11-21', '{"minYears": 5, "days": 15, "divisor": 26, "cap": 2000000}',
    'Code on Social Security: 15 days a year after five years (one for fixed-term staff); ₹20 lakh cap');

-- Fixed-term staff earn gratuity after one year.
ALTER TABLE hr.employee ADD COLUMN fixed_term boolean NOT NULL DEFAULT false;

CREATE TABLE pay.settlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL UNIQUE REFERENCES hr.employee (id),
  last_day date NOT NULL,
  reason text NOT NULL CHECK (reason IN ('resigned', 'retired', 'terminated', 'contract_ended', 'died')),
  wages numeric(20,2) NOT NULL,          -- the last month's wages (basic and dearness) for a full month
  monthly_gross numeric(20,2) NOT NULL,
  years int NOT NULL,
  gratuity numeric(20,2) NOT NULL DEFAULT 0,
  leave_days numeric(5,1) NOT NULL DEFAULT 0,
  encashment numeric(20,2) NOT NULL DEFAULT 0,
  notice_days numeric(5,1) NOT NULL DEFAULT 0,   -- negative: notice short, recovered
  notice_amount numeric(20,2) NOT NULL DEFAULT 0,
  total numeric(20,2) NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'paid')),
  voucher_id uuid REFERENCES acc.voucher (id),
  payment_voucher_id uuid REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
SELECT platform.secure_table('pay.settlement');
REVOKE TRUNCATE ON pay.settlement FROM aerolith_app;
