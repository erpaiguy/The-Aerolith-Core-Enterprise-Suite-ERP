-- Wave 4 step 1 (docs/wave4-plan.md): cost control. Budget, committed, actual, cost to complete and forecast by WBS
-- element and cost code. Costs are placed ("charged") by rules worked when the report is read; these tables hold only
-- what people decide: allocations, the company's defaults, cost to complete, the original budget and month closes.
CREATE SCHEMA ctl;
GRANT USAGE ON SCHEMA ctl TO aerolith_app;

-- Where a cost with nothing better to go on is charged, by its source.
CREATE TABLE ctl.default_charge (
  source text PRIMARY KEY CHECK (source IN ('material', 'labour', 'equipment', 'subcontract', 'other', 'payroll',
    'equipment_costing', 'bocw_cess', 'depreciation', 'unordered_bill', 'other_entry')),
  cost_code_id uuid NOT NULL REFERENCES platform.cost_code (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('ctl.default_charge');

-- An order line (by its stable line key) or a ledger line placed by hand.
CREATE TABLE ctl.allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  po_id uuid REFERENCES proc.purchase_order (id),
  line_key uuid,
  voucher_id uuid REFERENCES acc.voucher (id),
  position int,
  wbs_id uuid REFERENCES proj.wbs (id),
  cost_code_id uuid REFERENCES platform.cost_code (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  CHECK ((po_id IS NOT NULL AND line_key IS NOT NULL AND voucher_id IS NULL AND position IS NULL)
    OR (po_id IS NULL AND line_key IS NULL AND voucher_id IS NOT NULL AND position IS NOT NULL)),
  CHECK (wbs_id IS NOT NULL OR cost_code_id IS NOT NULL)
);
CREATE UNIQUE INDEX allocation_order_line ON ctl.allocation (po_id, line_key) WHERE po_id IS NOT NULL;
CREATE UNIQUE INDEX allocation_ledger_line ON ctl.allocation (voucher_id, position) WHERE voucher_id IS NOT NULL;
CREATE INDEX allocation_project ON ctl.allocation (project_id);
SELECT platform.secure_table('ctl.allocation');

-- Cost to complete entered for a row (a WBS element and cost code, either may be empty).
CREATE TABLE ctl.ctc (
  project_id uuid NOT NULL REFERENCES proj.project (id),
  row_key text NOT NULL CHECK (row_key ~ '^[0-9a-f-]{0,36}\|[0-9a-f-]{0,36}$'),
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (project_id, row_key)
);
SELECT platform.secure_table('ctl.ctc');

-- The original budget, taken once: {rowKey: amount}.
CREATE TABLE ctl.baseline (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  rows jsonb NOT NULL,
  total numeric(20,2) NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  taken_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('ctl.baseline');
REVOKE UPDATE, DELETE, TRUNCATE ON ctl.baseline FROM aerolith_app;

-- A month closed: every row as it stood.
CREATE TABLE ctl.snapshot (
  project_id uuid NOT NULL REFERENCES proj.project (id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  rows jsonb NOT NULL,
  totals jsonb NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  taken_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (project_id, month)
);
SELECT platform.secure_table('ctl.snapshot');
REVOKE UPDATE, DELETE, TRUNCATE ON ctl.snapshot FROM aerolith_app;
