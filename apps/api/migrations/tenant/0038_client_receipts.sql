-- Wave 3 step 3 (docs/wave3-plan.md): receivables. Money from a client, with the TDS and other deductions the client
-- made, allocated to what it settles: certified bills, retention released, mobilisation advances. Each receipt posts a
-- receipt voucher; a mistake is cancelled (its voucher reversed), never edited.

CREATE TABLE acc.client_receipt (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  received_on date NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES acc.account (id),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),            -- into the bank
  tds numeric(20,2) NOT NULL DEFAULT 0 CHECK (tds >= 0),        -- deducted by the client
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),
  narration text NOT NULL DEFAULT '' CHECK (length(narration) <= 2000),
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  status_reason text,
  cancel_voucher_id uuid REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK ((status = 'cancelled') = (cancel_voucher_id IS NOT NULL))
);
CREATE INDEX client_receipt_party ON acc.client_receipt (entity_id, party_id, received_on);
SELECT platform.secure_table('acc.client_receipt');
REVOKE DELETE, TRUNCATE ON acc.client_receipt FROM aerolith_app;

-- What a receipt settles: a certified bill's net payable, a project's retention released, or its mobilisation advance.
CREATE TABLE acc.client_receipt_alloc (
  receipt_id uuid NOT NULL REFERENCES acc.client_receipt (id),
  position int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bill', 'retention', 'advance')),
  bill_id uuid REFERENCES acc.client_bill (id),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (receipt_id, position),
  CHECK ((kind = 'bill') = (bill_id IS NOT NULL))
);
CREATE INDEX client_receipt_alloc_bill ON acc.client_receipt_alloc (bill_id) WHERE bill_id IS NOT NULL;
CREATE INDEX client_receipt_alloc_project ON acc.client_receipt_alloc (project_id, kind);
SELECT platform.secure_table('acc.client_receipt_alloc');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.client_receipt_alloc FROM aerolith_app;

-- Other deductions the client made from the payment (each to its ledger).
CREATE TABLE acc.client_receipt_deduction (
  receipt_id uuid NOT NULL REFERENCES acc.client_receipt (id),
  position int NOT NULL,
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 200),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  account_id uuid NOT NULL REFERENCES acc.account (id),
  PRIMARY KEY (receipt_id, position)
);
SELECT platform.secure_table('acc.client_receipt_deduction');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.client_receipt_deduction FROM aerolith_app;
