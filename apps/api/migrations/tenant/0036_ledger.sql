-- Wave 3 step 1 (docs/wave3-plan.md): the ledger core. Companies (legal entities) keep their own books on one chart of
-- accounts for the tenant. Vouchers always balance and are never changed: a mistake is reversed by another voucher.
-- Months are locked per company. The database itself refuses an unbalanced voucher, an edit, and a locked month.

-- Companies: what an invoice and a return need to name.
ALTER TABLE platform.entity
  ADD COLUMN legal_name text NOT NULL DEFAULT '' CHECK (length(legal_name) <= 200),
  ADD COLUMN pan text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  ADD COLUMN tan text CHECK (tan IS NULL OR tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  ADD COLUMN address text NOT NULL DEFAULT '' CHECK (length(address) <= 1000),
  ADD COLUMN books_from date,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN row_version int NOT NULL DEFAULT 1;
ALTER TABLE platform.entity ADD CONSTRAINT entity_gstin CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$');
ALTER TABLE platform.entity ADD CONSTRAINT entity_state CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$');
ALTER TABLE platform.entity ADD CONSTRAINT entity_name CHECK (length(trim(name)) BETWEEN 2 AND 200);
CREATE UNIQUE INDEX entity_name_unique ON platform.entity (lower(name));
REVOKE DELETE, TRUNCATE ON platform.entity FROM aerolith_app;

CREATE SCHEMA acc;
GRANT USAGE ON SCHEMA acc TO aerolith_app;

-- The chart: groups and ledgers under five fixed roots. A ledger is never deleted, only closed.
CREATE TABLE acc.account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES acc.account (id),
  is_group boolean NOT NULL,
  nature text NOT NULL CHECK (nature IN ('equity', 'liability', 'asset', 'income', 'expense')),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9./-]{0,19}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  kind text NOT NULL DEFAULT 'ordinary' CHECK (kind IN ('ordinary', 'bank', 'cash', 'party', 'tax')),
  party_id uuid UNIQUE REFERENCES platform.party (id),
  needs_project boolean NOT NULL DEFAULT false,      -- its lines must name a project (a cost centre)
  system_key text UNIQUE,                            -- the seeded accounts, which the account map starts from
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1,
  CHECK ((parent_id IS NULL) = (system_key IS NOT NULL AND system_key LIKE 'root.%')),
  CHECK (NOT is_group OR kind = 'ordinary'),
  CHECK ((kind = 'party') = (party_id IS NOT NULL))
);
CREATE UNIQUE INDEX account_code ON acc.account (lower(code));
CREATE UNIQUE INDEX account_name ON acc.account (lower(name));
CREATE INDEX account_parent ON acc.account (parent_id);
SELECT platform.secure_table('acc.account');
REVOKE DELETE, TRUNCATE ON acc.account FROM aerolith_app;
CREATE SEQUENCE acc.party_code;

-- The account map: the roles posting rules use, per company.
CREATE TABLE acc.account_role (
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  role text NOT NULL CHECK (role ~ '^[a-z0-9_]{2,60}$'),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (entity_id, role)
);
SELECT platform.secure_table('acc.account_role');
REVOKE DELETE, TRUNCATE ON acc.account_role FROM aerolith_app;

-- Locked months. Reopening removes the row; both are in acc.period_event.
CREATE TABLE acc.period_lock (
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  locked_at timestamptz NOT NULL DEFAULT now(),
  locked_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (entity_id, month)
);
SELECT platform.secure_table('acc.period_lock');
REVOKE UPDATE, TRUNCATE ON acc.period_lock FROM aerolith_app;

