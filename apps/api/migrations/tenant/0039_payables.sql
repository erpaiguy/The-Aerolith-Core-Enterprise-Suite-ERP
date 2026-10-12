-- Wave 3 step 4 (docs/wave3-plan.md): payables. Suppliers' bills matched to orders and receipts, TDS by section, input
-- GST, debit notes; payment runs under the approval rules with a file for the bank; advances applied to bills.

-- TDS sections as data with effective dates ([Guessing] every rate and threshold here is to be checked by the CA).
CREATE TABLE acc.tds_section (
  section text NOT NULL CHECK (section ~ '^[0-9A-Z()]{3,12}$'),
  effective_from date NOT NULL,
  label text NOT NULL,
  rate_company numeric(6,3) NOT NULL CHECK (rate_company >= 0),      -- companies, firms and others
  rate_individual numeric(6,3) NOT NULL CHECK (rate_individual >= 0),  -- individuals and HUFs (PAN 4th letter P or H)
  rate_no_pan numeric(6,3) NOT NULL CHECK (rate_no_pan >= 0),
  single_threshold numeric(20,2),       -- one bill above this is taxed
  year_threshold numeric(20,2),         -- once the year's bills pass this, all of them are
  PRIMARY KEY (section, effective_from)
);
SELECT platform.secure_table('acc.tds_section');
INSERT INTO acc.tds_section VALUES
  ('194C', '2020-04-01', 'Payments to contractors', 2, 1, 20, 30000, 100000),
  ('194J', '2020-04-01', 'Professional or technical fees', 10, 10, 20, NULL, 30000),
  ('194I', '2020-04-01', 'Rent of land or building', 10, 10, 20, NULL, 240000),
  ('194Q', '2021-07-01', 'Purchase of goods', 0.1, 0.1, 5, NULL, 5000000);

-- A supplier's default TDS section, and the bank account it is paid into.
ALTER TABLE platform.party
  ADD COLUMN tds_section text,
  ADD COLUMN bank_account_name text CHECK (bank_account_name IS NULL OR length(bank_account_name) <= 200),
  ADD COLUMN bank_account_no text CHECK (bank_account_no IS NULL OR bank_account_no ~ '^[0-9]{6,20}$'),
  ADD COLUMN bank_ifsc text CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

CREATE TABLE acc.vendor_bill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  order_id uuid REFERENCES proc.purchase_order (id),
  project_id uuid REFERENCES proj.project (id),
  bill_no text NOT NULL CHECK (length(trim(bill_no)) BETWEEN 1 AND 60),   -- the supplier's invoice number
  bill_date date NOT NULL,
  due_date date NOT NULL,
  supply text NOT NULL CHECK (supply IN ('intra', 'inter', 'unregistered')),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'posted', 'cancelled')),
  held_reasons jsonb NOT NULL DEFAULT '[]',
  pass_reason text,
  status_reason text,
  tds_section text,
  tds_rate numeric(6,3) NOT NULL DEFAULT 0,
  tds_base numeric(20,2) NOT NULL DEFAULT 0,          -- what the TDS was worked on (with any catch-up)
  taxable numeric(20,2) NOT NULL,
  cgst numeric(20,2) NOT NULL DEFAULT 0,
  sgst numeric(20,2) NOT NULL DEFAULT 0,
  igst numeric(20,2) NOT NULL DEFAULT 0,
  total numeric(20,2) NOT NULL,                       -- the invoice
  tds numeric(20,2) NOT NULL DEFAULT 0,
  payable numeric(20,2) NOT NULL,                     -- total − TDS
  voucher_id uuid REFERENCES acc.voucher (id),
  narration text NOT NULL DEFAULT '' CHECK (length(narration) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK ((status = 'posted') = (voucher_id IS NOT NULL))
);
-- A supplier's invoice number is entered once (per company).
CREATE UNIQUE INDEX vendor_bill_no ON acc.vendor_bill (entity_id, party_id, lower(bill_no)) WHERE status <> 'cancelled';
CREATE INDEX vendor_bill_order ON acc.vendor_bill (order_id) WHERE order_id IS NOT NULL;
SELECT platform.secure_table('acc.vendor_bill');
REVOKE DELETE, TRUNCATE ON acc.vendor_bill FROM aerolith_app;

