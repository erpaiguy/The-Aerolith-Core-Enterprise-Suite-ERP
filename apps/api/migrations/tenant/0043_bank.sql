-- Wave 3 step 7 (docs/wave3-plan.md): bank statements imported per bank ledger, their lines matched against the
-- ledger's voucher lines, and the reconciliation as at a date.

-- How a bank's CSV or Excel statement is laid out, per bank ledger.
CREATE TABLE acc.bank_mapping (
  account_id uuid PRIMARY KEY REFERENCES acc.account (id),
  mapping jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('acc.bank_mapping');
REVOKE DELETE, TRUNCATE ON acc.bank_mapping FROM aerolith_app;

CREATE TABLE acc.bank_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  file_name text NOT NULL DEFAULT '' CHECK (length(file_name) <= 200),
  format text NOT NULL CHECK (format IN ('table', 'ofx', 'mt940')),
  lines int NOT NULL,
  skipped int NOT NULL DEFAULT 0,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('acc.bank_statement');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.bank_statement FROM aerolith_app;

-- A statement line: deposits positive, withdrawals negative. Never changed.
CREATE TABLE acc.bank_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES acc.bank_statement (id),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  position int NOT NULL,
  txn_date date NOT NULL,
  narration text NOT NULL DEFAULT '' CHECK (length(narration) <= 1000),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 200),
  amount numeric(20,2) NOT NULL CHECK (amount <> 0),
  balance numeric(20,2),
  fingerprint text NOT NULL,
  UNIQUE (account_id, fingerprint)
);
CREATE INDEX bank_line_account ON acc.bank_line (account_id, txn_date);
SELECT platform.secure_table('acc.bank_line');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.bank_line FROM aerolith_app;

-- A statement line matched to one or more voucher lines on the bank ledger; undone with a reason, never deleted.
CREATE TABLE acc.bank_match (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  bank_line_id uuid NOT NULL REFERENCES acc.bank_line (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  undone_at timestamptz,
  undone_by uuid REFERENCES platform."user" (id),
  undo_reason text,
  CHECK ((undone_at IS NULL) = (undo_reason IS NULL))
);
CREATE UNIQUE INDEX bank_match_live ON acc.bank_match (bank_line_id) WHERE undone_at IS NULL;
SELECT platform.secure_table('acc.bank_match');
REVOKE DELETE, TRUNCATE ON acc.bank_match FROM aerolith_app;

CREATE TABLE acc.bank_match_line (
  match_id uuid NOT NULL REFERENCES acc.bank_match (id),
  voucher_id uuid NOT NULL,
  position int NOT NULL,
  PRIMARY KEY (match_id, voucher_id, position),
  FOREIGN KEY (voucher_id, position) REFERENCES acc.voucher_line (voucher_id, position)
);
SELECT platform.secure_table('acc.bank_match_line');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.bank_match_line FROM aerolith_app;
