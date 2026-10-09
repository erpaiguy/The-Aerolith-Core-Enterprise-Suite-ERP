-- Wave 1 step 6: measurement sheets (E4) and bid pricing (E5). docs/wave1-plan.md.

-- Measurement rows of a BOQ item: nos × length × breadth × height, blank dimensions skipped; deductions count negative.
-- When an item has rows, its quantity is their total (est.boq_node.measured marks it).
CREATE TABLE est.measurement (
  boq_id uuid NOT NULL,
  node_id bigint NOT NULL,
  seq int NOT NULL CHECK (seq > 0),
  description text NOT NULL DEFAULT '',
  nos numeric(20,4),
  length numeric(20,4),
  breadth numeric(20,4),
  height numeric(20,4),
  deduct boolean NOT NULL DEFAULT false,
  qty numeric(20,4) NOT NULL,              -- signed: negative for deductions
  PRIMARY KEY (boq_id, node_id, seq),
  FOREIGN KEY (boq_id, node_id) REFERENCES est.boq_node (boq_id, id) ON DELETE CASCADE,
  CHECK (nos IS NOT NULL OR length IS NOT NULL OR breadth IS NOT NULL OR height IS NOT NULL)
) PARTITION BY HASH (boq_id);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format('CREATE TABLE est.measurement_p%s PARTITION OF est.measurement FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    PERFORM platform.secure_table(format('est.measurement_p%s', i)::regclass);
  END LOOP;
END $$;
SELECT platform.secure_table('est.measurement');

-- Constant default: metadata-only, even on a million-line table.
ALTER TABLE est.boq_node ADD COLUMN measured boolean NOT NULL DEFAULT false;

-- Pricing scenarios of a BOQ: markups on the BOQ total (its base cost), then GST. One may be selected as the bid.
-- markups: [{kind, label, basis: 'base' | 'running', pct?, amount?}] applied in order.
CREATE TABLE est.pricing_scenario (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boq_id uuid NOT NULL REFERENCES est.boq (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  notes text NOT NULL DEFAULT '',
  markups jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(markups) = 'array'),
  gst_pct numeric(5,2) NOT NULL DEFAULT 18 CHECK (gst_pct BETWEEN 0 AND 100),
  gst_mode text NOT NULL DEFAULT 'add' CHECK (gst_mode IN ('add', 'included', 'exempt')),
  selected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX pricing_scenario_name ON est.pricing_scenario (boq_id, lower(name));
CREATE UNIQUE INDEX pricing_scenario_selected ON est.pricing_scenario (boq_id) WHERE selected;
SELECT platform.secure_table('est.pricing_scenario');
