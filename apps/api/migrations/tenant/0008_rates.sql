-- Wave 1 step 5: rate library (E1) and rate analysis (E2). docs/wave1-plan.md.
-- The tenant's own masters only: no bundled third-party schedules of rates.

-- Resources: what work is built from. Rates are versioned by date, so an estimate priced "as on" a date is repeatable.
CREATE TABLE est.resource (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 500),
  kind text NOT NULL CHECK (kind IN ('material', 'labour', 'equipment', 'subcontract', 'other')),
  unit text NOT NULL CHECK (length(unit) BETWEEN 1 AND 20),
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX resource_code ON est.resource (lower(code));
SELECT platform.secure_table('est.resource');

CREATE TABLE est.resource_rate (
  resource_id uuid NOT NULL REFERENCES est.resource (id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  rate numeric(20,4) NOT NULL CHECK (rate >= 0),
  source text NOT NULL DEFAULT '',           -- "Supplier quote 14/2026", "Market survey Oct 2026"
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (resource_id, effective_from)
);
SELECT platform.secure_table('est.resource_rate');

-- A rate analysis prices one item of work for `output_qty` units (CPWD-style analyses are often "for 10 cum").
-- `additions` are percentages applied in order on the running total, e.g. water charges 1 %, then contractor's
-- profit and overheads 15 %.
CREATE TABLE est.rate_analysis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 10000),
  unit text NOT NULL CHECK (length(unit) BETWEEN 1 AND 20),
  output_qty numeric(20,4) NOT NULL DEFAULT 1 CHECK (output_qty > 0),
  additions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(additions) = 'array'),
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX rate_analysis_code ON est.rate_analysis (lower(code));
SELECT platform.secure_table('est.rate_analysis');

-- Lines: a resource × quantity (+ wastage), another analysis × quantity (mortar inside brickwork), or a lump sum.
-- Quantities are per `output_qty` of the parent analysis.
CREATE TABLE est.rate_analysis_line (
  analysis_id uuid NOT NULL REFERENCES est.rate_analysis (id) ON DELETE CASCADE,
  line_no int NOT NULL CHECK (line_no > 0),
  kind text NOT NULL CHECK (kind IN ('resource', 'analysis', 'lump_sum')),
  resource_id uuid REFERENCES est.resource (id),
  sub_analysis_id uuid REFERENCES est.rate_analysis (id),
  description text NOT NULL DEFAULT '',
  qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  wastage_pct numeric(7,4) NOT NULL DEFAULT 0 CHECK (wastage_pct BETWEEN 0 AND 100),
  amount numeric(20,4),                      -- lump sums only
  PRIMARY KEY (analysis_id, line_no),
  CHECK (
    (kind = 'resource' AND resource_id IS NOT NULL AND sub_analysis_id IS NULL AND amount IS NULL) OR
    (kind = 'analysis' AND sub_analysis_id IS NOT NULL AND resource_id IS NULL AND amount IS NULL
      AND sub_analysis_id <> analysis_id) OR
    (kind = 'lump_sum' AND resource_id IS NULL AND sub_analysis_id IS NULL AND amount IS NOT NULL)
  )
);
CREATE INDEX rate_analysis_line_resource ON est.rate_analysis_line (resource_id) WHERE resource_id IS NOT NULL;
CREATE INDEX rate_analysis_line_sub ON est.rate_analysis_line (sub_analysis_id) WHERE sub_analysis_id IS NOT NULL;
SELECT platform.secure_table('est.rate_analysis_line');

-- BOQ items can take their rate from an analysis. The link is not live: the BOQ is a document, so rates change only
-- when someone applies an analysis or refreshes the BOQ's rates (as on the BOQ's rate date).
ALTER TABLE est.boq ADD COLUMN rate_date date NOT NULL DEFAULT current_date;
-- Metadata-only on existing tables (nullable, no default). Analyses in use cannot be deleted (archive instead).
ALTER TABLE est.boq_node ADD COLUMN rate_analysis_id uuid REFERENCES est.rate_analysis (id);
CREATE INDEX boq_node_rate_analysis ON est.boq_node (boq_id, rate_analysis_id)
  WHERE rate_analysis_id IS NOT NULL;

-- Masters are kept, not deleted, once used; the app archives them (active = false).
REVOKE DELETE, TRUNCATE ON est.resource, est.rate_analysis FROM aerolith_app;