CREATE TABLE acc.vendor_bill_line (
  bill_id uuid NOT NULL REFERENCES acc.vendor_bill (id),
  position int NOT NULL,
  line_key uuid,                                      -- the order line it bills
  account_id uuid NOT NULL REFERENCES acc.account (id),  -- where it posts
  project_id uuid REFERENCES proj.project (id),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1000),
  unit text,
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  rate numeric(20,4) NOT NULL CHECK (rate >= 0),
  gst_pct numeric(5,2) NOT NULL CHECK (gst_pct BETWEEN 0 AND 28),
  amount numeric(20,2) NOT NULL,
  gst numeric(20,2) NOT NULL,
  PRIMARY KEY (bill_id, position)
);
SELECT platform.secure_table('acc.vendor_bill_line');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.vendor_bill_line FROM aerolith_app;

CREATE TABLE acc.debit_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  bill_id uuid NOT NULL REFERENCES acc.vendor_bill (id),
  note_date date NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
  taxable numeric(20,2) NOT NULL CHECK (taxable > 0),
  gst_pct numeric(5,2) NOT NULL CHECK (gst_pct BETWEEN 0 AND 28),
  cgst numeric(20,2) NOT NULL DEFAULT 0,
  sgst numeric(20,2) NOT NULL DEFAULT 0,
  igst numeric(20,2) NOT NULL DEFAULT 0,
  total numeric(20,2) NOT NULL,
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('acc.debit_note');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.debit_note FROM aerolith_app;

CREATE TABLE acc.payment_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  number text NOT NULL UNIQUE,
  bank_account_id uuid NOT NULL REFERENCES acc.account (id),
  pay_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'paid', 'cancelled')),
  status_reason text,
  total numeric(20,2) NOT NULL DEFAULT 0,
  paid_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
SELECT platform.secure_table('acc.payment_run');
REVOKE DELETE, TRUNCATE ON acc.payment_run FROM aerolith_app;

CREATE TABLE acc.payment_run_line (
  run_id uuid NOT NULL REFERENCES acc.payment_run (id),
  position int NOT NULL,
  party_id uuid NOT NULL REFERENCES platform.party (id),
  kind text NOT NULL CHECK (kind IN ('bill', 'advance')),
  bill_id uuid REFERENCES acc.vendor_bill (id),
  project_id uuid REFERENCES proj.project (id),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  voucher_id uuid REFERENCES acc.voucher (id),         -- the supplier's payment voucher, once paid
  PRIMARY KEY (run_id, position),
  CHECK ((kind = 'bill') = (bill_id IS NOT NULL))
);
CREATE INDEX payment_run_line_bill ON acc.payment_run_line (bill_id) WHERE bill_id IS NOT NULL;
SELECT platform.secure_table('acc.payment_run_line');
REVOKE TRUNCATE ON acc.payment_run_line FROM aerolith_app;

-- An advance paid to a supplier, applied later to one of their bills.
CREATE TABLE acc.advance_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  bill_id uuid NOT NULL REFERENCES acc.vendor_bill (id),
  applied_on date NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('acc.advance_application');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.advance_application FROM aerolith_app;

-- TDS payable ledgers for the two sections the seeded chart lacked (skipped where a tenant already used the code or
-- name; the admin then maps the role).
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, x.code, x.name, 'tax', x.key
FROM acc.account g, (VALUES ('L5007', 'TDS payable 194I', 'tds_payable_194i'), ('L5008', 'TDS payable 194Q', 'tds_payable_194q'))
  AS x(code, name, key)
WHERE g.system_key = 'duties_and_taxes'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = lower(x.code) OR lower(a.name) = lower(x.name));
