// Benchmark schema: the BOQ and schedule tables from docs/05-database.md §4 and §6, trimmed to what is measured.
export const PARTITIONS = 16;

export function schemaSql(): string {
  const partitions = (table: string, modulus: number) =>
    Array.from(
      { length: modulus },
      (_, i) =>
        `CREATE TABLE ${table}_p${i} PARTITION OF ${table} FOR VALUES WITH (MODULUS ${modulus}, REMAINDER ${i});`,
    ).join('\n');

  return `
DROP SCHEMA IF EXISTS est CASCADE;
DROP SCHEMA IF EXISTS sched CASCADE;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA est;
CREATE SCHEMA sched;

CREATE TABLE est.boq (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version_no int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked', 'submitted')),
  node_count int NOT NULL DEFAULT 0,
  total numeric(20,2) NOT NULL DEFAULT 0,
  row_version int NOT NULL DEFAULT 1
);

CREATE TABLE est.boq_node (
  boq_id uuid NOT NULL,
  id bigint NOT NULL,
  line_key uuid NOT NULL,
  parent_id bigint,
  path ltree NOT NULL,
  sort_key text COLLATE "C" NOT NULL,
  depth smallint NOT NULL,
  node_type text NOT NULL CHECK (node_type IN ('section', 'item', 'note')),
  code text,
  unit text,
  qty numeric(20,4),
  rate numeric(20,4),
  amount numeric(20,2),
  subtotal numeric(20,2),
  row_version int NOT NULL DEFAULT 1,
  PRIMARY KEY (boq_id, id)
) PARTITION BY HASH (boq_id);
${partitions('est.boq_node', PARTITIONS)}

CREATE TABLE est.boq_node_text (
  boq_id uuid NOT NULL,
  node_id bigint NOT NULL,
  description text NOT NULL,
  PRIMARY KEY (boq_id, node_id)
) PARTITION BY HASH (boq_id);
${partitions('est.boq_node_text', PARTITIONS)}

CREATE UNLOGGED TABLE est.boq_import_stage (
  id bigint, line_key uuid, parent_id bigint, path text, sort_key text COLLATE "C", depth smallint,
  node_type text, code text, unit text, qty numeric(20,4), rate numeric(20,4), amount numeric(20,2),
  subtotal numeric(20,2), description text
);

CREATE SEQUENCE est.boq_node_id_seq;

CREATE TABLE sched.plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('tender_programme', 'micro', 'macro')),
  tender_id uuid,
  project_id uuid,
  CHECK (kind <> 'tender_programme' OR (tender_id IS NOT NULL AND project_id IS NULL))
);

CREATE TABLE sched.activity (
  plan_id uuid NOT NULL,
  id int NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  duration int NOT NULL,
  early_start int, early_finish int, late_start int, late_finish int, total_float int,
  PRIMARY KEY (plan_id, id)
) PARTITION BY HASH (plan_id);
${partitions('sched.activity', 8)}

CREATE TABLE sched.relation (
  plan_id uuid NOT NULL,
  pred_id int NOT NULL,
  succ_id int NOT NULL,
  type text NOT NULL CHECK (type IN ('FS', 'SS', 'FF', 'SF')),
  lag int NOT NULL DEFAULT 0
);
`;
}

// Created after the bulk load: building indexes once is much faster than maintaining them row by row.
export const indexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS boq_node_sort ON est.boq_node (boq_id, sort_key);
CREATE INDEX IF NOT EXISTS boq_node_amount ON est.boq_node (boq_id, amount DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS boq_node_text_trgm ON est.boq_node_text USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS relation_plan ON sched.relation (plan_id);
`;
