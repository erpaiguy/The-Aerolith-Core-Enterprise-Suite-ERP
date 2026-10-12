-- Wave 6 step 2 (docs/wave6-plan.md): real estate sales and RERA, Maharashtra first. A project's sales setup and its
-- designated account; towers and units; buyers and bookings; payment plans by construction milestone; demands with
-- GST and their receipts, both posted to the ledger; the designated account's deposits and certified withdrawals.
CREATE SCHEMA re;
GRANT USAGE ON SCHEMA re TO aerolith_app;

-- A buyer's ledger sits under debtors like a client's, but buyers stay out of client lists.
ALTER TABLE platform.party ADD COLUMN is_buyer boolean NOT NULL DEFAULT false;
-- Demands on flat buyers are advances until possession (skipped where a tenant already used the code or name; the
-- admin then maps the role).
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, 'L4006', 'Advances from flat buyers', 'ordinary', 'advances_from_buyers'
FROM acc.account g WHERE g.system_key = 'other_current_liabilities'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = 'l4006' OR lower(a.name) = 'advances from flat buyers');

CREATE TABLE re.setup (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  rera_number text NOT NULL DEFAULT '' CHECK (length(rera_number) <= 60),
  registered_on date,
  completion_on date,
  state text NOT NULL DEFAULT 'MH' CHECK (state IN ('MH')),
  collection_account_id uuid REFERENCES acc.account (id),
  designated_account_id uuid REFERENCES acc.account (id),
  share_pct numeric(5, 2) NOT NULL DEFAULT 70 CHECK (share_pct BETWEEN 70 AND 100),
  interest_pct numeric(5, 2) NOT NULL DEFAULT 10.75 CHECK (interest_pct BETWEEN 0 AND 30),
  pay_days int NOT NULL DEFAULT 15 CHECK (pay_days BETWEEN 1 AND 90),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  CHECK (collection_account_id IS NULL OR collection_account_id <> designated_account_id)
);
SELECT platform.secure_table('re.setup');

CREATE TABLE re.tower (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  floors int NOT NULL CHECK (floors BETWEEN 1 AND 200),
  UNIQUE (project_id, name)
);
SELECT platform.secure_table('re.tower');

CREATE TABLE re.unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tower_id uuid NOT NULL REFERENCES re.tower (id),
  floor int NOT NULL CHECK (floor BETWEEN -5 AND 200),
  number text NOT NULL CHECK (length(trim(number)) BETWEEN 1 AND 20),
  kind text NOT NULL DEFAULT 'flat' CHECK (kind IN ('flat', 'shop', 'office')),
  carpet_sqm numeric(10, 2) NOT NULL CHECK (carpet_sqm > 0),
  rate_per_sqm numeric(14, 2) NOT NULL CHECK (rate_per_sqm >= 0),
  parking numeric(14, 2) NOT NULL DEFAULT 0 CHECK (parking >= 0),
  charges numeric(14, 2) NOT NULL DEFAULT 0 CHECK (charges >= 0),
  gst_pct numeric(5, 2) NOT NULL DEFAULT 5 CHECK (gst_pct IN (0, 1, 5, 12)),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked', 'agreement')),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (tower_id, number)
);
SELECT platform.secure_table('re.unit');

CREATE TABLE re.plan_stage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  position int NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  pct numeric(5, 2) NOT NULL CHECK (pct > 0 AND pct <= 100),
  trigger text NOT NULL CHECK (trigger IN ('booking', 'agreement', 'milestone')),
  tower_id uuid REFERENCES re.tower (id),           -- a milestone is one tower's; NULL: every tower
  reached_on date,                                  -- a milestone's day, set by site
  reached_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, position),
  CHECK (trigger = 'milestone' OR reached_on IS NULL)
);
SELECT platform.secure_table('re.plan_stage');

