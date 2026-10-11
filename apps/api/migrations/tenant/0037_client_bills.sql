-- Wave 3 step 2 (docs/wave3-plan.md): client RA bills. A project's contract terms (GST, retention, the mobilisation
-- advance and its recovery, escalation); each running account bill made from the measurement book up to a date, less
-- what the previous certified bill certified; submitted through the approval rules; certified by the client (often
-- for less), which makes it a tax invoice and posts it to the books.

CREATE TABLE acc.bill_terms (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  gst_pct numeric(5,2) NOT NULL DEFAULT 18 CHECK (gst_pct BETWEEN 0 AND 28),
  retention_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (retention_pct BETWEEN 0 AND 100),
  retention_cap numeric(20,2) CHECK (retention_cap IS NULL OR retention_cap >= 0),
  advance_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
  advance_recovery_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (advance_recovery_pct BETWEEN 0 AND 100),
  -- {factor, components: [{key, name, sharePct, baseIndex}]}, or null for no price variation.
  escalation jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
SELECT platform.secure_table('acc.bill_terms');
REVOKE DELETE, TRUNCATE ON acc.bill_terms FROM aerolith_app;

CREATE TABLE acc.client_bill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  ra_no int NOT NULL CHECK (ra_no > 0),
  site_id uuid NOT NULL REFERENCES proj.site (id),
  upto date NOT NULL,                                   -- measured up to
  -- draft; pending (the approval rules); submitted (to the client); certified; cancelled
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'submitted', 'certified', 'cancelled')),
  status_reason text,
  terms jsonb NOT NULL,                                 -- the contract terms this bill used
  indices jsonb NOT NULL DEFAULT '{}',                  -- this period's escalation index per component
  intra boolean NOT NULL,                               -- CGST and SGST (the site in the company's state), else IGST
  submitted jsonb,                                      -- the figures as submitted
  certified jsonb,                                      -- the figures as certified
  client_ref text NOT NULL DEFAULT '' CHECK (length(client_ref) <= 100),
  certified_on date,
  invoice_no text UNIQUE,
  invoice_date date,
  voucher_id uuid REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, ra_no),
  CHECK (status <> 'certified' OR (certified IS NOT NULL AND invoice_no IS NOT NULL AND voucher_id IS NOT NULL))
);
-- One bill in the making per project: the next waits for this one's certificate.
CREATE UNIQUE INDEX client_bill_one_open ON acc.client_bill (project_id) WHERE status IN ('draft', 'pending', 'submitted');
SELECT platform.secure_table('acc.client_bill');
REVOKE DELETE, TRUNCATE ON acc.client_bill FROM aerolith_app;

CREATE TABLE acc.client_bill_line (
  bill_id uuid NOT NULL REFERENCES acc.client_bill (id),
  line_key uuid NOT NULL,
  position int NOT NULL,
  code text,
  description text NOT NULL,
  unit text,
  rate numeric(20,4) NOT NULL,
  contract_qty numeric(20,4),
  prev_qty numeric(20,4) NOT NULL,                      -- cumulative, as the previous bill was certified
  measured_qty numeric(20,4) NOT NULL,                  -- cumulative in the measurement book up to the bill's date
  cum_qty numeric(20,4) NOT NULL,                       -- cumulative, as billed
  cert_qty numeric(20,4),                               -- cumulative, as certified
  PRIMARY KEY (bill_id, line_key)
);
SELECT platform.secure_table('acc.client_bill_line');
REVOKE TRUNCATE ON acc.client_bill_line FROM aerolith_app;

-- Other deductions the client makes on the bill (labour cess, water, materials supplied), each to its ledger.
CREATE TABLE acc.client_bill_deduction (
  bill_id uuid NOT NULL REFERENCES acc.client_bill (id),
  position int NOT NULL,
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 200),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  PRIMARY KEY (bill_id, position)
);
SELECT platform.secure_table('acc.client_bill_deduction');
REVOKE TRUNCATE ON acc.client_bill_deduction FROM aerolith_app;