CREATE TABLE acc.period_event (
  id bigserial PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  month date NOT NULL,
  action text NOT NULL CHECK (action IN ('locked', 'reopened')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
  at timestamptz NOT NULL DEFAULT now(),
  by_user uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('acc.period_event');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.period_event FROM aerolith_app;

CREATE TABLE acc.voucher (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  type text NOT NULL CHECK (type IN ('journal', 'payment', 'receipt', 'contra', 'sales', 'purchase', 'debit_note',
    'credit_note', 'opening')),
  number text NOT NULL,
  voucher_date date NOT NULL,
  narration text NOT NULL DEFAULT '' CHECK (length(narration) <= 2000),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),   -- cheque, UTR, the other side's bill no.
  total numeric(20,2) NOT NULL CHECK (total > 0),                         -- the debits (= the credits)
  reverses_id uuid UNIQUE REFERENCES acc.voucher (id),
  -- The document that posted it, from the later money steps (a client bill, a vendor bill); null when typed in.
  source_kind text,
  source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (entity_id, number),
  CHECK ((source_kind IS NULL) = (source_id IS NULL))
);
CREATE INDEX voucher_date ON acc.voucher (entity_id, voucher_date);
CREATE INDEX voucher_source ON acc.voucher (source_kind, source_id) WHERE source_id IS NOT NULL;
SELECT platform.secure_table('acc.voucher');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.voucher FROM aerolith_app;

CREATE TABLE acc.voucher_line (
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  position int NOT NULL CHECK (position > 0),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  debit numeric(20,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(20,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  project_id uuid REFERENCES proj.project (id),
  site_id uuid REFERENCES proj.site (id),
  cost_code_id uuid REFERENCES platform.cost_code (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  PRIMARY KEY (voucher_id, position),
  CHECK ((debit = 0) <> (credit = 0)),
  CHECK (site_id IS NULL OR project_id IS NOT NULL)
);
CREATE INDEX voucher_line_account ON acc.voucher_line (account_id);
CREATE INDEX voucher_line_project ON acc.voucher_line (project_id) WHERE project_id IS NOT NULL;
SELECT platform.secure_table('acc.voucher_line');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.voucher_line FROM aerolith_app;

-- A voucher dated in a locked month is refused.
CREATE FUNCTION acc.voucher_open_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM acc.period_lock
             WHERE entity_id = NEW.entity_id AND month = date_trunc('month', NEW.voucher_date)::date) THEN
    RAISE EXCEPTION 'period_locked: % is in a locked month', NEW.voucher_date USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_open_month BEFORE INSERT ON acc.voucher
  FOR EACH ROW EXECUTE FUNCTION acc.voucher_open_month();

-- A line posts to an open ledger (not a group), with a project when the ledger needs one.
CREATE FUNCTION acc.voucher_line_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  SELECT is_group, closed_at, needs_project, name INTO a FROM acc.account WHERE id = NEW.account_id;
  IF a.is_group THEN
    RAISE EXCEPTION 'not_a_ledger: % is a group', a.name USING ERRCODE = 'P0001';
  END IF;
  IF a.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'ledger_closed: % is closed', a.name USING ERRCODE = 'P0001';
  END IF;
  IF a.needs_project AND NEW.project_id IS NULL THEN
    RAISE EXCEPTION 'project_needed: % needs a project on each line', a.name USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_line_account BEFORE INSERT ON acc.voucher_line
  FOR EACH ROW EXECUTE FUNCTION acc.voucher_line_account();

-- At commit: every voucher has two lines or more, its debits equal its credits, and its total is that sum.
CREATE FUNCTION acc.voucher_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  vid uuid;
  t record;
BEGIN
  IF TG_TABLE_NAME = 'voucher' THEN
    vid := NEW.id;
  ELSE
    vid := NEW.voucher_id;
  END IF;
  SELECT count(*) AS n, coalesce(sum(debit), 0) AS dr, coalesce(sum(credit), 0) AS cr INTO t
  FROM acc.voucher_line WHERE voucher_id = vid;
  IF t.n < 2 OR t.dr <> t.cr OR t.dr <> (SELECT total FROM acc.voucher WHERE id = vid) THEN
    RAISE EXCEPTION 'unbalanced: voucher % has % lines, debits %, credits %', vid, t.n, t.dr, t.cr
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER voucher_balances AFTER INSERT ON acc.voucher
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acc.voucher_balances();
CREATE CONSTRAINT TRIGGER voucher_line_balances AFTER INSERT ON acc.voucher_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acc.voucher_balances();

-- The seeded chart: a construction contractor's, in Schedule III order.
CREATE FUNCTION acc.seed_account(p_key text, p_parent text, p_group boolean, p_code text, p_name text,
  p_kind text DEFAULT 'ordinary', p_project boolean DEFAULT false) RETURNS void LANGUAGE sql AS $$
  INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, needs_project, system_key)
  SELECT p.id, p_group, p.nature, p_code, p_name, p_kind, p_project, p_key FROM acc.account p WHERE p.system_key = p_parent
$$;
INSERT INTO acc.account (is_group, nature, code, name, system_key) VALUES
  (true, 'equity', 'E', 'Equity', 'root.equity'),
  (true, 'liability', 'L', 'Liabilities', 'root.liabilities'),
  (true, 'asset', 'A', 'Assets', 'root.assets'),
  (true, 'income', 'I', 'Income', 'root.income'),
  (true, 'expense', 'X', 'Expenses', 'root.expenses');
SELECT acc.seed_account('capital', 'root.equity', true, 'E10', 'Capital');
SELECT acc.seed_account('capital_account', 'capital', false, 'E1001', 'Capital account');
SELECT acc.seed_account('reserves', 'root.equity', true, 'E20', 'Reserves and surplus');
SELECT acc.seed_account('profit_and_loss', 'reserves', false, 'E2001', 'Profit and loss account');
SELECT acc.seed_account('long_term_borrowings', 'root.liabilities', true, 'L10', 'Long-term borrowings');
SELECT acc.seed_account('short_term_borrowings', 'root.liabilities', true, 'L20', 'Short-term borrowings');
SELECT acc.seed_account('sundry_creditors', 'root.liabilities', true, 'L30', 'Sundry creditors');
SELECT acc.seed_account('other_current_liabilities', 'root.liabilities', true, 'L40', 'Other current liabilities');
SELECT acc.seed_account('retention_payable', 'other_current_liabilities', false, 'L4001', 'Retention payable');
SELECT acc.seed_account('mobilisation_advance_received', 'other_current_liabilities', false, 'L4002',
  'Mobilisation advance received');
SELECT acc.seed_account('advances_from_clients', 'other_current_liabilities', false, 'L4003', 'Advances from clients');
SELECT acc.seed_account('grn_clearing', 'other_current_liabilities', false, 'L4004', 'Goods received, not invoiced');
SELECT acc.seed_account('security_deposits_received', 'other_current_liabilities', false, 'L4005',
  'Security deposits received');
SELECT acc.seed_account('duties_and_taxes', 'root.liabilities', true, 'L50', 'Duties and taxes');
SELECT acc.seed_account('output_cgst', 'duties_and_taxes', false, 'L5001', 'Output CGST', 'tax');
SELECT acc.seed_account('output_sgst', 'duties_and_taxes', false, 'L5002', 'Output SGST', 'tax');
SELECT acc.seed_account('output_igst', 'duties_and_taxes', false, 'L5003', 'Output IGST', 'tax');
SELECT acc.seed_account('tds_payable_194c', 'duties_and_taxes', false, 'L5004', 'TDS payable 194C', 'tax');
SELECT acc.seed_account('tds_payable_194j', 'duties_and_taxes', false, 'L5005', 'TDS payable 194J', 'tax');
SELECT acc.seed_account('labour_cess_payable', 'duties_and_taxes', false, 'L5006', 'Labour cess payable', 'tax');
SELECT acc.seed_account('provisions', 'root.liabilities', true, 'L60', 'Provisions');
SELECT acc.seed_account('fixed_assets', 'root.assets', true, 'A10', 'Fixed assets');
SELECT acc.seed_account('plant_and_machinery', 'fixed_assets', false, 'A1001', 'Plant and machinery');
SELECT acc.seed_account('vehicles', 'fixed_assets', false, 'A1002', 'Vehicles');
SELECT acc.seed_account('furniture', 'fixed_assets', false, 'A1003', 'Furniture and office equipment');
SELECT acc.seed_account('computers', 'fixed_assets', false, 'A1004', 'Computers');
SELECT acc.seed_account('inventories', 'root.assets', true, 'A20', 'Inventories');
SELECT acc.seed_account('stock', 'inventories', false, 'A2001', 'Stock of materials');
SELECT acc.seed_account('sundry_debtors', 'root.assets', true, 'A30', 'Sundry debtors');
SELECT acc.seed_account('cash_and_bank', 'root.assets', true, 'A40', 'Cash and bank');
SELECT acc.seed_account('cash', 'cash_and_bank', false, 'A4001', 'Cash in hand', 'cash');
SELECT acc.seed_account('loans_and_advances', 'root.assets', true, 'A50', 'Loans and advances');
SELECT acc.seed_account('advance_to_suppliers', 'loans_and_advances', false, 'A5001', 'Advances to suppliers');
SELECT acc.seed_account('retention_receivable', 'loans_and_advances', false, 'A5002', 'Retention receivable');
SELECT acc.seed_account('security_deposits_paid', 'loans_and_advances', false, 'A5003', 'Security deposits paid');
SELECT acc.seed_account('earnest_money', 'loans_and_advances', false, 'A5004', 'Earnest money deposits');
SELECT acc.seed_account('tds_receivable', 'loans_and_advances', false, 'A5005', 'TDS receivable', 'tax');
SELECT acc.seed_account('input_cgst', 'loans_and_advances', false, 'A5006', 'Input CGST', 'tax');
SELECT acc.seed_account('input_sgst', 'loans_and_advances', false, 'A5007', 'Input SGST', 'tax');
SELECT acc.seed_account('input_igst', 'loans_and_advances', false, 'A5008', 'Input IGST', 'tax');
SELECT acc.seed_account('staff_advances', 'loans_and_advances', false, 'A5009', 'Staff advances');
SELECT acc.seed_account('revenue', 'root.income', true, 'I10', 'Revenue from operations');
SELECT acc.seed_account('contract_revenue', 'revenue', false, 'I1001', 'Contract revenue', 'ordinary', true);
SELECT acc.seed_account('other_income', 'root.income', true, 'I20', 'Other income');
SELECT acc.seed_account('interest_income', 'other_income', false, 'I2001', 'Interest income');
SELECT acc.seed_account('scrap_sales', 'other_income', false, 'I2002', 'Scrap sales');
SELECT acc.seed_account('materials_consumed', 'root.expenses', true, 'X10', 'Cost of materials consumed');
SELECT acc.seed_account('material_consumption', 'materials_consumed', false, 'X1001', 'Material consumption', 'ordinary',
  true);
SELECT acc.seed_account('subcontract_and_labour', 'root.expenses', true, 'X20', 'Subcontract and labour');
SELECT acc.seed_account('subcontract_cost', 'subcontract_and_labour', false, 'X2001', 'Subcontract cost', 'ordinary', true);
SELECT acc.seed_account('labour_contractors', 'subcontract_and_labour', false, 'X2002', 'Labour contractor charges',
  'ordinary', true);
SELECT acc.seed_account('site_expenses', 'root.expenses', true, 'X30', 'Site expenses');
SELECT acc.seed_account('equipment_hire', 'site_expenses', false, 'X3001', 'Equipment hire', 'ordinary', true);
SELECT acc.seed_account('fuel', 'site_expenses', false, 'X3002', 'Fuel and lubricants', 'ordinary', true);
SELECT acc.seed_account('power_and_water', 'site_expenses', false, 'X3003', 'Power and water', 'ordinary', true);
SELECT acc.seed_account('site_overheads', 'site_expenses', false, 'X3004', 'Site overheads', 'ordinary', true);
SELECT acc.seed_account('employee_benefits', 'root.expenses', true, 'X40', 'Employee benefits');
SELECT acc.seed_account('salaries', 'employee_benefits', false, 'X4001', 'Salaries and wages');
SELECT acc.seed_account('pf_esi_contribution', 'employee_benefits', false, 'X4002', 'Contribution to PF and ESI');
SELECT acc.seed_account('finance_costs', 'root.expenses', true, 'X50', 'Finance costs');
SELECT acc.seed_account('interest_expense', 'finance_costs', false, 'X5001', 'Interest');
SELECT acc.seed_account('bank_charges', 'finance_costs', false, 'X5002', 'Bank charges');
SELECT acc.seed_account('depreciation_group', 'root.expenses', true, 'X60', 'Depreciation and amortisation');
SELECT acc.seed_account('depreciation', 'depreciation_group', false, 'X6001', 'Depreciation');
SELECT acc.seed_account('other_expenses', 'root.expenses', true, 'X70', 'Other expenses');
SELECT acc.seed_account('office_expenses', 'other_expenses', false, 'X7001', 'Office expenses');
SELECT acc.seed_account('rent', 'other_expenses', false, 'X7002', 'Rent');
SELECT acc.seed_account('professional_fees', 'other_expenses', false, 'X7003', 'Professional fees');
SELECT acc.seed_account('round_off', 'other_expenses', false, 'X7004', 'Round off');
DROP FUNCTION acc.seed_account(text, text, boolean, text, text, text, boolean);
