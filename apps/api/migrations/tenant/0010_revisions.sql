-- Wave 1 step 7: BOQ revisions (E6), copy-on-write (docs/05-database.md §4: a full copy of a 1M-line BOQ took 64 s
-- and ~780 MB in the Wave 0 benchmark). docs/wave1-plan.md.
--
-- est.boq.version_no is the version being worked on (draft) or the last one frozen. Freezing and starting the next
-- revision copy nothing. Instead, the first time a line changes in revision V, its state as frozen in V-1 is kept in
-- est.boq_node_hist (the "pre-image"). Any frozen version N is then: for each line, its pre-image with the smallest
-- frozen_version >= N if there is one, otherwise its current row; lines created after N are left out.

-- Constant defaults: metadata-only, even on a million-line table.
ALTER TABLE est.boq_node
  ADD COLUMN created_version int NOT NULL DEFAULT 1,   -- the version in whose draft the line was added
  ADD COLUMN hist_version int NOT NULL DEFAULT 0;      -- the last frozen version whose pre-image is kept

-- Lines added in a revision, for compare. Lines of version 1 (nearly all, on an imported BOQ) are not in it.
CREATE INDEX boq_node_added ON est.boq_node (boq_id, created_version) WHERE created_version > 1;

CREATE TABLE est.boq_node_hist (
  boq_id uuid NOT NULL,
  line_key uuid NOT NULL,
  frozen_version int NOT NULL,             -- the state of the line when this version was frozen
  id bigint NOT NULL,
  parent_id bigint,
  sort_key text COLLATE "C" NOT NULL,
  depth smallint NOT NULL,
  node_type text NOT NULL,
  code text,
  unit text,
  qty numeric(20,4),
  rate numeric(20,4),
  amount numeric(20,2),
  subtotal numeric(20,2) NOT NULL,
  child_count int NOT NULL,
  rate_analysis_id uuid,
  measured boolean NOT NULL,
  created_version int NOT NULL,
  -- Text is kept only when it changes afterwards (or the line is deleted); NULL means "as in the next state".
  description text,
  notes text,
  PRIMARY KEY (boq_id, line_key, frozen_version)
) PARTITION BY HASH (boq_id);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format('CREATE TABLE est.boq_node_hist_p%s PARTITION OF est.boq_node_hist FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    PERFORM platform.secure_table(format('est.boq_node_hist_p%s', i)::regclass);
  END LOOP;
END $$;
SELECT platform.secure_table('est.boq_node_hist');

-- One row per frozen version: what was frozen, when, by whom, its totals and the bid it carried.
CREATE TABLE est.boq_version (
  boq_id uuid NOT NULL REFERENCES est.boq (id),
  version_no int NOT NULL CHECK (version_no > 0),
  kind text NOT NULL CHECK (kind IN ('submitted', 'internal')),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 100),
  note text NOT NULL DEFAULT '',
  frozen_at timestamptz NOT NULL DEFAULT now(),
  frozen_by uuid REFERENCES platform."user" (id),
  total numeric(20,2) NOT NULL,
  node_count int NOT NULL,
  item_count int NOT NULL,
  rate_date date NOT NULL,
  scenario jsonb,                          -- the selected pricing scenario and its result, as frozen
  PRIMARY KEY (boq_id, version_no)
);
SELECT platform.secure_table('est.boq_version');

-- History is append-only for the app. (Pre-images may still get their text filled in once: UPDATE stays.)
REVOKE DELETE, TRUNCATE ON est.boq_node_hist FROM aerolith_app;
REVOKE UPDATE, DELETE, TRUNCATE ON est.boq_version FROM aerolith_app;

-- BOQs are never deleted (0004). One made by mistake is archived instead: read only, and left out of the tender's
-- bid summary and of the freeze on submission. A BOQ with a version submitted to the client stays on the record.
ALTER TABLE est.boq
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid REFERENCES platform."user" (id);
