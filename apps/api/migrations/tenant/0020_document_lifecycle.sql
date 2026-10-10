-- Documents deleted for good (docs/04-features.md E10 "retention", docs/wave1-plan.md step 13 part 6). Documents and
-- their versions stay protected from DELETE (migration 0013); the only way out is this function, which takes nothing
-- but a document already in the trash, and leaves a record of what went, who sent it and why. The files themselves
-- are removed later by the app (src/documents/lifecycle.service.ts), once no version anywhere in the tenant uses them.

CREATE TABLE doc.purged_document (
  id uuid PRIMARY KEY,                                  -- the document's id
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  name text NOT NULL,
  versions int NOT NULL,
  storage_keys text[] NOT NULL,
  deleted_at timestamptz NOT NULL,
  deleted_by uuid REFERENCES platform."user" (id),
  purged_at timestamptz NOT NULL DEFAULT now(),
  purged_by uuid REFERENCES platform."user" (id),     -- null: by the trash retention rule
  reason text NOT NULL CHECK (reason IN ('manual', 'retention')),
  files_checked_at timestamptz                          -- when unused files were removed from the store
);
CREATE INDEX purged_document_files ON doc.purged_document (purged_at) WHERE files_checked_at IS NULL;
SELECT platform.secure_table('doc.purged_document');
REVOKE DELETE, TRUNCATE ON doc.purged_document FROM aerolith_app;

CREATE INDEX document_trash ON doc.document (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE FUNCTION doc.purge_document(p_id uuid, p_actor uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d record;
  keys text[];
  n int;
BEGIN
  SELECT id, tender_id, name, deleted_at, deleted_by INTO d
  FROM doc.document WHERE id = p_id AND deleted_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT coalesce(array_agg(DISTINCT storage_key), '{}'), count(*) INTO keys, n
  FROM doc.document_version WHERE document_id = p_id;
  INSERT INTO doc.purged_document (id, tender_id, name, versions, storage_keys, deleted_at, deleted_by, purged_by, reason)
  VALUES (d.id, d.tender_id, d.name, n, keys, d.deleted_at, d.deleted_by, p_actor, p_reason);
  DELETE FROM doc.document_link WHERE document_id = p_id;
  DELETE FROM doc.document_version WHERE document_id = p_id;
  DELETE FROM doc.document WHERE id = p_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION doc.purge_document(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION doc.purge_document(uuid, uuid, text) TO aerolith_app;
