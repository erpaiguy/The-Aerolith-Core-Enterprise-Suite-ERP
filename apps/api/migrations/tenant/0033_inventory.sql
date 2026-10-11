-- Wave 2b step 6 (docs/wave2b-plan.md): stores at a project's sites and one stock ledger. Accepted receipt lines come
-- in; issues to work (a WBS element), returns from site, transfers between stores and stock-take adjustments move
-- stock. Valued by weighted average per store and resource, or FIFO when the tenant chose it before the first move.
-- Only rate-library resources are stocked. Stock never goes negative.

CREATE TABLE proc.store (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  site_id uuid NOT NULL REFERENCES proj.site (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX store_name ON proc.store (project_id, lower(name));
CREATE INDEX store_site ON proc.store (site_id);
SELECT platform.secure_table('proc.store');
REVOKE DELETE, TRUNCATE ON proc.store FROM aerolith_app;

-- The ledger: every movement, signed (+ in, − out), with its value. Never changed: a mistake is reversed by another
-- move.
CREATE TABLE proc.stock_move (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES proc.store (id),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  moved_on date NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty <> 0),
  value numeric(20,2) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt', 'receipt_cancelled', 'issue', 'issue_return', 'transfer_out',
    'transfer_in', 'transfer_back', 'adjustment')),
  doc_type text NOT NULL,                              -- goods_receipt, stock_issue, stock_transfer, stock_count
  doc_id uuid NOT NULL,
  doc_number text NOT NULL,
  wbs_id uuid REFERENCES proj.wbs (id),                -- for issues and their returns
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX stock_move_store_resource ON proc.stock_move (store_id, resource_id, moved_on, id);
CREATE INDEX stock_move_doc ON proc.stock_move (doc_type, doc_id);
SELECT platform.secure_table('proc.stock_move');
REVOKE UPDATE, DELETE, TRUNCATE ON proc.stock_move FROM aerolith_app;

-- What is in each store now: the ledger summed, kept in the same transaction as each move.
CREATE TABLE proc.stock_balance (
  store_id uuid NOT NULL REFERENCES proc.store (id),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  qty numeric(20,4) NOT NULL CHECK (qty >= 0),
  value numeric(20,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (store_id, resource_id)
);
SELECT platform.secure_table('proc.stock_balance');

-- FIFO only: what is left of each lot that came in, oldest first.
CREATE TABLE proc.stock_layer (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES proc.store (id),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  move_id bigint NOT NULL REFERENCES proc.stock_move (id),
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  qty_left numeric(20,4) NOT NULL CHECK (qty_left >= 0),
  value_left numeric(20,2) NOT NULL CHECK (value_left >= 0)
);
CREATE INDEX stock_layer_open ON proc.stock_layer (store_id, resource_id, id) WHERE qty_left > 0;
SELECT platform.secure_table('proc.stock_layer');

CREATE TABLE proc.reorder_level (
  store_id uuid NOT NULL REFERENCES proc.store (id),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  level numeric(20,4) NOT NULL CHECK (level > 0),
  PRIMARY KEY (store_id, resource_id)
);
SELECT platform.secure_table('proc.reorder_level');

-- A receipt goes into one store of its site.
ALTER TABLE proc.goods_receipt ADD COLUMN store_id uuid REFERENCES proc.store (id);

-- Issue slips: materials out of a store to work, a WBS element (and a contract BOQ item if said).
CREATE TABLE proc.stock_issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  store_id uuid NOT NULL REFERENCES proc.store (id),
  number text NOT NULL UNIQUE,                         -- ISS/2026-27/0001
  issued_on date NOT NULL,
  wbs_id uuid NOT NULL REFERENCES proj.wbs (id),
  issued_to text NOT NULL CHECK (length(trim(issued_to)) BETWEEN 1 AND 200),   -- who took it
  purpose text NOT NULL DEFAULT '' CHECK (length(purpose) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX stock_issue_store ON proc.stock_issue (store_id, issued_on DESC);
SELECT platform.secure_table('proc.stock_issue');
REVOKE DELETE, TRUNCATE ON proc.stock_issue FROM aerolith_app;

CREATE TABLE proc.stock_issue_line (
  issue_id uuid NOT NULL REFERENCES proc.stock_issue (id),
  position int NOT NULL CHECK (position > 0),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  line_key uuid,                                       -- the contract BOQ item, if said
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  value numeric(20,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (issue_id, position)
);
SELECT platform.secure_table('proc.stock_issue_line');

-- Unused material back from site, against the issue, at what it was issued for.
CREATE TABLE proc.stock_issue_return (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES proc.stock_issue (id),
  returned_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('proc.stock_issue_return');

CREATE TABLE proc.stock_issue_return_line (
  return_id uuid NOT NULL REFERENCES proc.stock_issue_return (id),
  position int NOT NULL,                               -- the issue line
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  value numeric(20,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (return_id, position)
);
SELECT platform.secure_table('proc.stock_issue_return_line');

-- Transfers: out of one store, in transit, into another (same project or another one).
CREATE TABLE proc.stock_transfer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,                         -- TRN/2026-27/0001
  from_store_id uuid NOT NULL REFERENCES proc.store (id),
  to_store_id uuid NOT NULL REFERENCES proc.store (id),
  sent_on date NOT NULL,
  received_on date,
  status text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'received', 'cancelled')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  received_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (from_store_id <> to_store_id)
);
SELECT platform.secure_table('proc.stock_transfer');
REVOKE DELETE, TRUNCATE ON proc.stock_transfer FROM aerolith_app;

CREATE TABLE proc.stock_transfer_line (
  transfer_id uuid NOT NULL REFERENCES proc.stock_transfer (id),
  position int NOT NULL CHECK (position > 0),
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  value numeric(20,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (transfer_id, position)
);
SELECT platform.secure_table('proc.stock_transfer_line');

-- Stock take: counted against the book; differences posted as adjustments once approved.
CREATE TABLE proc.stock_count (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES proc.store (id),
  number text NOT NULL UNIQUE,                         -- STK/2026-27/0001
  counted_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'posted', 'rejected', 'discarded')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 2000),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  posted_at timestamptz,
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX stock_count_open ON proc.stock_count (store_id) WHERE status IN ('draft', 'submitted', 'rejected');
SELECT platform.secure_table('proc.stock_count');
REVOKE DELETE, TRUNCATE ON proc.stock_count FROM aerolith_app;

CREATE TABLE proc.stock_count_line (
  count_id uuid NOT NULL REFERENCES proc.stock_count (id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  book_qty numeric(20,4) NOT NULL,                     -- what the ledger said when the line was counted
  counted_qty numeric(20,4) NOT NULL CHECK (counted_qty >= 0),
  unit_cost numeric(20,6) NOT NULL CHECK (unit_cost >= 0),   -- to value the difference
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  PRIMARY KEY (count_id, resource_id)
);
SELECT platform.secure_table('proc.stock_count_line');
