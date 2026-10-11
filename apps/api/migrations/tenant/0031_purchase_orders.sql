-- Wave 2b step 4 (docs/wave2b-plan.md): purchase orders (materials) and work orders (work), from the vendors chosen
-- in a project's enquiries or written directly. Rates are before GST; GST is added on top (owner decision, 11 Oct
-- 2026): CGST and SGST when the supplier's state (from its GSTIN) is the site's, IGST across states.
--
-- An order is a series of revisions: revision 0 is the order as first issued, each amendment a later one. A revision
-- is approved under the approval rules before it is in force; the one in force is what the supplier works to.

CREATE TABLE proc.purchase_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  kind text NOT NULL CHECK (kind IN ('purchase', 'work')),
  number text NOT NULL UNIQUE,                         -- PO/2026-27/0001, WO/2026-27/0001
  party_id uuid NOT NULL REFERENCES platform.party (id),
  rfq_id uuid REFERENCES tender.rfq (id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'acknowledged', 'closed', 'cancelled')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 2000),
  acknowledged_on date,
  acknowledged_ref text CHECK (acknowledged_ref IS NULL OR length(acknowledged_ref) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX purchase_order_project ON proc.purchase_order (project_id, created_at DESC);
CREATE INDEX purchase_order_party ON proc.purchase_order (party_id);
SELECT platform.secure_table('proc.purchase_order');
REVOKE DELETE, TRUNCATE ON proc.purchase_order FROM aerolith_app;

-- Each revision: its terms, where it goes, its GST basis and totals. At most one in force (approved) and one being
-- worked on at a time.
CREATE TABLE proc.po_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  revision int NOT NULL CHECK (revision >= 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'superseded', 'discarded')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 2000),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),     -- why this amendment
  site_id uuid REFERENCES proj.site (id),             -- delivered to: the place of supply
  deliver_by date,
  payment_terms text NOT NULL DEFAULT '' CHECK (length(payment_terms) <= 2000),
  delivery_terms text NOT NULL DEFAULT '' CHECK (length(delivery_terms) <= 2000),
  other_terms text NOT NULL DEFAULT '' CHECK (length(other_terms) <= 8000),
  supply text CHECK (supply IN ('intra', 'inter', 'unregistered')),   -- worked out from the GSTIN and site state
  subtotal numeric(20,2) NOT NULL DEFAULT 0,
  cgst numeric(20,2) NOT NULL DEFAULT 0,
  sgst numeric(20,2) NOT NULL DEFAULT 0,
  igst numeric(20,2) NOT NULL DEFAULT 0,
  total numeric(20,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  approved_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (po_id, revision)
);
CREATE UNIQUE INDEX po_revision_in_force ON proc.po_revision (po_id) WHERE status = 'approved';
CREATE UNIQUE INDEX po_revision_open ON proc.po_revision (po_id) WHERE status IN ('draft', 'submitted', 'rejected');
SELECT platform.secure_table('proc.po_revision');

CREATE TABLE proc.po_line (
  revision_id uuid NOT NULL REFERENCES proc.po_revision (id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position > 0),
  resource_id uuid REFERENCES est.resource (id),
  rfq_line_id uuid REFERENCES tender.rfq_line (id),  -- the enquiry line it was chosen on
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1000),
  hsn text CHECK (hsn IS NULL OR hsn ~ '^[0-9]{4,8}$'),   -- HSN (goods) or SAC (services) code
  unit text NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 20),
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  rate numeric(20,4) NOT NULL CHECK (rate >= 0),          -- before GST
  gst_pct numeric(5,2) NOT NULL DEFAULT 18 CHECK (gst_pct BETWEEN 0 AND 28),
  amount numeric(20,2) NOT NULL,
  cgst numeric(20,2) NOT NULL DEFAULT 0,
  sgst numeric(20,2) NOT NULL DEFAULT 0,
  igst numeric(20,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (revision_id, position)
);
CREATE INDEX po_line_rfq_line ON proc.po_line (rfq_line_id) WHERE rfq_line_id IS NOT NULL;
SELECT platform.secure_table('proc.po_line');
