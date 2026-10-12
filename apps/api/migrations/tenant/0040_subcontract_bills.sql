-- Wave 3 step 5 (docs/wave3-plan.md): subcontract bills. A work order's measurement book; RA bills to the subcontractor
-- with retention, advance recovery, back-charges, labour cess and TDS, certified under the approval rules and then a
-- supplier's bill in payables; retention released at the end.

CREATE TABLE acc.subcontract_terms (
  order_id uuid PRIMARY KEY REFERENCES proc.purchase_order (id),
  retention_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (retention_pct BETWEEN 0 AND 100),
  retention_cap numeric(20,2) CHECK (retention_cap IS NULL OR retention_cap >= 0),
  advance_recovery_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (advance_recovery_pct BETWEEN 0 AND 100),
  labour_cess_pct numeric(5,2) NOT NULL DEFAULT 1 CHECK (labour_cess_pct BETWEEN 0 AND 10),
  tds_section text DEFAULT '194C',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
SELECT platform.secure_table('acc.subcontract_terms');
REVOKE DELETE, TRUNCATE ON acc.subcontract_terms FROM aerolith_app;

-- The work order's measurement book: never changed; a mistake is reversed by an entry the other way.
CREATE TABLE acc.wo_measurement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  line_key uuid NOT NULL,
  measured_on date NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty <> 0),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  reverses uuid UNIQUE REFERENCES acc.wo_measurement (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX wo_measurement_line ON acc.wo_measurement (order_id, line_key, measured_on);
SELECT platform.secure_table('acc.wo_measurement');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.wo_measurement FROM aerolith_app;

-- A supplier's bill can come from a subcontract bill or a retention release; those are cancelled at their source.
ALTER TABLE acc.vendor_bill ADD COLUMN source text CHECK (source IN ('subcontract', 'retention_release'));

CREATE TABLE acc.subcontract_bill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  ra_no int NOT NULL CHECK (ra_no > 0),
  upto date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'certified', 'cancelled')),
  status_reason text,
  terms jsonb NOT NULL,
  figures jsonb,                                       -- as certified
  vendor_bill_id uuid REFERENCES acc.vendor_bill (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (order_id, ra_no),
  CHECK ((status = 'certified') = (vendor_bill_id IS NOT NULL))
);
CREATE UNIQUE INDEX subcontract_bill_one_open ON acc.subcontract_bill (order_id) WHERE status IN ('draft', 'pending');
SELECT platform.secure_table('acc.subcontract_bill');
REVOKE DELETE, TRUNCATE ON acc.subcontract_bill FROM aerolith_app;

CREATE TABLE acc.subcontract_bill_line (
  bill_id uuid NOT NULL REFERENCES acc.subcontract_bill (id),
  line_key uuid NOT NULL,
  position int NOT NULL,
  description text NOT NULL,
  unit text NOT NULL,
  rate numeric(20,4) NOT NULL,
  gst_pct numeric(5,2) NOT NULL,
  prev_qty numeric(20,4) NOT NULL,
  measured_qty numeric(20,4) NOT NULL,
  cum_qty numeric(20,4) NOT NULL,
  PRIMARY KEY (bill_id, line_key)
);
SELECT platform.secure_table('acc.subcontract_bill_line');
REVOKE TRUNCATE ON acc.subcontract_bill_line FROM aerolith_app;

CREATE TABLE acc.subcontract_backcharge (
  bill_id uuid NOT NULL REFERENCES acc.subcontract_bill (id),
  position int NOT NULL,
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 200),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  PRIMARY KEY (bill_id, position)
);
SELECT platform.secure_table('acc.subcontract_backcharge');
REVOKE TRUNCATE ON acc.subcontract_backcharge FROM aerolith_app;
