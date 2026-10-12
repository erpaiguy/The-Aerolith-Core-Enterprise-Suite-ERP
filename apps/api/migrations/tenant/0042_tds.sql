-- Wave 3 step 6b (docs/wave3-plan.md): TDS. Challans that deposit what was deducted from suppliers, each deduction
-- deposited once; and the clients' deductions (26AS or AIS) uploaded per quarter to match against the receipts.

-- Interest and late fees on TDS deposited late (skipped where a tenant already used the code or name).
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, 'X7090', 'Interest and fees on TDS', 'ordinary', 'tds_interest'
FROM acc.account g
WHERE g.system_key = 'other_expenses'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = 'x7090' OR lower(a.name) = 'interest and fees on tds');

CREATE TABLE acc.tds_challan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  section text NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),   -- the month the tax was deducted
  deposited_on date NOT NULL,
  bsr_code text NOT NULL CHECK (bsr_code ~ '^[0-9]{7}$'),
  challan_no text NOT NULL CHECK (challan_no ~ '^[0-9]{5}$'),
  tax numeric(20,2) NOT NULL CHECK (tax > 0),
  interest numeric(20,2) NOT NULL DEFAULT 0 CHECK (interest >= 0),
  fee numeric(20,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  total numeric(20,2) NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES acc.account (id),
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (entity_id, bsr_code, deposited_on, challan_no)
);
SELECT platform.secure_table('acc.tds_challan');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.tds_challan FROM aerolith_app;

-- Each deduction (a supplier's bill's TDS) deposited in one challan.
CREATE TABLE acc.tds_challan_line (
  challan_id uuid NOT NULL REFERENCES acc.tds_challan (id),
  bill_id uuid NOT NULL UNIQUE REFERENCES acc.vendor_bill (id),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (challan_id, bill_id)
);
SELECT platform.secure_table('acc.tds_challan_line');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.tds_challan_line FROM aerolith_app;

-- What the clients reported deducting, for a quarter of a financial year, as uploaded; replaced by a new upload.
CREATE TABLE acc.tds_credit_upload (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  quarter text NOT NULL CHECK (quarter ~ '^[0-9]{4}-[0-9]{2}-Q[1-4]$'),   -- 2026-27-Q2
  file_name text NOT NULL DEFAULT '',
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid REFERENCES platform."user" (id),
  UNIQUE (entity_id, quarter)
);
SELECT platform.secure_table('acc.tds_credit_upload');
REVOKE UPDATE, TRUNCATE ON acc.tds_credit_upload FROM aerolith_app;

CREATE TABLE acc.tds_credit_line (
  upload_id uuid NOT NULL REFERENCES acc.tds_credit_upload (id) ON DELETE CASCADE,
  position int NOT NULL,
  tan text NOT NULL,
  deductor text NOT NULL DEFAULT '',
  amount numeric(20,2) NOT NULL DEFAULT 0,
  tds numeric(20,2) NOT NULL,
  PRIMARY KEY (upload_id, position)
);
SELECT platform.secure_table('acc.tds_credit_line');
REVOKE UPDATE, TRUNCATE ON acc.tds_credit_line FROM aerolith_app;
