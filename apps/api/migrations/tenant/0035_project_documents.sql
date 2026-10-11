-- Wave 2b step 8 (docs/wave2b-plan.md): project documents. Wave 1's vault (folders, documents, versions, trash, links,
-- search, thumbnails, text) now belongs to a tender or to a project: exactly one of the two. A project's vault is kept
-- to its team, like its BOQs and schedules. Its drawings register lists each drawing and its revisions, each revision a
-- version of one document in the vault; a new revision supersedes the one before.

ALTER TABLE doc.folder ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE doc.folder ADD COLUMN project_id uuid REFERENCES proj.project (id);
ALTER TABLE doc.folder ADD CONSTRAINT folder_one_owner CHECK ((tender_id IS NULL) <> (project_id IS NULL));
CREATE UNIQUE INDEX folder_name_project ON doc.folder
  (project_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE project_id IS NOT NULL;

ALTER TABLE doc.document ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE doc.document ADD COLUMN project_id uuid REFERENCES proj.project (id);
ALTER TABLE doc.document ADD CONSTRAINT document_one_owner CHECK ((tender_id IS NULL) <> (project_id IS NULL));
CREATE UNIQUE INDEX document_name_project ON doc.document
  (project_id, coalesce(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE deleted_at IS NULL AND project_id IS NOT NULL;
CREATE INDEX document_project ON doc.document (project_id) WHERE project_id IS NOT NULL;

-- Links: a project's documents link to its enquiries' vendors and to goods receipts (challans, test certificates).
ALTER TABLE doc.document_link ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE doc.document_link ADD COLUMN project_id uuid REFERENCES proj.project (id);
ALTER TABLE doc.document_link ADD CONSTRAINT document_link_one_owner CHECK ((tender_id IS NULL) <> (project_id IS NULL));
ALTER TABLE doc.document_link DROP CONSTRAINT document_link_target_kind_check;
ALTER TABLE doc.document_link ADD CONSTRAINT document_link_target_kind_check
  CHECK (target_kind IN ('rfq_vendor', 'checklist_item', 'addendum', 'goods_receipt'));

ALTER TABLE doc.purged_document ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE doc.purged_document ADD COLUMN project_id uuid REFERENCES proj.project (id);

CREATE OR REPLACE FUNCTION doc.purge_document(p_id uuid, p_actor uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d record;
  keys text[];
  n int;
BEGIN
  SELECT id, tender_id, project_id, name, deleted_at, deleted_by INTO d
  FROM doc.document WHERE id = p_id AND deleted_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT coalesce(array_agg(DISTINCT storage_key), '{}'), count(*) INTO keys, n
  FROM doc.document_version WHERE document_id = p_id;
  INSERT INTO doc.purged_document (id, tender_id, project_id, name, versions, storage_keys, deleted_at, deleted_by,
    purged_by, reason)
  VALUES (d.id, d.tender_id, d.project_id, d.name, n, keys, d.deleted_at, d.deleted_by, p_actor, p_reason);
  DELETE FROM doc.document_link WHERE document_id = p_id;
  DELETE FROM doc.version_text WHERE document_id = p_id;
  DELETE FROM doc.version_thumbnail WHERE document_id = p_id;
  DELETE FROM doc.document_version WHERE document_id = p_id;
  DELETE FROM doc.document WHERE id = p_id;
  RETURN true;
END $$;

-- The drawings register.
CREATE TABLE proj.drawing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL CHECK (length(trim(number)) BETWEEN 1 AND 60),   -- the designer's drawing number
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  discipline text NOT NULL CHECK (discipline IN ('architectural', 'structural', 'electrical', 'plumbing', 'hvac',
    'fire', 'landscape', 'interiors', 'other')),
  document_id uuid REFERENCES doc.document (id),       -- its file in the vault; each revision is a version of it
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX drawing_number ON proj.drawing (project_id, lower(number));
SELECT platform.secure_table('proj.drawing');
REVOKE DELETE, TRUNCATE ON proj.drawing FROM aerolith_app;

CREATE TABLE proj.drawing_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id uuid NOT NULL REFERENCES proj.drawing (id),
  revision text NOT NULL CHECK (length(trim(revision)) BETWEEN 1 AND 20),   -- "P1", "0", "A", "R2"
  purpose text NOT NULL CHECK (purpose IN ('information', 'approval', 'construction')),
  received_from text NOT NULL DEFAULT '' CHECK (length(received_from) <= 200),
  received_on date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  version_no int,                                      -- the vault version holding its file
  superseded_at timestamptz,                           -- set when a later revision arrives
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE UNIQUE INDEX drawing_revision_label ON proj.drawing_revision (drawing_id, lower(revision));
CREATE INDEX drawing_revision_drawing ON proj.drawing_revision (drawing_id, created_at);
SELECT platform.secure_table('proj.drawing_revision');
REVOKE DELETE, TRUNCATE ON proj.drawing_revision FROM aerolith_app;
