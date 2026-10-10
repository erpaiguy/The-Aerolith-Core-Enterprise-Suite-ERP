-- Wave 2b step 1 (docs/wave2b-plan.md): the basic approval engine (docs/04-features.md P5) and purchase requisitions
-- (R1), its first user.

-- Approval rules: per document type, levels in order, each applying from an amount upwards. A type with no rules
-- needs no approval. Approver: the project's lead, any manager (or admin), any admin, or a named person.
CREATE TABLE platform.approval_rule (
  doc_type text NOT NULL CHECK (doc_type ~ '^[a-z_]{3,40}$'),
  level int NOT NULL CHECK (level BETWEEN 1 AND 6),
  min_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  approver text NOT NULL CHECK (approver IN ('project_lead', 'manager', 'admin', 'user')),
  user_id uuid REFERENCES platform."user" (id),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (doc_type, level),
  CHECK ((approver = 'user') = (user_id IS NOT NULL))
);
SELECT platform.secure_table('platform.approval_rule');

-- A document submitted for approval. It keeps the levels it was submitted under (approval_step), whatever the rules
-- become. One pending request per document at a time.
CREATE TABLE platform.approval_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type text NOT NULL,
  doc_id uuid NOT NULL,
  project_id uuid REFERENCES proj.project (id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  amount numeric(20,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  level int,                                           -- the level waiting, while pending
  submitted_by uuid NOT NULL REFERENCES platform."user" (id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  CHECK ((status = 'pending') = (level IS NOT NULL))
);
CREATE UNIQUE INDEX approval_request_one_pending ON platform.approval_request (doc_type, doc_id)
  WHERE status = 'pending';
CREATE INDEX approval_request_doc ON platform.approval_request (doc_type, doc_id, submitted_at DESC);
CREATE INDEX approval_request_pending ON platform.approval_request (level) WHERE status = 'pending';
CREATE INDEX approval_request_submitter ON platform.approval_request (submitted_by, submitted_at DESC);
SELECT platform.secure_table('platform.approval_request');

-- The levels of one request. `to_admins`: no one but the submitter could approve the level when it came up, so the
-- admins approve it instead.
CREATE TABLE platform.approval_step (
  request_id uuid NOT NULL REFERENCES platform.approval_request (id),
  level int NOT NULL,
  approver text NOT NULL CHECK (approver IN ('project_lead', 'manager', 'admin', 'user')),
  user_id uuid REFERENCES platform."user" (id),
  label text NOT NULL DEFAULT '',
  min_amount numeric(20,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'pending', 'approved', 'rejected')),
  to_admins boolean NOT NULL DEFAULT false,
  acted_by uuid REFERENCES platform."user" (id),
  on_behalf_of uuid REFERENCES platform."user" (id),  -- when a delegate acted for the approver
  acted_at timestamptz,
  comment text CHECK (comment IS NULL OR length(comment) <= 2000),
  PRIMARY KEY (request_id, level)
);
SELECT platform.secure_table('platform.approval_step');

-- What happened to a request, in order: never changed.
CREATE TABLE platform.approval_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES platform.approval_request (id),
  kind text NOT NULL CHECK (kind IN
    ('submitted', 'approved', 'rejected', 'withdrawn', 'commented', 'to_admins', 'no_approval_needed')),
  level int,
  actor_id uuid REFERENCES platform."user" (id),
  on_behalf_of uuid REFERENCES platform."user" (id),
  comment text CHECK (comment IS NULL OR length(comment) <= 2000),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_event_request ON platform.approval_event (request_id, id);
SELECT platform.secure_table('platform.approval_event');
REVOKE UPDATE, DELETE, TRUNCATE ON platform.approval_event FROM aerolith_app;

-- While someone is away, another person approves for them (dates inclusive, India's dates).
CREATE TABLE platform.approval_delegation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user uuid NOT NULL REFERENCES platform."user" (id),
  to_user uuid NOT NULL REFERENCES platform."user" (id),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  cancelled_at timestamptz,
  CHECK (from_user <> to_user),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX approval_delegation_to ON platform.approval_delegation (to_user) WHERE cancelled_at IS NULL;
CREATE INDEX approval_delegation_from ON platform.approval_delegation (from_user) WHERE cancelled_at IS NULL;
SELECT platform.secure_table('platform.approval_delegation');

-- Purchase requisitions: what a project asks to be bought, approved before it is ordered.
CREATE SCHEMA proc;
GRANT USAGE ON SCHEMA proc TO aerolith_app;

CREATE TABLE proc.requisition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL UNIQUE,
  site_id uuid REFERENCES proj.site (id),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  needed_by date,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 2000),
  amount numeric(20,2) NOT NULL DEFAULT 0,             -- estimated: quantities at the rate library's rates
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX requisition_project ON proc.requisition (project_id, created_at DESC);
CREATE INDEX requisition_status ON proc.requisition (status);
SELECT platform.secure_table('proc.requisition');

CREATE TABLE proc.requisition_line (
  requisition_id uuid NOT NULL REFERENCES proc.requisition (id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position > 0),
  resource_id uuid REFERENCES est.resource (id),       -- from the rate library, or typed in
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  unit text NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 20),
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  rate numeric(20,4) CHECK (rate IS NULL OR rate >= 0),
  amount numeric(20,2),
  line_key uuid,                                        -- the contract BOQ item it is for, if any
  wbs_id uuid REFERENCES proj.wbs (id),
  needed_by date,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  PRIMARY KEY (requisition_id, position)
);
CREATE INDEX requisition_line_resource ON proc.requisition_line (resource_id);
SELECT platform.secure_table('proc.requisition_line');
