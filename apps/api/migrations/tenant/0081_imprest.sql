-- Site imprest (docs/wave7-plan.md step 7d.6): a petty-cash float held by someone on a project's team. Advances to them
-- are paid from a bank or cash ledger into staff advances; they enter what they spend against it (the expense ledger,
-- the bill); accounts settles the spends in one journal (each expense to the project, staff advances credited) and
-- takes back what is left. Every advance, return and settlement is a voucher; the float's balance is the books'.
CREATE TABLE acc.imprest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,                                       -- from the company's numbering series
  custodian_id uuid NOT NULL REFERENCES platform."user" (id),
  purpose text NOT NULL DEFAULT '' CHECK (length(purpose) <= 500),
  float_limit numeric(14, 2) NOT NULL DEFAULT 0 CHECK (float_limit >= 0),   -- 0: no limit
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (entity_id, number)
);
CREATE INDEX imprest_project ON acc.imprest (project_id);
SELECT platform.secure_table('acc.imprest');
REVOKE DELETE, TRUNCATE ON acc.imprest FROM aerolith_app;

CREATE TABLE acc.imprest_settlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imprest_id uuid NOT NULL REFERENCES acc.imprest (id),
  settled_on date NOT NULL,
  total numeric(14, 2) NOT NULL CHECK (total > 0),
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('acc.imprest_settlement');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.imprest_settlement FROM aerolith_app;

CREATE TABLE acc.imprest_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imprest_id uuid NOT NULL REFERENCES acc.imprest (id),
  kind text NOT NULL CHECK (kind IN ('advance', 'expense', 'return')),
  entry_date date NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  account_id uuid NOT NULL REFERENCES acc.account (id),      -- bank/cash for advances and returns; the expense ledger
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),
  voucher_id uuid REFERENCES acc.voucher (id),                -- advances and returns at once; expenses when settled
  settlement_id uuid REFERENCES acc.imprest_settlement (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK (kind = 'expense' OR voucher_id IS NOT NULL),
  CHECK (kind = 'expense' OR settlement_id IS NULL)
);
CREATE INDEX imprest_entry_imprest ON acc.imprest_entry (imprest_id, entry_date);
SELECT platform.secure_table('acc.imprest_entry');
REVOKE DELETE, TRUNCATE ON acc.imprest_entry FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.imprest
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.imprest_entry
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
