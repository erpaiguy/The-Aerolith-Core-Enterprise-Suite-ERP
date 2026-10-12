-- Wave 4 step 5 (docs/wave4-plan.md): contracts and claims. Contracts with their securities (reminded before expiry),
-- dated obligations, notices, extensions of time built from daily-report hindrances, and cost claims.
CREATE TABLE ctl.contract (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  kind text NOT NULL CHECK (kind IN ('client', 'subcontract')),
  party_id uuid REFERENCES platform.party (id),
  order_id uuid REFERENCES proc.purchase_order (id),
  reference text NOT NULL CHECK (length(trim(reference)) BETWEEN 1 AND 200),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  value numeric(20,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  signed_on date,
  start_on date,
  completion_on date,
  dlp_months int NOT NULL DEFAULT 12 CHECK (dlp_months BETWEEN 0 AND 120),
  ld_pct_per_week numeric(5,2) NOT NULL DEFAULT 0 CHECK (ld_pct_per_week BETWEEN 0 AND 100),
  ld_cap_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (ld_cap_pct BETWEEN 0 AND 100),
  payment_terms text NOT NULL DEFAULT '' CHECK (length(payment_terms) <= 2000),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (kind = 'client' OR order_id IS NOT NULL OR party_id IS NOT NULL)
);
CREATE INDEX contract_project ON ctl.contract (project_id);
SELECT platform.secure_table('ctl.contract');
REVOKE DELETE, TRUNCATE ON ctl.contract FROM aerolith_app;

CREATE TABLE ctl.security (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ctl.contract (id),
  kind text NOT NULL CHECK (kind IN ('performance', 'advance', 'retention_bond', 'insurance', 'other')),
  issuer text NOT NULL DEFAULT '' CHECK (length(issuer) <= 200),
  number text NOT NULL DEFAULT '' CHECK (length(number) <= 100),
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  valid_until date NOT NULL,
  claim_until date,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'returned', 'invoked')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX security_contract ON ctl.security (contract_id);
SELECT platform.secure_table('ctl.security');

CREATE TABLE ctl.obligation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ctl.contract (id),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 500),
  clause text NOT NULL DEFAULT '' CHECK (length(clause) <= 100),
  due_on date NOT NULL,
  done_on date
);
CREATE INDEX obligation_contract ON ctl.obligation (contract_id, due_on);
SELECT platform.secure_table('ctl.obligation');

CREATE TABLE ctl.notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ctl.contract (id),
  direction text NOT NULL CHECK (direction IN ('sent', 'received')),
  subject text NOT NULL CHECK (length(trim(subject)) BETWEEN 3 AND 500),
  clause text NOT NULL DEFAULT '' CHECK (length(clause) <= 100),
  dated date NOT NULL,
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 200),
  reply_by date,
  replied_on date
);
CREATE INDEX notice_contract ON ctl.notice (contract_id, dated);
SELECT platform.secure_table('ctl.notice');

CREATE TABLE ctl.eot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ctl.contract (id),
  number text NOT NULL,
  from_on date NOT NULL,
  to_on date NOT NULL CHECK (to_on >= from_on),
  basis jsonb NOT NULL DEFAULT '{}',               -- the hindrance days by cause, as counted
  days_claimed int NOT NULL CHECK (days_claimed >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'granted', 'rejected')),
  days_granted int CHECK (days_granted IS NULL OR days_granted >= 0),
  decided_on date,
  reference text,
  UNIQUE (contract_id, number)
);
SELECT platform.secure_table('ctl.eot');

CREATE TABLE ctl.claim (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ctl.contract (id),
  number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('idle_resources', 'prolongation', 'escalation', 'other')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  evidence text NOT NULL DEFAULT '' CHECK (length(evidence) <= 8000),
  eot_id uuid REFERENCES ctl.eot (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'negotiation', 'settled', 'rejected')),
  settled_amount numeric(20,2) CHECK (settled_amount IS NULL OR settled_amount >= 0),
  settled_on date,
  UNIQUE (contract_id, number)
);
SELECT platform.secure_table('ctl.claim');
