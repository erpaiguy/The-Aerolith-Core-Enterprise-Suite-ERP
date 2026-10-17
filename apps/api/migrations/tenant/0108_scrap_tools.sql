-- Scrap and tools (docs/wave8-plan.md step 8e.5). Scrap noted on site as it arises (steel cut ends, empty cement
-- bags, demolition) and sold to a scrap buyer with GST, posted to the scrap sales ledger; returnable tools issued
-- to a person or gang until a date, with what comes back and what is lost.
CREATE TABLE proc.scrap_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  material text NOT NULL CHECK (length(trim(material)) BETWEEN 2 AND 200),
  unit text NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 20),
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  source text NOT NULL CHECK (source IN ('cut_ends', 'packing', 'demolition', 'damaged', 'other')),
  noted_on date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX scrap_entry_project ON proc.scrap_entry (project_id, lower(material), lower(unit));
SELECT platform.secure_table('proc.scrap_entry');
REVOKE UPDATE, DELETE, TRUNCATE ON proc.scrap_entry FROM aerolith_app;

CREATE TABLE proc.scrap_sale (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  site_id uuid NOT NULL REFERENCES proj.site (id),
  number text NOT NULL UNIQUE,
  party_id uuid NOT NULL REFERENCES platform.party (id),
  sold_on date NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  cgst numeric(20,2) NOT NULL DEFAULT 0,
  sgst numeric(20,2) NOT NULL DEFAULT 0,
  igst numeric(20,2) NOT NULL DEFAULT 0,
  total numeric(20,2) NOT NULL,
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('proc.scrap_sale');
REVOKE UPDATE, DELETE, TRUNCATE ON proc.scrap_sale FROM aerolith_app;

CREATE TABLE proc.scrap_sale_line (
  sale_id uuid NOT NULL REFERENCES proc.scrap_sale (id),
  position int NOT NULL CHECK (position > 0),
  material text NOT NULL,
  unit text NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  rate numeric(20,4) NOT NULL CHECK (rate > 0),
  gst_pct numeric(5,2) NOT NULL CHECK (gst_pct BETWEEN 0 AND 28),
  amount numeric(20,2) NOT NULL,
  PRIMARY KEY (sale_id, position)
);
SELECT platform.secure_table('proc.scrap_sale_line');

CREATE TABLE proc.tool_issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  tool text NOT NULL CHECK (length(trim(tool)) BETWEEN 2 AND 200),
  qty int NOT NULL CHECK (qty > 0),
  issued_to text NOT NULL CHECK (length(trim(issued_to)) BETWEEN 2 AND 200),   -- a person, or a gang and its mukadam
  issued_on date NOT NULL,
  due_on date NOT NULL CHECK (due_on >= issued_on),
  returned_qty int NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  lost_qty int NOT NULL DEFAULT 0 CHECK (lost_qty >= 0),
  closed_on date,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK (returned_qty + lost_qty <= qty)
);
CREATE INDEX tool_issue_open ON proc.tool_issue (project_id, due_on) WHERE closed_on IS NULL;
SELECT platform.secure_table('proc.tool_issue');
REVOKE DELETE, TRUNCATE ON proc.tool_issue FROM aerolith_app;
