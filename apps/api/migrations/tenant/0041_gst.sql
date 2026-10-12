-- Wave 3 step 6a (docs/wave3-plan.md): GST. The details the returns and the e-invoice need; credit notes to clients;
-- input tax blocked by ledger; e-invoice IRNs recorded; the supplier-filed GSTR-2B kept per month to match.

ALTER TABLE platform.entity
  ADD COLUMN city text NOT NULL DEFAULT '' CHECK (length(city) <= 100),
  ADD COLUMN pincode text CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
  ADD COLUMN e_invoicing boolean NOT NULL DEFAULT false;
ALTER TABLE platform.party
  ADD COLUMN legal_name text CHECK (legal_name IS NULL OR length(legal_name) <= 200),
  ADD COLUMN city text NOT NULL DEFAULT '' CHECK (length(city) <= 100),
  ADD COLUMN pincode text CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
  ADD COLUMN state_code text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  ADD COLUMN tan text CHECK (tan IS NULL OR tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$');

-- The SAC or HSN the project's invoices carry: 9954, construction services, by default.
ALTER TABLE acc.bill_terms ADD COLUMN sac text NOT NULL DEFAULT '9954' CHECK (sac ~ '^[0-9]{4,8}$');

-- Section 17(5) and the like: a supplier's bill line to such a ledger takes its GST into the expense.
ALTER TABLE acc.account ADD COLUMN itc_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE acc.vendor_bill ADD COLUMN itc_blocked numeric(20,2) NOT NULL DEFAULT 0 CHECK (itc_blocked >= 0);

-- A credit note to a client against a certified bill's tax invoice. Never changed.
CREATE TABLE acc.credit_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  bill_id uuid NOT NULL REFERENCES acc.client_bill (id),
  number text NOT NULL UNIQUE,
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
CREATE INDEX credit_note_bill ON acc.credit_note (bill_id);
SELECT platform.secure_table('acc.credit_note');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.credit_note FROM aerolith_app;

-- What the IRP returned for an invoice or credit note.
CREATE TABLE acc.e_invoice (
  doc_kind text NOT NULL CHECK (doc_kind IN ('invoice', 'credit_note')),
  doc_id uuid NOT NULL,
  irn text NOT NULL CHECK (irn ~ '^[0-9a-f]{64}$'),
  ack_no text NOT NULL CHECK (length(ack_no) BETWEEN 1 AND 30),
  ack_date timestamptz NOT NULL,
  signed_qr text NOT NULL CHECK (length(signed_qr) BETWEEN 10 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (doc_kind, doc_id)
);
SELECT platform.secure_table('acc.e_invoice');
REVOKE UPDATE, TRUNCATE ON acc.e_invoice FROM aerolith_app;

-- The supplier-filed GSTR-2B for a month, as uploaded; replaced by a new upload.
CREATE TABLE acc.gstr2b (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  file_name text NOT NULL DEFAULT '',
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid REFERENCES platform."user" (id),
  UNIQUE (entity_id, period)
);
SELECT platform.secure_table('acc.gstr2b');
REVOKE UPDATE, TRUNCATE ON acc.gstr2b FROM aerolith_app;

CREATE TABLE acc.gstr2b_line (
  upload_id uuid NOT NULL REFERENCES acc.gstr2b (id) ON DELETE CASCADE,
  position int NOT NULL,
  ctin text NOT NULL,
  trade_name text NOT NULL DEFAULT '',
  inum text NOT NULL,
  idate date NOT NULL,
  value numeric(20,2) NOT NULL,
  taxable numeric(20,2) NOT NULL,
  igst numeric(20,2) NOT NULL DEFAULT 0,
  cgst numeric(20,2) NOT NULL DEFAULT 0,
  sgst numeric(20,2) NOT NULL DEFAULT 0,
  itc_available boolean NOT NULL DEFAULT true,
  PRIMARY KEY (upload_id, position)
);
SELECT platform.secure_table('acc.gstr2b_line');
REVOKE UPDATE, TRUNCATE ON acc.gstr2b_line FROM aerolith_app;
