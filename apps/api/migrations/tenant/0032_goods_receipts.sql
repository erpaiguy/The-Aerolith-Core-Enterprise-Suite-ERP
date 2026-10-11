-- Wave 2b step 5 (docs/wave2b-plan.md): goods received against purchase orders at a project's sites, inspected when
-- held for quality, and rejections returned to the supplier. What is accepted becomes stock in step 6.

-- An order line keeps one key through the order's revisions, so a receipt points at "the cement line" whatever the
-- amendments did to positions. Lines already written share a key with the same position in the order's other
-- revisions (amendments so far copied lines position for position).
ALTER TABLE proc.po_line ADD COLUMN line_key uuid;
UPDATE proc.po_line l SET line_key = k.key
FROM (
  SELECT v.po_id, x.position, gen_random_uuid() AS key
  FROM proc.po_line x JOIN proc.po_revision v ON v.id = x.revision_id
  GROUP BY v.po_id, x.position
) k, proc.po_revision v
WHERE v.id = l.revision_id AND k.po_id = v.po_id AND k.position = l.position;
ALTER TABLE proc.po_line ALTER COLUMN line_key SET NOT NULL;
CREATE UNIQUE INDEX po_line_key ON proc.po_line (revision_id, line_key);

-- Closed because everything was received (reopened if a receipt is cancelled), not closed by hand.
ALTER TABLE proc.purchase_order ADD COLUMN closed_on_receipt boolean NOT NULL DEFAULT false;

CREATE TABLE proc.goods_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  po_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  number text NOT NULL UNIQUE,                         -- GRN/2026-27/0001
  site_id uuid REFERENCES proj.site (id),
  received_on date NOT NULL,
  challan_no text NOT NULL CHECK (length(trim(challan_no)) BETWEEN 1 AND 100),   -- the supplier's delivery challan
  challan_date date,
  invoice_no text CHECK (invoice_no IS NULL OR length(invoice_no) <= 100),
  vehicle_no text CHECK (vehicle_no IS NULL OR length(vehicle_no) <= 30),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX goods_receipt_order ON proc.goods_receipt (po_id);
CREATE INDEX goods_receipt_project ON proc.goods_receipt (project_id, received_on DESC);
SELECT platform.secure_table('proc.goods_receipt');
REVOKE DELETE, TRUNCATE ON proc.goods_receipt FROM aerolith_app;

-- What came for each order line. Accepted at the gate (less anything rejected there), or held for inspection until
-- someone accepts and rejects it.
CREATE TABLE proc.grn_line (
  receipt_id uuid NOT NULL REFERENCES proc.goods_receipt (id),
  position int NOT NULL CHECK (position > 0),
  line_key uuid NOT NULL,                              -- the order line (proc.po_line.line_key)
  resource_id uuid REFERENCES est.resource (id),
  description text NOT NULL,                           -- as on the order when received
  unit text NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  inspection text NOT NULL CHECK (inspection IN ('gate', 'hold', 'inspected')),
  accepted_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0),
  rejected_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  rejection_reason text CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 1000),
  inspected_at timestamptz,
  inspected_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (receipt_id, position),
  CHECK (inspection = 'hold' OR accepted_qty + rejected_qty = qty),
  CHECK (inspection <> 'hold' OR (accepted_qty = 0 AND rejected_qty = 0)),
  CHECK (rejected_qty = 0 OR rejection_reason IS NOT NULL)
);
CREATE INDEX grn_line_key ON proc.grn_line (line_key);
SELECT platform.secure_table('proc.grn_line');
REVOKE DELETE, TRUNCATE ON proc.grn_line FROM aerolith_app;

-- Rejected goods sent back to the supplier (a return to vendor, with their debit note or our gate pass).
CREATE TABLE proc.goods_return (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES proc.goods_receipt (id),
  number text NOT NULL UNIQUE,                         -- RTV/2026-27/0001
  returned_on date NOT NULL,
  reference text CHECK (reference IS NULL OR length(reference) <= 200),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX goods_return_receipt ON proc.goods_return (receipt_id);
SELECT platform.secure_table('proc.goods_return');
REVOKE DELETE, TRUNCATE ON proc.goods_return FROM aerolith_app;

CREATE TABLE proc.goods_return_line (
  return_id uuid NOT NULL REFERENCES proc.goods_return (id),
  position int NOT NULL,                               -- the receipt line
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (return_id, position)
);
SELECT platform.secure_table('proc.goods_return_line');
REVOKE DELETE, TRUNCATE ON proc.goods_return_line FROM aerolith_app;
