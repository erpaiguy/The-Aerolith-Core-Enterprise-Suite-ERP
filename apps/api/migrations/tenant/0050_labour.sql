-- Wave 3 step 13 (docs/wave3-plan.md): labour contractors. Contractors' licences, their workers, minimum wages as data
-- with effective dates, the daily muster by site, monthly wage sheets checked against the minimum wage and verified
-- as paid, and BOCW cess paid by project.
CREATE SCHEMA lab;
GRANT USAGE ON SCHEMA lab TO aerolith_app;

-- A supplier who supplies labour, with the licences an inspector asks for.
CREATE TABLE lab.contractor (
  party_id uuid PRIMARY KEY REFERENCES platform.party (id),
  licence_no text NOT NULL DEFAULT '' CHECK (length(licence_no) <= 60),     -- CLRA licence
  licence_workers int CHECK (licence_workers > 0),                          -- the most it allows
  licence_valid_to date,
  bocw_registration text NOT NULL DEFAULT '' CHECK (length(bocw_registration) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
SELECT platform.secure_table('lab.contractor');
REVOKE DELETE, TRUNCATE ON lab.contractor FROM aerolith_app;

CREATE TABLE lab.worker (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES lab.contractor (party_id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  relative text NOT NULL DEFAULT '' CHECK (length(relative) <= 200),      -- father's or husband's name
  gender text CHECK (gender IN ('female', 'male', 'other')),
  birth_date date,
  trade text NOT NULL CHECK (length(trim(trade)) BETWEEN 2 AND 60),
  skill text NOT NULL CHECK (skill IN ('unskilled', 'semi_skilled', 'skilled', 'highly_skilled')),
  daily_wage numeric(20,2) NOT NULL CHECK (daily_wage > 0),
  -- The DPDP Act, as for employees: Aadhaar's last four digits, only with the date of consent.
  aadhaar_last4 text CHECK (aadhaar_last4 ~ '^[0-9]{4}$'),
  aadhaar_consent_on date,
  uan text CHECK (uan ~ '^[0-9]{12}$'),
  esi_number text CHECK (esi_number ~ '^[0-9]{10,17}$'),
  joined_on date NOT NULL,
  left_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (aadhaar_last4 IS NULL OR aadhaar_consent_on IS NOT NULL),
  CHECK (left_on IS NULL OR left_on >= joined_on)
);
CREATE INDEX worker_party ON lab.worker (party_id, name);
SELECT platform.secure_table('lab.worker');
REVOKE DELETE, TRUNCATE ON lab.worker FROM aerolith_app;

-- The state's notified minimum daily wage by skill, from a date. Never changed: a new notification is a new row.
CREATE TABLE lab.min_wage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
  skill text NOT NULL CHECK (skill IN ('unskilled', 'semi_skilled', 'skilled', 'highly_skilled')),
  zone text NOT NULL DEFAULT '' CHECK (length(zone) <= 60),
  effective_from date NOT NULL,
  daily numeric(20,2) NOT NULL CHECK (daily > 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (state_code, skill, zone, effective_from)
);
SELECT platform.secure_table('lab.min_wage');
REVOKE UPDATE, DELETE, TRUNCATE ON lab.min_wage FROM aerolith_app;

-- The day's muster: a row per worker on the site that day.
CREATE TABLE lab.muster (
  site_id uuid NOT NULL REFERENCES proj.site (id),
  day date NOT NULL,
  worker_id uuid NOT NULL REFERENCES lab.worker (id),
  status text NOT NULL CHECK (status IN ('present', 'half_day', 'absent')),
  overtime_hours numeric(4,1) NOT NULL DEFAULT 0 CHECK (overtime_hours BETWEEN 0 AND 16),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (site_id, day, worker_id)
);
CREATE UNIQUE INDEX muster_worker_day ON lab.muster (worker_id, day);
SELECT platform.secure_table('lab.muster');
REVOKE TRUNCATE ON lab.muster FROM aerolith_app;

-- A contractor's month at a site: worked from the musters; passed only with no one below the minimum wage; verified
-- when the contractor shows they paid.
CREATE TABLE lab.wage_sheet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES lab.contractor (party_id),
  site_id uuid NOT NULL REFERENCES proj.site (id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'passed', 'verified')),
  lines jsonb NOT NULL DEFAULT '[]',
  total numeric(20,2) NOT NULL DEFAULT 0,
  shortfall numeric(20,2) NOT NULL DEFAULT 0,
  paid_on date,
  paid_reference text,
  paid_mode text CHECK (paid_mode IN ('bank', 'cash', 'upi')),
  worked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (party_id, site_id, month),
  CHECK ((status = 'verified') = (paid_on IS NOT NULL))
);
SELECT platform.secure_table('lab.wage_sheet');
REVOKE DELETE, TRUNCATE ON lab.wage_sheet FROM aerolith_app;

-- BOCW cess paid for a project (a challan), with its voucher.
CREATE TABLE lab.cess_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  paid_on date NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  reference text NOT NULL CHECK (length(trim(reference)) BETWEEN 2 AND 60),
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('lab.cess_payment');
REVOKE UPDATE, DELETE, TRUNCATE ON lab.cess_payment FROM aerolith_app;
