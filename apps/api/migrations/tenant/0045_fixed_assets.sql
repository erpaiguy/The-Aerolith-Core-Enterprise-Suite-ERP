-- Wave 3 step 9 (docs/wave3-plan.md): fixed assets. Classes with the Companies Act life and method and the Income Tax
-- block's rate; the register with each asset's moves between sites; depreciation runs posted as journals; disposals.

-- The ledger a sale's gain or loss goes to (skipped where a tenant already used the code or name).
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, 'I2003', 'Profit or loss on sale of assets', 'ordinary', 'asset_sale_result'
FROM acc.account g
WHERE g.system_key = 'other_income'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = 'i2003'
    OR lower(a.name) = 'profit or loss on sale of assets');

CREATE TABLE acc.asset_class (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 2 AND 120),
  life_years numeric(5,2) NOT NULL CHECK (life_years > 0),
  method text NOT NULL CHECK (method IN ('slm', 'wdv')),
  residual_pct numeric(5,2) NOT NULL DEFAULT 5 CHECK (residual_pct BETWEEN 0 AND 100),
  it_rate numeric(5,2) NOT NULL CHECK (it_rate BETWEEN 0 AND 100),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
SELECT platform.secure_table('acc.asset_class');
REVOKE DELETE, TRUNCATE ON acc.asset_class FROM aerolith_app;

-- [Guessing] Schedule II lives and Income Tax block rates as known; the CA confirms them.
INSERT INTO acc.asset_class (name, life_years, method, it_rate, account_id)
SELECT x.name, x.life, x.method, x.rate, a.id
FROM (VALUES
  ('Plant and machinery', 15, 'slm', 15, 'plant_and_machinery'),
  ('Construction equipment', 12, 'slm', 15, 'plant_and_machinery'),
  ('Motor vehicles', 8, 'wdv', 15, 'vehicles'),
  ('Furniture and fittings', 10, 'slm', 10, 'furniture'),
  ('Office equipment', 5, 'slm', 15, 'furniture'),
  ('Computers', 3, 'slm', 40, 'computers')
) AS x(name, life, method, rate, key)
JOIN acc.account a ON a.system_key = x.key;

CREATE TABLE acc.asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  number text NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  class_id uuid NOT NULL REFERENCES acc.asset_class (id),
  source text NOT NULL CHECK (source IN ('bill', 'opening')),
  vendor_bill_id uuid REFERENCES acc.vendor_bill (id),
  purchased_on date NOT NULL,
  put_to_use_on date NOT NULL,
  cost numeric(20,2) NOT NULL CHECK (cost > 0),
  opening_depreciation numeric(20,2) NOT NULL DEFAULT 0 CHECK (opening_depreciation >= 0),
  it_opening_wdv numeric(20,2),                       -- the tax written-down value at the books' start (opening assets)
  serial_no text NOT NULL DEFAULT '' CHECK (length(serial_no) <= 100),
  custodian_id uuid REFERENCES platform."user" (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  disposed_on date,
  proceeds numeric(20,2),
  disposal_voucher_id uuid REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (put_to_use_on >= purchased_on),
  CHECK (opening_depreciation < cost),
  CHECK ((status = 'disposed') = (disposed_on IS NOT NULL))
);
SELECT platform.secure_table('acc.asset');
REVOKE DELETE, TRUNCATE ON acc.asset FROM aerolith_app;

-- Where an asset stood, from a date: the first entry when registered, then each transfer.
CREATE TABLE acc.asset_move (
  asset_id uuid NOT NULL REFERENCES acc.asset (id),
  moved_on date NOT NULL,
  project_id uuid REFERENCES proj.project (id),
  site_id uuid REFERENCES proj.site (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (asset_id, moved_on)
);
SELECT platform.secure_table('acc.asset_move');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.asset_move FROM aerolith_app;

CREATE TABLE acc.depreciation_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  upto date NOT NULL,
  total numeric(20,2) NOT NULL,
  voucher_id uuid REFERENCES acc.voucher (id),
  reversed_voucher_id uuid REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('acc.depreciation_run');
REVOKE DELETE, TRUNCATE ON acc.depreciation_run FROM aerolith_app;

CREATE TABLE acc.depreciation_line (
  run_id uuid NOT NULL REFERENCES acc.depreciation_run (id),
  asset_id uuid NOT NULL REFERENCES acc.asset (id),
  date_from date NOT NULL,
  date_to date NOT NULL,
  project_id uuid REFERENCES proj.project (id),
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (run_id, asset_id, date_from)
);
SELECT platform.secure_table('acc.depreciation_line');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.depreciation_line FROM aerolith_app;
