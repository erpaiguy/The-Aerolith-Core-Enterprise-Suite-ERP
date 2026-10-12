-- Wave 4 step 2 (docs/wave4-plan.md): cash flow. Nothing recorded when money is expected, so each project has cash
-- terms (with defaults when it has none), and the company its overheads.
CREATE TABLE ctl.cash_terms (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  certify_days int NOT NULL DEFAULT 30 CHECK (certify_days BETWEEN 0 AND 365),
  client_pay_days int NOT NULL DEFAULT 30 CHECK (client_pay_days BETWEEN 0 AND 365),
  client_tds_pct numeric(5,2) NOT NULL DEFAULT 2 CHECK (client_tds_pct BETWEEN 0 AND 20),
  supplier_days int NOT NULL DEFAULT 30 CHECK (supplier_days BETWEEN 0 AND 365),
  cost_days int NOT NULL DEFAULT 30 CHECK (cost_days BETWEEN 0 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
SELECT platform.secure_table('ctl.cash_terms');

-- The company's own spending not booked to projects (head office), per month, for the forecast.
CREATE TABLE ctl.cash_settings (
  entity_id uuid PRIMARY KEY REFERENCES platform.entity (id),
  overheads_monthly numeric(20,2) NOT NULL DEFAULT 0 CHECK (overheads_monthly >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('ctl.cash_settings');
