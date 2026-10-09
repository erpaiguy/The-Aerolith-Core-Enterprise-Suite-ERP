-- Wave 1 step 10: tender documents (docs/04-features.md E10 and P8, docs/05-database.md §7, docs/wave1-plan.md step 10).
-- Each tender has a vault of folders and documents; every upload of a document is a version. The bytes live outside
-- the database (src/documents/file-store.ts), named by their SHA-256, so a version row points at its exact content.
-- Folders form a tree by parent_id (vaults are small; no ltree needed). A restricted folder (our prices, vendor
-- quotes) and everything in it is visible only to roles that may see pricing.

CREATE SCHEMA doc;
GRANT USAGE ON SCHEMA doc TO aerolith_app;

CREATE TABLE doc.folder (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  parent_id uuid REFERENCES doc.folder (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120 AND name !~ '[/\\]' AND name = trim(name)),
  -- Set on a folder and every folder under it (kept so by the service): visible only with pricing.edit.
  restricted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX folder_name ON doc.folder
  (tender_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX folder_parent ON doc.folder (parent_id);
SELECT platform.secure_table('doc.folder');

CREATE TABLE doc.document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  folder_id uuid REFERENCES doc.folder (id),           -- null: the vault's top level
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 255 AND name !~ '[/\\]' AND name = trim(name)),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  version_no int NOT NULL DEFAULT 1 CHECK (version_no > 0),   -- the latest version
  deleted_at timestamptz,                              -- in the trash; restorable
  deleted_by uuid REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
-- One live document per name in a folder: uploading the same name again makes a new version.
CREATE UNIQUE INDEX document_name ON doc.document
  (tender_id, coalesce(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX document_folder ON doc.document (folder_id);
CREATE INDEX document_tender ON doc.document (tender_id);
CREATE INDEX document_tags ON doc.document USING gin (tags);
SELECT platform.secure_table('doc.document');

CREATE TABLE doc.document_version (
  document_id uuid NOT NULL REFERENCES doc.document (id),
  version_no int NOT NULL CHECK (version_no > 0),
  storage_key text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{64}$'),   -- SHA-256 of the bytes
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  mime text NOT NULL CHECK (length(mime) <= 120),
  original_name text NOT NULL CHECK (length(original_name) <= 255),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  scan_status text NOT NULL CHECK (scan_status IN ('clean', 'not_scanned')),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (document_id, version_no)
);
CREATE INDEX document_version_key ON doc.document_version (storage_key);
SELECT platform.secure_table('doc.document_version');

-- Search by name, reusing the trigram extension of migration 0006 wherever the project has it.
DO $$
DECLARE
  trgm text;
BEGIN
  SELECT n.nspname INTO trgm FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  EXECUTE format('CREATE INDEX document_name_trgm ON doc.document USING gin (name %I.gin_trgm_ops)', trgm);
END $$;

-- Documents and their versions are records: the app moves documents to the trash, never deletes them, and a version
-- never changes once uploaded.
REVOKE DELETE, TRUNCATE ON doc.document, doc.document_version FROM aerolith_app;
REVOKE UPDATE ON doc.document_version FROM aerolith_app;
