-- BOQ templates (docs/01-mvp.md "templates", docs/04-features.md E3 "per-vertical templates"): a company's standard
-- BOQ structure (sections, items, units, and optionally quantities and rates) saved from a BOQ, to start new BOQs
-- from. A template is a copy, never linked back: changing it does not change BOQs made from it.
CREATE TABLE est.boq_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  vertical text NOT NULL DEFAULT 'buildings' CHECK (vertical IN ('buildings', 'interiors', 'joinery', 'mep', 'other')),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  with_quantities boolean NOT NULL,
  with_rates boolean NOT NULL,
  line_count int NOT NULL,
  item_count int NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX boq_template_name ON est.boq_template (lower(name)) WHERE archived_at IS NULL;
SELECT platform.secure_table('est.boq_template');

CREATE TABLE est.boq_template_line (
  template_id uuid NOT NULL REFERENCES est.boq_template (id),
  seq int NOT NULL,
  depth smallint NOT NULL CHECK (depth BETWEEN 0 AND 30),
  node_type text NOT NULL CHECK (node_type IN ('section', 'item', 'note')),
  item_kind text NOT NULL DEFAULT 'normal' CHECK (item_kind IN ('normal', 'provisional', 'rate_only', 'alternate')),
  code text,
  description text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  unit text,
  qty numeric(20,4),
  rate numeric(20,4),
  rate_analysis_id uuid REFERENCES est.rate_analysis (id),
  PRIMARY KEY (template_id, seq)
);
SELECT platform.secure_table('est.boq_template_line');
-- Templates are archived, not deleted: a BOQ's activity may name the template it came from.
REVOKE DELETE, TRUNCATE ON est.boq_template, est.boq_template_line FROM aerolith_app;
