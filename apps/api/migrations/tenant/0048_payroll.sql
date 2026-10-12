-- Wave 3 step 12a (docs/wave3-plan.md): payroll. Compliance rules as data with effective dates, pay components, each
-- employee's salary from a date, the monthly run (worked, approved, posted, paid) and its lines.
CREATE SCHEMA pay;
GRANT USAGE ON SCHEMA pay TO aerolith_app;

-- Ledgers for the run (skipped where a tenant already used the code or name).
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key, needs_project)
SELECT g.id, false, g.nature, x.code, x.name, x.kind, x.key, false
FROM (VALUES
  ('other_current_liabilities', 'L4006', 'Salaries payable', 'salaries_payable', 'ordinary'),
  ('duties_and_taxes', 'L5012', 'TDS payable, salaries', 'tds_payable_salary', 'tax'),
  ('duties_and_taxes', 'L5013', 'PF payable', 'pf_payable', 'tax'),
  ('duties_and_taxes', 'L5009', 'ESI payable', 'esi_payable', 'tax'),
  ('duties_and_taxes', 'L5010', 'Professional tax payable', 'pt_payable', 'tax'),
  ('duties_and_taxes', 'L5011', 'Labour welfare fund payable', 'lwf_payable', 'tax')
) AS x(parent, code, name, key, kind)
JOIN acc.account g ON g.system_key = x.parent
WHERE NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = lower(x.code) OR lower(a.name) = lower(x.name)
  OR a.system_key = x.key);

-- The rules, a version from a date; a month is worked by the versions in force on its last day. Never changed: a
-- correction is a new version.
CREATE TABLE pay.rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('wages', 'pf', 'esi', 'pt', 'lwf', 'income_tax')),
  state_code text CHECK (state_code ~ '^[0-9]{2}$'),       -- PT and LWF are by state; the rest national
  effective_from date NOT NULL,
  data jsonb NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK ((kind IN ('pt', 'lwf')) = (state_code IS NOT NULL))
);
CREATE UNIQUE INDEX rule_version ON pay.rule (kind, coalesce(state_code, ''), effective_from);
SELECT platform.secure_table('pay.rule');
REVOKE UPDATE, DELETE, TRUNCATE ON pay.rule FROM aerolith_app;

-- Seeded as checked when building (October 2026, secondary sources); a payroll practitioner confirms them.
INSERT INTO pay.rule (kind, state_code, effective_from, data, note) VALUES
  ('wages', NULL, '2025-11-21', '{"excludedCap": 50}', 'Code on Wages: allowances beyond half the pay count as wages'),
  ('pf', NULL, '2014-09-01', '{"ceiling": 15000, "employeeRate": 12, "employerRate": 12, "epsRate": 8.33,
    "edliRate": 0.5, "adminRate": 0.5}', 'EPF, EPS, EDLI and admin charges'),
  ('pf', NULL, '2026-09-17', '{"ceiling": 25000, "employeeRate": 12, "employerRate": 12, "epsRate": 8.33,
    "edliRate": 0.5, "adminRate": 0.5}', 'Wage ceiling ₹25,000 (reported: S.O. 5109(E)); confirm'),
  ('esi', NULL, '2019-07-01', '{"ceiling": 21000, "employeeRate": 0.75, "employerRate": 3.25}', 'ESI'),
  ('pt', '27', '2023-04-01', '{"slabs": [{"from": 7501, "amount": 175, "gender": "male"},
    {"from": 10001, "amount": 200, "february": 300, "gender": "male"},
    {"from": 25001, "amount": 200, "february": 300, "gender": "female"}]}', 'Maharashtra professional tax'),
  ('lwf', '27', '2023-01-01', '{"employee": 25, "employer": 75, "months": [6, 12]}',
    'Maharashtra labour welfare fund, June and December'),
  ('income_tax', NULL, '2025-04-01', '{
    "new": {"slabs": [{"upTo": 400000, "rate": 0}, {"upTo": 800000, "rate": 5}, {"upTo": 1200000, "rate": 10},
      {"upTo": 1600000, "rate": 15}, {"upTo": 2000000, "rate": 20}, {"upTo": 2400000, "rate": 25},
      {"upTo": null, "rate": 30}], "standardDeduction": 75000, "rebateUpTo": 1200000, "marginalRelief": true,
      "cess": 4},
    "old": {"slabs": [{"upTo": 250000, "rate": 0}, {"upTo": 500000, "rate": 5}, {"upTo": 1000000, "rate": 20},
      {"upTo": null, "rate": 30}], "standardDeduction": 50000, "rebateUpTo": 500000, "marginalRelief": false,
      "cess": 4}}', 'Salary TDS: section 192, from 1 April 2026 section 392 of the Income-tax Act, 2025');

