-- Wave 1 step 9: enquiries to vendors and subcontractors (docs/04-features.md E8, docs/wave1-plan.md step 9).
-- An RFQ asks several vendors to price a package: BOQ items (work) or rate-library resources (materials). Quotes come
-- back typed in or as the filled enquiry workbook; the comparative statement ranks them; the chosen rates go into
-- the estimate (BOQ item rates, or dated resource rates). Tables listed in docs/05-database.md §5.

CREATE TABLE tender.rfq (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  number text NOT NULL UNIQUE,                         -- RFQ/2026-27/0001
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
  kind text NOT NULL CHECK (kind IN ('work', 'material')),
  due_on date,                                         -- quotes due
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'closed', 'cancelled')),
  terms text NOT NULL DEFAULT '' CHECK (length(terms) <= 8000),   -- scope, delivery, payment, validity asked for
  owner_id uuid REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX rfq_tender ON tender.rfq (tender_id);
SELECT platform.secure_table('tender.rfq');

-- What is asked for, as asked (a snapshot: the BOQ may change afterwards), with a link back to what it prices.
CREATE TABLE tender.rfq_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES tender.rfq (id) ON DELETE CASCADE,
  seq int NOT NULL CHECK (seq > 0),
  boq_id uuid REFERENCES est.boq (id),
  line_key uuid,                                       -- the BOQ item (stable across revisions)
  resource_id uuid REFERENCES est.resource (id),
  code text CHECK (length(code) <= 40),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 4000),
  unit text CHECK (length(unit) <= 20),
  qty numeric(20,4) CHECK (qty IS NULL OR qty >= 0),
  selected_party_id uuid REFERENCES platform.party (id),   -- the vendor chosen for this line
  selection_note text NOT NULL DEFAULT '' CHECK (length(selection_note) <= 1000),
  UNIQUE (rfq_id, seq),
  CHECK ((boq_id IS NULL) = (line_key IS NULL)),
  CHECK (line_key IS NULL OR resource_id IS NULL)
);
SELECT platform.secure_table('tender.rfq_line');

CREATE TABLE tender.rfq_vendor (
  rfq_id uuid NOT NULL REFERENCES tender.rfq (id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES platform.party (id),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'sent', 'quoted', 'declined')),
  sent_on date,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  PRIMARY KEY (rfq_id, party_id)
);
SELECT platform.secure_table('tender.rfq_vendor');

-- A vendor's quote; entering it again replaces it (the activity log keeps the earlier total).
CREATE TABLE tender.rfq_quote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL,
  party_id uuid NOT NULL,
  received_on date NOT NULL,
  valid_until date,
  reference text CHECK (length(reference) <= 100),
  gst_mode text NOT NULL DEFAULT 'extra' CHECK (gst_mode IN ('extra', 'included', 'exempt')),
  gst_pct numeric(5,2) NOT NULL DEFAULT 18 CHECK (gst_pct BETWEEN 0 AND 100),
  terms text NOT NULL DEFAULT '' CHECK (length(terms) <= 4000),  -- the vendor's conditions
  source text NOT NULL CHECK (source IN ('typed', 'file')),
  file_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  UNIQUE (rfq_id, party_id),
  FOREIGN KEY (rfq_id, party_id) REFERENCES tender.rfq_vendor (rfq_id, party_id) ON DELETE CASCADE
);
SELECT platform.secure_table('tender.rfq_quote');

-- Rates as quoted (with or without GST as the quote says); a line not priced has no row.
CREATE TABLE tender.rfq_quote_line (
  quote_id uuid NOT NULL REFERENCES tender.rfq_quote (id) ON DELETE CASCADE,
  line_id uuid NOT NULL REFERENCES tender.rfq_line (id) ON DELETE CASCADE,
  rate numeric(20,4) NOT NULL CHECK (rate >= 0),
  remark text NOT NULL DEFAULT '' CHECK (length(remark) <= 1000),
  PRIMARY KEY (quote_id, line_id)
);
CREATE INDEX rfq_quote_line_line ON tender.rfq_quote_line (line_id);
SELECT platform.secure_table('tender.rfq_quote_line');

-- RFQs are cancelled, not deleted.
REVOKE DELETE, TRUNCATE ON tender.rfq FROM aerolith_app;
