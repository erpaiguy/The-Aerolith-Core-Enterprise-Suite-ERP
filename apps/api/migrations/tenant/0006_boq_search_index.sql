-- Trigram indexes for BOQ search (owner decision: every tenant). Makes "contains" search on descriptions and codes
-- fast at any size, at a storage cost of roughly 22% of BOQ data (docs/wave1-plan.md step 2).
-- The indexes lead with boq_id (btree_gin), so one index answers "this BOQ AND contains text" even when many BOQs
-- share a partition. pg_trgm and btree_gin are trusted extensions: the migration role (CREATE on the database) can
-- install them. Extensions a project already has, in whatever schema, are reused.
DO $$
DECLARE
  trgm text;
  btree text;
BEGIN
  SELECT n.nspname INTO trgm FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  SELECT n.nspname INTO btree FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'btree_gin';
  IF trgm IS NULL OR btree IS NULL THEN
    CREATE SCHEMA IF NOT EXISTS ext;
  END IF;
  IF trgm IS NULL THEN
    CREATE EXTENSION pg_trgm WITH SCHEMA ext;
    trgm := 'ext';
  END IF;
  IF btree IS NULL THEN
    CREATE EXTENSION btree_gin WITH SCHEMA ext;
    btree := 'ext';
  END IF;
  EXECUTE format(
    'CREATE INDEX boq_node_text_trgm ON est.boq_node_text USING gin (boq_id %I.uuid_ops, description %I.gin_trgm_ops)',
    btree, trgm);
  EXECUTE format(
    'CREATE INDEX boq_node_code_trgm ON est.boq_node USING gin (boq_id %I.uuid_ops, code %I.gin_trgm_ops)',
    btree, trgm);
END $$;
