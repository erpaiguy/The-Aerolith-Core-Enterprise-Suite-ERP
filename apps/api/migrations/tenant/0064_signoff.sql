-- Wave 5 step 5 (docs/wave5-plan.md): internal sign-off with drawn signatures. A person's saved signature; a sign-off
-- of a PDF version by signers in order, each in a field on a page; the signed version made with an audit certificate,
-- and its hash kept so it can be verified.
CREATE TABLE dms.saved_signature (
  user_id uuid PRIMARY KEY REFERENCES platform."user" (id),
  png bytea NOT NULL CHECK (length(png) BETWEEN 100 AND 204800),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.secure_table('dms.saved_signature');

CREATE TABLE dms.signoff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  document_id uuid NOT NULL,
  version_no int NOT NULL,
  review_id uuid REFERENCES dms.review (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'signed', 'declined', 'cancelled')),
  source_sha256 bytea NOT NULL CHECK (length(source_sha256) = 32),
  signed_version_no int,
  signed_sha256 bytea CHECK (signed_sha256 IS NULL OR length(signed_sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  closed_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  FOREIGN KEY (document_id, version_no) REFERENCES doc.document_version (document_id, version_no),
  CHECK ((status = 'signed') = (signed_version_no IS NOT NULL AND signed_sha256 IS NOT NULL))
);
CREATE INDEX signoff_document ON dms.signoff (document_id, version_no) WHERE status = 'open';
SELECT platform.secure_table('dms.signoff');
REVOKE DELETE, TRUNCATE ON dms.signoff FROM aerolith_app;

CREATE TABLE dms.signoff_signer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signoff_id uuid NOT NULL REFERENCES dms.signoff (id),
  position int NOT NULL CHECK (position >= 1),
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  page int NOT NULL CHECK (page >= 1),
  x numeric(6, 5) NOT NULL, y numeric(6, 5) NOT NULL, w numeric(6, 5) NOT NULL, h numeric(6, 5) NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'signed', 'declined')),
  png bytea CHECK (png IS NULL OR length(png) BETWEEN 100 AND 204800),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 1000),
  acted_at timestamptz,
  session_id text,
  ip text,
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  UNIQUE (signoff_id, position),
  CHECK (x >= 0 AND y >= 0 AND w > 0 AND h > 0 AND x + w <= 1 AND y + h <= 1),
  CHECK ((status = 'signed') = (png IS NOT NULL)),
  CHECK ((status = 'waiting') = (acted_at IS NULL))
);
CREATE INDEX signoff_signer_user ON dms.signoff_signer (user_id) WHERE status = 'waiting';
SELECT platform.secure_table('dms.signoff_signer');
REVOKE DELETE, TRUNCATE ON dms.signoff_signer FROM aerolith_app;
