-- The vendor master (docs/wave8-plan.md step 8e.1): trade categories, a vetting status with its reason (approved, on
-- hold, blacklisted), KYC documents with their expiry, and an enquiry's category. A company that buys only from
-- approved vendors turns that on; a blacklisted vendor is never offered an enquiry or given an order.
CREATE TABLE proc.trade_category (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  kind text NOT NULL CHECK (kind IN ('material', 'work', 'service')),
  active boolean NOT NULL DEFAULT true
);
INSERT INTO proc.trade_category (key, name, kind) VALUES
  ('cement', 'Cement', 'material'),
  ('steel', 'Reinforcement and structural steel', 'material'),
  ('aggregates', 'Sand and aggregates', 'material'),
  ('ready_mix', 'Ready-mix concrete', 'material'),
  ('bricks_blocks', 'Bricks and blocks', 'material'),
  ('tiles_stone', 'Tiles and stone', 'material'),
  ('electrical', 'Electrical materials', 'material'),
  ('plumbing', 'Plumbing and sanitary', 'material'),
  ('paints_chemicals', 'Paints, waterproofing and chemicals', 'material'),
  ('hardware', 'Hardware and consumables', 'material'),
  ('shuttering', 'Shuttering and scaffolding', 'material'),
  ('earthwork', 'Earthwork', 'work'),
  ('civil_work', 'Civil and RCC work', 'work'),
  ('masonry_plaster', 'Masonry and plaster', 'work'),
  ('finishing', 'Flooring and finishing', 'work'),
  ('mep_work', 'Electrical and plumbing work', 'work'),
  ('fabrication', 'Fabrication', 'work'),
  ('labour_supply', 'Labour supply', 'work'),
  ('transport', 'Transport', 'service'),
  ('equipment_hire', 'Equipment hire', 'service'),
  ('testing', 'Testing laboratory', 'service');
SELECT platform.secure_table('proc.trade_category');

CREATE TABLE platform.party_trade (
  party_id uuid NOT NULL REFERENCES platform.party (id),
  category text NOT NULL REFERENCES proc.trade_category (key),
  PRIMARY KEY (party_id, category)
);
CREATE INDEX party_trade_category ON platform.party_trade (category);
SELECT platform.secure_table('platform.party_trade');

ALTER TABLE platform.party
  ADD COLUMN vendor_status text NOT NULL DEFAULT 'unvetted'
    CHECK (vendor_status IN ('unvetted', 'approved', 'on_hold', 'blacklisted')),
  ADD COLUMN vendor_status_reason text NOT NULL DEFAULT '' CHECK (length(vendor_status_reason) <= 1000),
  ADD COLUMN vendor_status_on date,
  ADD COLUMN vendor_status_by uuid REFERENCES platform."user" (id),
  ADD CHECK (vendor_status NOT IN ('on_hold', 'blacklisted') OR length(trim(vendor_status_reason)) >= 3);

-- KYC documents: the number and expiry, and the scanned copy in the tenant's file store when there is one.
CREATE TABLE proc.vendor_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  kind text NOT NULL CHECK (kind IN ('gst_certificate', 'pan', 'udyam', 'cancelled_cheque', 'trade_licence',
    'labour_licence', 'pf_registration', 'esi_registration', 'insurance', 'iso', 'other')),
  number text NOT NULL DEFAULT '' CHECK (length(number) <= 100),
  valid_until date,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  storage_key text CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  mime text CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  file_name text CHECK (length(file_name) <= 200),
  size_bytes int CHECK (size_bytes > 0),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK ((storage_key IS NULL) = (mime IS NULL))
);
CREATE INDEX vendor_document_party ON proc.vendor_document (party_id) WHERE removed_at IS NULL;
CREATE INDEX vendor_document_expiry ON proc.vendor_document (valid_until) WHERE removed_at IS NULL;
SELECT platform.secure_table('proc.vendor_document');
REVOKE DELETE, TRUNCATE ON proc.vendor_document FROM aerolith_app;

ALTER TABLE tender.rfq ADD COLUMN category text REFERENCES proc.trade_category (key);

CREATE TABLE proc.vendor_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  approved_only boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('proc.vendor_policy');
