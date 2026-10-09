-- Wave 1 step 12 (part 2): dashboards (docs/08-dashboard.md §2.6). Each user's extra tiles per dashboard, in their
-- order. The tiles themselves are built-in queries defined in code (src/dashboard/tiles.ts); only keys are stored, so
-- a tile retired in a later release simply stops showing.
CREATE TABLE platform.dashboard_layout (
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  dashboard text NOT NULL CHECK (dashboard IN ('tender', 'estimation')),
  tiles text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tiles) <= 24),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dashboard)
);
SELECT platform.secure_table('platform.dashboard_layout');

-- "Items not priced" is counted across every BOQ in progress (estimation dashboard): unpriced items are few, so a
-- partial index finds them without reading the BOQs' lines.
CREATE INDEX boq_node_unpriced ON est.boq_node (boq_id) WHERE node_type = 'item' AND rate IS NULL;

-- The cost mix of each BOQ (its item amounts by rate analysis), kept for the estimation dashboard's breakdown so it
-- does not add up every line of every BOQ in progress on each view. A cache, not a record: a row is valid while its
-- stamp (the BOQ's updated_at, total, rate date and version, all changed by every write to its lines) matches the
-- BOQ, and is recomputed when it does not.
CREATE TABLE est.boq_cost_mix (
  boq_id uuid PRIMARY KEY REFERENCES est.boq (id),
  stamp text NOT NULL,
  mix jsonb NOT NULL,                 -- [{"a": rate analysis id or null, "v": "amount"}]
  computed_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.secure_table('est.boq_cost_mix');
