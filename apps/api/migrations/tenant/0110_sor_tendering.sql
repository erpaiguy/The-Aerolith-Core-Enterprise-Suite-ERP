-- Schedule-of-rates tendering (docs/wave8-plan.md step 8f.2). The company's copies of schedules of rates (CPWD
-- DSR, a state PWD's SOR), imported from its own spreadsheet (none is shipped with the app); BOQ items citing an SOR
-- item; percentage-rate tenders (a quote of so many percent above or below the estimate) with the competitors'
-- percentages; competitors' item rates for the item-wise comparative.
CREATE TABLE est.sor_book (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),   -- "CPWD DSR 2023 (Civil)"
  issuer text NOT NULL CHECK (length(trim(issuer)) BETWEEN 2 AND 120),
  state_code text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  edition text NOT NULL DEFAULT '' CHECK (length(edition) <= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (name)
);
SELECT platform.secure_table('est.sor_book');

CREATE TABLE est.sor_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES est.sor_book (id),
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  chapter text NOT NULL DEFAULT '' CHECK (length(chapter) <= 200),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 4000),
  unit text NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 20),
  rate numeric(20,4) NOT NULL CHECK (rate >= 0),
  UNIQUE (book_id, code)
);
CREATE INDEX sor_item_text ON est.sor_item USING gin (to_tsvector('simple', code || ' ' || description));
SELECT platform.secure_table('est.sor_item');

-- A BOQ item citing an SOR item, by its stable line key.
CREATE TABLE est.boq_sor (
  boq_id uuid NOT NULL REFERENCES est.boq (id),
  line_key uuid NOT NULL,
  sor_item_id uuid NOT NULL REFERENCES est.sor_item (id),
  PRIMARY KEY (boq_id, line_key)
);
CREATE INDEX boq_sor_item ON est.boq_sor (sor_item_id);
SELECT platform.secure_table('est.boq_sor');

ALTER TABLE tender.tender
  ADD COLUMN rate_mode text NOT NULL DEFAULT 'item_rate' CHECK (rate_mode IN ('item_rate', 'percentage')),
  ADD COLUMN quoted_pct numeric(6,2) CHECK (quoted_pct IS NULL OR quoted_pct BETWEEN -99.99 AND 999.99);
ALTER TABLE tender.competitor_bid
  ADD COLUMN quoted_pct numeric(6,2) CHECK (quoted_pct IS NULL OR quoted_pct BETWEEN -99.99 AND 999.99);

-- A bidder's item rates as read out or published, ours included (party_id NULL).
CREATE TABLE tender.item_bid (
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  party_id uuid REFERENCES platform.party (id),
  line_key uuid NOT NULL,
  rate numeric(20,4) NOT NULL CHECK (rate >= 0)
);
CREATE UNIQUE INDEX item_bid_one ON tender.item_bid (tender_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid), line_key);
SELECT platform.secure_table('tender.item_bid');
