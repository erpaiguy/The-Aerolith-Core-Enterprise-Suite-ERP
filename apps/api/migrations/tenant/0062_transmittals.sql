-- Wave 5 step 3 (docs/wave5-plan.md): transmittals of document versions to a recipient, acknowledged and answered
-- (also through an expiring link, only its hash kept); RFIs from site to an assignee; submittals sent for approval
-- through a review, a material submittal carrying its material approval along.
CREATE TABLE dms.transmittal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  subject text NOT NULL CHECK (length(trim(subject)) BETWEEN 3 AND 300),
  party_id uuid REFERENCES platform.party (id),
  recipient text NOT NULL CHECK (length(trim(recipient)) BETWEEN 2 AND 200),
  email text CHECK (email IS NULL OR length(email) <= 254),
  purpose text NOT NULL CHECK (purpose IN ('information', 'review', 'construction', 'record')),
  response_days int CHECK (response_days IS NULL OR response_days BETWEEN 1 AND 90),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'acknowledged', 'responded', 'closed')),
  issued_on date,
  due_on date,
  issued_by uuid REFERENCES platform."user" (id),
  acknowledged_at timestamptz,
  acknowledged_by text,                       -- the name the recipient typed, or the staff member's
  response text,
  response_code text REFERENCES dms.status_code (code),
  response_document_id uuid REFERENCES doc.document (id),
  responded_at timestamptz,
  responded_by text,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  CHECK ((status = 'draft') = (issued_on IS NULL)),
  CHECK (purpose <> 'review' OR response_days IS NOT NULL)
);
SELECT platform.secure_table('dms.transmittal');
REVOKE DELETE, TRUNCATE ON dms.transmittal FROM aerolith_app;

CREATE TABLE dms.transmittal_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transmittal_id uuid NOT NULL REFERENCES dms.transmittal (id),
  position int NOT NULL,
  document_id uuid NOT NULL,
  version_no int NOT NULL,
  copies int NOT NULL DEFAULT 1 CHECK (copies BETWEEN 0 AND 100),
  remark text NOT NULL DEFAULT '' CHECK (length(remark) <= 300),
  UNIQUE (transmittal_id, document_id, version_no),
  FOREIGN KEY (document_id, version_no) REFERENCES doc.document_version (document_id, version_no)
);
SELECT platform.secure_table('dms.transmittal_item');

-- An outsider's link: only the SHA-256 of its token is kept.
CREATE TABLE dms.share_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transmittal_id uuid NOT NULL REFERENCES dms.transmittal (id),
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES platform."user" (id)
);
CREATE INDEX share_link_transmittal ON dms.share_link (transmittal_id);
SELECT platform.secure_table('dms.share_link');
REVOKE DELETE, TRUNCATE ON dms.share_link FROM aerolith_app;

CREATE TABLE dms.share_event (
  id bigserial PRIMARY KEY,
  link_id uuid NOT NULL REFERENCES dms.share_link (id),
  kind text NOT NULL CHECK (kind IN ('open', 'download', 'acknowledge', 'respond')),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 300),
  ip text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_event_link ON dms.share_event (link_id, at);
SELECT platform.secure_table('dms.share_event');
REVOKE UPDATE, DELETE, TRUNCATE ON dms.share_event FROM aerolith_app;

CREATE TABLE dms.rfi (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  subject text NOT NULL CHECK (length(trim(subject)) BETWEEN 3 AND 300),
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 3 AND 4000),
  document_id uuid,
  version_no int,
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 200),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 200),
  assigned_to uuid NOT NULL REFERENCES platform."user" (id),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  answer text,
  answer_document_id uuid REFERENCES doc.document (id),
  answered_at timestamptz,
  answered_by uuid REFERENCES platform."user" (id),
  outcome text NOT NULL DEFAULT 'none' CHECK (outcome IN ('none', 'variation', 'revision')),
  variation_id uuid REFERENCES ctl.variation (id),
  revised_document_id uuid,
  revised_version_no int,
  raised_at timestamptz NOT NULL DEFAULT now(),
  raised_by uuid NOT NULL REFERENCES platform."user" (id),
  closed_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  FOREIGN KEY (document_id, version_no) REFERENCES doc.document_version (document_id, version_no),
  FOREIGN KEY (revised_document_id, revised_version_no) REFERENCES doc.document_version (document_id, version_no),
  CHECK ((status = 'open') = (answered_at IS NULL)),
  CHECK (outcome <> 'variation' OR variation_id IS NOT NULL),
  CHECK (outcome <> 'revision' OR revised_document_id IS NOT NULL)
);
CREATE INDEX rfi_assignee ON dms.rfi (assigned_to) WHERE status = 'open';
SELECT platform.secure_table('dms.rfi');
REVOKE DELETE, TRUNCATE ON dms.rfi FROM aerolith_app;

CREATE TABLE dms.submittal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('shop_drawing', 'method_statement', 'material', 'sample', 'other')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  review_id uuid NOT NULL REFERENCES dms.review (id),   -- the latest review; resubmissions move it on
  material_approval_id uuid REFERENCES qa.material_approval (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  UNIQUE (project_id, number),
  CHECK (material_approval_id IS NULL OR kind = 'material')
);
CREATE UNIQUE INDEX submittal_review ON dms.submittal (review_id);
SELECT platform.secure_table('dms.submittal');
REVOKE DELETE, TRUNCATE ON dms.submittal FROM aerolith_app;