CREATE TABLE re.buyer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  co_applicant text NOT NULL DEFAULT '' CHECK (length(co_applicant) <= 120),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  pan text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  address text NOT NULL DEFAULT '' CHECK (length(address) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.secure_table('re.buyer');

CREATE TABLE re.booking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  unit_id uuid NOT NULL REFERENCES re.unit (id),
  buyer_id uuid NOT NULL REFERENCES re.buyer (id),
  party_id uuid NOT NULL UNIQUE REFERENCES platform.party (id),   -- the buyer's ledger for this unit
  value numeric(16, 2) NOT NULL CHECK (value > 0),
  booked_on date NOT NULL,
  agreement_on date,
  agreement_number text NOT NULL DEFAULT '' CHECK (length(agreement_number) <= 60),
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'agreement', 'cancelled')),
  cancelled_on date,
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'agreement') = (agreement_on IS NOT NULL) OR status = 'cancelled')
);
CREATE UNIQUE INDEX booking_live_unit ON re.booking (unit_id) WHERE status <> 'cancelled';
SELECT platform.secure_table('re.booking');
REVOKE DELETE, TRUNCATE ON re.booking FROM aerolith_app;

CREATE TABLE re.demand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  booking_id uuid NOT NULL REFERENCES re.booking (id),
  stage_id uuid REFERENCES re.plan_stage (id),      -- NULL: delay interest
  kind text NOT NULL DEFAULT 'stage' CHECK (kind IN ('stage', 'interest')),
  raised_on date NOT NULL,
  due_on date NOT NULL,
  base numeric(16, 2) NOT NULL CHECK (base >= 0),
  cgst numeric(16, 2) NOT NULL DEFAULT 0,
  sgst numeric(16, 2) NOT NULL DEFAULT 0,
  paid numeric(16, 2) NOT NULL DEFAULT 0,
  voucher_id uuid,
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  CHECK ((kind = 'stage') = (stage_id IS NOT NULL)),
  CHECK (paid >= 0 AND paid <= base + cgst + sgst)
);
CREATE UNIQUE INDEX demand_once ON re.demand (booking_id, stage_id) WHERE stage_id IS NOT NULL;
SELECT platform.secure_table('re.demand');
REVOKE DELETE, TRUNCATE ON re.demand FROM aerolith_app;

CREATE TABLE re.receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  booking_id uuid NOT NULL REFERENCES re.booking (id),
  received_on date NOT NULL,
  amount numeric(16, 2) NOT NULL CHECK (amount > 0),
  gst_part numeric(16, 2) NOT NULL DEFAULT 0,       -- the GST inside what it settled
  rera_share numeric(16, 2) NOT NULL DEFAULT 0,     -- what it adds to the designated account's due
  unallocated numeric(16, 2) NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'bank' CHECK (mode IN ('bank', 'cheque', 'upi', 'neft', 'rtgs', 'loan')),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),
  voucher_id uuid,
  created_by uuid NOT NULL REFERENCES platform."user" (id)
);
SELECT platform.secure_table('re.receipt');
REVOKE DELETE, TRUNCATE ON re.receipt FROM aerolith_app;

CREATE TABLE re.receipt_allocation (
  receipt_id uuid NOT NULL REFERENCES re.receipt (id),
  demand_id uuid NOT NULL REFERENCES re.demand (id),
  amount numeric(16, 2) NOT NULL CHECK (amount > 0),
  gst numeric(16, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (receipt_id, demand_id)
);
SELECT platform.secure_table('re.receipt_allocation');

-- The designated account: deposits from the collection account, withdrawals against certified completion.
CREATE TABLE re.rera_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  kind text NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  on_date date NOT NULL,
  amount numeric(16, 2) NOT NULL CHECK (amount > 0),
  to_account_id uuid REFERENCES acc.account (id),   -- a withdrawal's destination
  completion_pct numeric(5, 2) CHECK (completion_pct IS NULL OR completion_pct BETWEEN 0 AND 100),
  engineer_ref text NOT NULL DEFAULT '' CHECK (length(engineer_ref) <= 100),
  architect_ref text NOT NULL DEFAULT '' CHECK (length(architect_ref) <= 100),
  ca_ref text NOT NULL DEFAULT '' CHECK (length(ca_ref) <= 100),
  voucher_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  CHECK (kind = 'deposit' OR (completion_pct IS NOT NULL AND to_account_id IS NOT NULL
    AND engineer_ref <> '' AND architect_ref <> '' AND ca_ref <> ''))
);
CREATE INDEX rera_entry_project ON re.rera_entry (project_id, on_date);
SELECT platform.secure_table('re.rera_entry');
REVOKE UPDATE, DELETE, TRUNCATE ON re.rera_entry FROM aerolith_app;
