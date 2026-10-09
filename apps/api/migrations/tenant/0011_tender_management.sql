-- Wave 1 step 8: tender management detail (docs/04-features.md E7, docs/wave1-plan.md step 8): pre-bid queries,
-- addenda, EMD and bank guarantees, the submission checklist, submissions, competitor bids and the result.
-- Tables listed in docs/05-database.md §5.

-- The last date for pre-bid queries, and the result once known.
ALTER TABLE tender.tender
  ADD COLUMN queries_due_at timestamptz,
  ADD COLUMN result_on date,
  ADD COLUMN result_category text CHECK (result_category IS NULL OR result_category IN
    ('price', 'technical', 'qualification', 'documents', 'scope', 'client', 'other')),
  ADD COLUMN awarded_value numeric(20,2) CHECK (awarded_value IS NULL OR awarded_value >= 0),
  ADD COLUMN awarded_to uuid REFERENCES platform.party (id);   -- who won, when it was not us

-- Competitors recur across tenders; win/loss analysis needs them as parties.
ALTER TABLE platform.party ADD COLUMN is_competitor boolean NOT NULL DEFAULT false;

-- Addenda / corrigenda issued by the client. One that moves the submission date records both dates.
CREATE TABLE tender.addendum (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  ref text NOT NULL CHECK (length(trim(ref)) BETWEEN 1 AND 100),   -- the client's number, e.g. "Corrigendum 2"
  issued_on date NOT NULL,
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 3 AND 8000),
  due_before timestamptz,
  due_after timestamptz,
  affects_boq boolean NOT NULL DEFAULT false,
  acknowledged boolean NOT NULL DEFAULT false,                     -- signed and included in the bid
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX addendum_ref ON tender.addendum (tender_id, lower(ref));
SELECT platform.secure_table('tender.addendum');

-- Pre-bid queries raised with the client and the client's replies, numbered per tender.
CREATE TABLE tender.query (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  seq int NOT NULL CHECK (seq > 0),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 200),   -- clause, page or BOQ item
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 3 AND 4000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'answered', 'withdrawn')),
  sent_on date,
  answer text NOT NULL DEFAULT '' CHECK (length(answer) <= 8000),
  answered_on date,
  addendum_id uuid REFERENCES tender.addendum (id),                     -- the reply came as this addendum
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (tender_id, seq),
  CHECK (status <> 'answered' OR length(trim(answer)) > 0)
);
SELECT platform.secure_table('tender.query');

-- EMD / bid security and bank guarantees (later also performance guarantees for won tenders).
CREATE TABLE tender.security_instrument (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  purpose text NOT NULL DEFAULT 'emd' CHECK (purpose IN ('emd', 'performance', 'other')),
  form text NOT NULL CHECK (form IN
    ('bank_guarantee', 'demand_draft', 'fdr', 'online', 'insurance_bond', 'exempt')),
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  bank text CHECK (length(bank) <= 200),
  instrument_no text CHECK (length(instrument_no) <= 100),
  issued_on date,
  valid_until date,                    -- expiry
  claim_until date,                    -- end of the claim period (bank guarantees)
  status text NOT NULL DEFAULT 'planned' CHECK (status IN
    ('planned', 'issued', 'submitted', 'returned', 'adjusted', 'forfeited', 'cancelled')),
  returned_on date,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (valid_until IS NULL OR issued_on IS NULL OR valid_until >= issued_on),
  CHECK (claim_until IS NULL OR valid_until IS NULL OR claim_until >= valid_until)
);
CREATE INDEX security_instrument_tender ON tender.security_instrument (tender_id);
CREATE INDEX security_instrument_expiry ON tender.security_instrument (valid_until)
  WHERE status IN ('issued', 'submitted');
SELECT platform.secure_table('tender.security_instrument');

-- What must go into the bid, and whether it is ready. A working list: items can be removed.
CREATE TABLE tender.checklist_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  seq int NOT NULL CHECK (seq > 0),
  envelope text NOT NULL DEFAULT 'technical' CHECK (envelope IN ('technical', 'financial', 'other')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 300),
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'not_applicable')),
  assignee_id uuid REFERENCES platform."user" (id),
  due_on date,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  done_at timestamptz,
  done_by uuid REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (tender_id, seq)
);
CREATE INDEX checklist_item_assignee ON tender.checklist_item (assignee_id) WHERE status = 'pending';
SELECT platform.secure_table('tender.checklist_item');

-- Each time a bid was handed in: the original, and any revised offer after negotiation. Append-only.
CREATE TABLE tender.submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  kind text NOT NULL DEFAULT 'original' CHECK (kind IN ('original', 'revised')),
  submitted_at timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('portal', 'physical', 'email', 'other')),
  reference text CHECK (length(reference) <= 200),       -- portal acknowledgement or receipt number
  bid_value numeric(20,2) CHECK (bid_value IS NULL OR bid_value >= 0),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX submission_tender ON tender.submission (tender_id, submitted_at);
SELECT platform.secure_table('tender.submission');

-- Bids read out at the opening, ours included (party_id NULL). Ranks are worked out from the values, never typed.
CREATE TABLE tender.competitor_bid (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  party_id uuid REFERENCES platform.party (id),
  quoted_value numeric(20,2) CHECK (quoted_value IS NULL OR quoted_value >= 0),
  qualified boolean NOT NULL DEFAULT true,            -- passed the technical / pre-qualification stage
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE UNIQUE INDEX competitor_bid_party ON tender.competitor_bid (tender_id, party_id) WHERE party_id IS NOT NULL;
CREATE UNIQUE INDEX competitor_bid_us ON tender.competitor_bid (tender_id) WHERE party_id IS NULL;
CREATE INDEX competitor_bid_by_party ON tender.competitor_bid (party_id);
SELECT platform.secure_table('tender.competitor_bid');

-- Records, not working lists: addenda, securities and submissions are never deleted by the app; queries are
-- withdrawn rather than deleted once sent (drafts may go).
REVOKE DELETE, TRUNCATE ON tender.addendum, tender.security_instrument FROM aerolith_app;
REVOKE UPDATE, DELETE, TRUNCATE ON tender.submission FROM aerolith_app;