CREATE TABLE pay.component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{0,11}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 60),
  kind text NOT NULL CHECK (kind IN ('earning', 'deduction')),
  in_wages boolean NOT NULL DEFAULT false,   -- basic, dearness, retaining allowance: "wages" under the Code on Wages
  taxable boolean NOT NULL DEFAULT true,
  prorated boolean NOT NULL DEFAULT true,    -- cut for days not paid
  pos int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  CHECK (kind = 'earning' OR NOT in_wages)
);
SELECT platform.secure_table('pay.component');
REVOKE DELETE, TRUNCATE ON pay.component FROM aerolith_app;
INSERT INTO pay.component (code, name, kind, in_wages, taxable, prorated, pos) VALUES
  ('BASIC', 'Basic', 'earning', true, true, true, 10),
  ('DA', 'Dearness allowance', 'earning', true, true, true, 20),
  ('HRA', 'House rent allowance', 'earning', false, true, true, 30),
  ('CONV', 'Conveyance', 'earning', false, true, true, 40),
  ('SPECIAL', 'Special allowance', 'earning', false, true, true, 50),
  ('ARREARS', 'Arrears', 'earning', false, true, false, 90),
  ('ADVANCE', 'Advance recovered', 'deduction', false, false, false, 110),
  ('OTHER', 'Other deduction', 'deduction', false, false, false, 120);

-- An employee's salary from a date: each component's monthly amount or a percentage of basic.
CREATE TABLE pay.salary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  from_date date NOT NULL,
  pf_mode text NOT NULL DEFAULT 'ceiling' CHECK (pf_mode IN ('none', 'ceiling', 'actual')),
  esi boolean NOT NULL DEFAULT true,          -- false: never (e.g. excluded by the ESIC); true: by the ceiling
  regime text NOT NULL DEFAULT 'new' CHECK (regime IN ('new', 'old')),
  old_deductions numeric(20,2) NOT NULL DEFAULT 0 CHECK (old_deductions >= 0),  -- the year's, declared
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (employee_id, from_date)
);
SELECT platform.secure_table('pay.salary');
REVOKE UPDATE, DELETE, TRUNCATE ON pay.salary FROM aerolith_app;

CREATE TABLE pay.salary_line (
  salary_id uuid NOT NULL REFERENCES pay.salary (id),
  component_id uuid NOT NULL REFERENCES pay.component (id),
  amount numeric(20,2) CHECK (amount >= 0),
  percent_of_basic numeric(6,2) CHECK (percent_of_basic > 0),
  PRIMARY KEY (salary_id, component_id),
  CHECK ((amount IS NULL) <> (percent_of_basic IS NULL))
);
SELECT platform.secure_table('pay.salary_line');
REVOKE UPDATE, DELETE, TRUNCATE ON pay.salary_line FROM aerolith_app;

CREATE TABLE pay.run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'posted', 'paid')),
  voucher_id uuid REFERENCES acc.voucher (id),
  payment_voucher_id uuid REFERENCES acc.voucher (id),
  worked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (entity_id, month)
);
SELECT platform.secure_table('pay.run');
REVOKE DELETE, TRUNCATE ON pay.run FROM aerolith_app;

-- One-off pay and deductions typed into a draft run (arrears, an advance recovered).
CREATE TABLE pay.adjustment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES pay.run (id),
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  component_id uuid NOT NULL REFERENCES pay.component (id),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX adjustment_run ON pay.adjustment (run_id, employee_id);
SELECT platform.secure_table('pay.adjustment');

-- What the run worked out for each employee (replaced while the run is a draft).
CREATE TABLE pay.run_line (
  run_id uuid NOT NULL REFERENCES pay.run (id),
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  days numeric(4,1) NOT NULL,
  payable_days numeric(4,1) NOT NULL,
  earnings jsonb NOT NULL,       -- [{code, name, full, amount, oneOff}]
  deductions jsonb NOT NULL,     -- [{code, name, amount}] typed ones
  gross numeric(20,2) NOT NULL,
  wages numeric(20,2) NOT NULL,
  pf jsonb NOT NULL,
  esi_employee numeric(20,2) NOT NULL DEFAULT 0,
  esi_employer numeric(20,2) NOT NULL DEFAULT 0,
  pt numeric(20,2) NOT NULL DEFAULT 0,
  lwf_employee numeric(20,2) NOT NULL DEFAULT 0,
  lwf_employer numeric(20,2) NOT NULL DEFAULT 0,
  tds numeric(20,2) NOT NULL DEFAULT 0,
  taxable numeric(20,2) NOT NULL DEFAULT 0,
  net numeric(20,2) NOT NULL,
  split jsonb NOT NULL,          -- [{projectId, days}]
  tax jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, employee_id)
);
SELECT platform.secure_table('pay.run_line');
