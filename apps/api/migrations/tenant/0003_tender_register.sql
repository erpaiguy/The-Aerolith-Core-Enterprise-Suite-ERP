-- Wave 1 step 1: tender register (docs/wave1-plan.md), plus the masters it needs: parties (P10) and numbering
-- series (P7). Conventions: docs/05-database.md §1.

-- Clients, vendors and subcontractors in one master; a party can be several at once.
CREATE TABLE platform.party (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  is_client boolean NOT NULL DEFAULT false,
  is_vendor boolean NOT NULL DEFAULT false,
  is_subcontractor boolean NOT NULL DEFAULT false,
  gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  pan text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  contact_name text,
  email text,
  phone text,
  address text,
  notes text NOT NULL DEFAULT '',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX party_name ON platform.party (lower(name)) WHERE deleted_at IS NULL;
SELECT platform.secure_table('platform.party');

-- Gap-controlled document numbers: the counter row is locked and advanced inside the same transaction as the document,
-- so a failed save rolls the number back too.
CREATE TABLE platform.numbering_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type text NOT NULL,
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  fy text NOT NULL CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  prefix text NOT NULL,
  padding int NOT NULL DEFAULT 4 CHECK (padding BETWEEN 1 AND 10),
  next_no int NOT NULL DEFAULT 1 CHECK (next_no > 0),
  UNIQUE (doc_type, entity_id, fy)
);
SELECT platform.secure_table('platform.numbering_series');

CREATE SCHEMA tender;
GRANT USAGE ON SCHEMA tender TO aerolith_app;

CREATE TABLE tender.tender (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  number text NOT NULL UNIQUE,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  client_id uuid REFERENCES platform.party (id),
  client_ref text,                      -- the client's own tender / NIT number
  source text NOT NULL DEFAULT 'other' CHECK (source IN
    ('public_portal', 'gem', 'private_invitation', 'repeat_client', 'referral', 'other')),
  portal_url text,
  vertical text NOT NULL DEFAULT 'buildings' CHECK (vertical IN ('buildings', 'interiors', 'joinery', 'mep', 'other')),
  location text,
  estimated_value numeric(20,2) CHECK (estimated_value IS NULL OR estimated_value >= 0),
  emd_amount numeric(20,2) CHECK (emd_amount IS NULL OR emd_amount >= 0),
  tender_fee numeric(20,2) CHECK (tender_fee IS NULL OR tender_fee >= 0),
  published_on date,
  prebid_at timestamptz,
  submission_due_at timestamptz,
  opening_at timestamptz,
  bid_validity_days int CHECK (bid_validity_days IS NULL OR bid_validity_days BETWEEN 1 AND 730),
  status text NOT NULL DEFAULT 'lead' CHECK (status IN
    ('lead', 'evaluating', 'bidding', 'submitted', 'won', 'lost', 'no_bid', 'withdrawn', 'cancelled')),
  status_reason text,
  owner_id uuid REFERENCES platform."user" (id),   -- the estimator responsible
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX tender_status_due ON tender.tender (status, submission_due_at);
CREATE INDEX tender_client ON tender.tender (client_id);
CREATE INDEX tender_owner ON tender.tender (owner_id);
CREATE INDEX tender_entity ON tender.tender (entity_id);
SELECT platform.secure_table('tender.tender');

-- Every bid/no-bid decision with the criteria as they were scored. Append-only: a new decision supersedes the old.
CREATE TABLE tender.bid_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  criteria jsonb NOT NULL,
  score numeric(5,1) NOT NULL CHECK (score BETWEEN 0 AND 100),
  decision text NOT NULL CHECK (decision IN ('bid', 'no_bid')),
  reason text NOT NULL DEFAULT '',
  decided_by uuid NOT NULL REFERENCES platform."user" (id),
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bid_decision_tender ON tender.bid_decision (tender_id, decided_at DESC);
SELECT platform.secure_table('tender.bid_decision');

-- What happened to a tender, for its activity timeline. Append-only.
CREATE TABLE tender.tender_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  actor_id uuid REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tender_event_tender ON tender.tender_event (tender_id, id);
SELECT platform.secure_table('tender.tender_event');

-- Default privileges (provisioning/bootstrap.ts) grant the app role full DML. Take back what these tables must never
-- allow: masters are soft-deleted, tenders are never deleted, decisions and events are append-only.
REVOKE DELETE, TRUNCATE ON platform.party, platform.numbering_series, tender.tender FROM aerolith_app;
REVOKE UPDATE, DELETE, TRUNCATE ON tender.bid_decision, tender.tender_event FROM aerolith_app;

-- Automatic deadline reminders point back at their tender so they can be rescheduled when dates change.
ALTER TABLE platform.notification ADD COLUMN source text;
CREATE INDEX notification_source ON platform.notification (source) WHERE source IS NOT NULL;
