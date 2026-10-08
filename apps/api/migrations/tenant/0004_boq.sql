-- Wave 1 step 2: BOQ engine (docs/05-database.md §4, docs/wave1-plan.md). The design measured in the Wave 0 benchmark,
-- without ltree: ancestors are read from the sort key (each key is its parent's key + '!' + its own segment), so no
-- database extension is needed in the tenant's project.

CREATE SCHEMA est;
GRANT USAGE ON SCHEMA est TO aerolith_app;

CREATE TABLE est.boq (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  version_no int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked', 'submitted')),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  node_count int NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  item_count int NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  total numeric(20,2) NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX boq_tender ON est.boq (tender_id);
SELECT platform.secure_table('est.boq');

CREATE SEQUENCE est.boq_node_id_seq;

-- Hot, narrow line rows. `subtotal` is kept on sections and updated by deltas, never summed on read.
CREATE TABLE est.boq_node (
  boq_id uuid NOT NULL,
  id bigint NOT NULL DEFAULT nextval('est.boq_node_id_seq'),
  line_key uuid NOT NULL DEFAULT gen_random_uuid(),   -- stable identity across revisions (step 7)
  parent_id bigint,
  sort_key text COLLATE "C" NOT NULL CHECK (sort_key ~ '^[0-9a-z]+(![0-9a-z]+)*$'),
  depth smallint NOT NULL CHECK (depth BETWEEN 0 AND 30),
  node_type text NOT NULL CHECK (node_type IN ('section', 'item', 'note')),
  code text,
  unit text,
  qty numeric(20,4),
  rate numeric(20,4),
  amount numeric(20,2),
  subtotal numeric(20,2) NOT NULL DEFAULT 0,
  child_count int NOT NULL DEFAULT 0 CHECK (child_count >= 0),
  row_version int NOT NULL DEFAULT 1,
  PRIMARY KEY (boq_id, id),
  CHECK (node_type = 'item' OR (qty IS NULL AND rate IS NULL AND amount IS NULL)),
  CHECK (node_type = 'section' OR (child_count = 0 AND subtotal = 0))
) PARTITION BY HASH (boq_id);
CREATE UNIQUE INDEX boq_node_sort ON est.boq_node (boq_id, sort_key);
CREATE INDEX boq_node_line_key ON est.boq_node (boq_id, line_key);
-- Sections are a few percent of lines: the outline reads them without touching items.
CREATE INDEX boq_node_sections ON est.boq_node (boq_id, sort_key) WHERE node_type = 'section';

-- Wide, cold text kept out of the hot row.
CREATE TABLE est.boq_node_text (
  boq_id uuid NOT NULL,
  node_id bigint NOT NULL,
  description text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  PRIMARY KEY (boq_id, node_id),
  FOREIGN KEY (boq_id, node_id) REFERENCES est.boq_node (boq_id, id) ON DELETE CASCADE
) PARTITION BY HASH (boq_id);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format('CREATE TABLE est.boq_node_p%s PARTITION OF est.boq_node FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    EXECUTE format('CREATE TABLE est.boq_node_text_p%s PARTITION OF est.boq_node_text FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    PERFORM platform.secure_table(format('est.boq_node_p%s', i)::regclass);
    PERFORM platform.secure_table(format('est.boq_node_text_p%s', i)::regclass);
  END LOOP;
END $$;
SELECT platform.secure_table('est.boq_node');
SELECT platform.secure_table('est.boq_node_text');

-- BOQs are documents: never deleted by the app (archiving comes with revisions in step 7). Lines can be deleted.
REVOKE DELETE, TRUNCATE ON est.boq FROM aerolith_app;
