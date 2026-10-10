-- Searching inside PDFs and thumbnails (docs/04-features.md E10, docs/wave1-plan.md step 13 part 7).
--
-- The text of each PDF version is read once, in the background (src/documents/text.service.ts), and kept here with a
-- full-text index. 'simple' configuration: no stemming and no stop words, so codes ("IS 456"), Hindi and Marathi
-- words and names match as typed. Only the first 300,000 characters are indexed (a tsvector holds at most 1 MB).
CREATE TABLE doc.version_text (
  document_id uuid NOT NULL,
  version_no int NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'done', 'failed', 'skipped')),
  attempts int NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  pages int,
  text text CHECK (length(text) <= 2000000),
  note text,                                            -- why it failed or was skipped
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, left(coalesce(text, ''), 300000))) STORED,
  extracted_at timestamptz,
  PRIMARY KEY (document_id, version_no),
  FOREIGN KEY (document_id, version_no) REFERENCES doc.document_version (document_id, version_no)
);
CREATE INDEX version_text_tsv ON doc.version_text USING gin (tsv);
CREATE INDEX version_text_todo ON doc.version_text (status) WHERE status IN ('pending', 'working');
SELECT platform.secure_table('doc.version_text');

-- A small picture of the first page or the image, made by the uploader's browser (the server renders nothing).
CREATE TABLE doc.version_thumbnail (
  document_id uuid NOT NULL,
  version_no int NOT NULL,
  mime text NOT NULL CHECK (mime IN ('image/webp', 'image/png', 'image/jpeg')),
  bytes bytea NOT NULL CHECK (length(bytes) <= 204800),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (document_id, version_no),
  FOREIGN KEY (document_id, version_no) REFERENCES doc.document_version (document_id, version_no)
);
SELECT platform.secure_table('doc.version_thumbnail');

-- PDFs already uploaded are read too (their latest version).
INSERT INTO doc.version_text (document_id, version_no)
SELECT v.document_id, v.version_no FROM doc.document_version v JOIN doc.document d ON d.id = v.document_id
WHERE v.version_no = d.version_no AND v.mime = 'application/pdf';

-- Deleting a document for good takes its text and thumbnails with it.
CREATE OR REPLACE FUNCTION doc.purge_document(p_id uuid, p_actor uuid, p_reason text) RETURNS boolean
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
  DELETE FROM doc.version_text WHERE document_id = p_id;
  DELETE FROM doc.version_thumbnail WHERE document_id = p_id;
  DELETE FROM doc.document_version WHERE document_id = p_id;
  DELETE FROM doc.document WHERE id = p_id;
  RETURN true;
END $$;
