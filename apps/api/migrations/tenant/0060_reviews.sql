-- Wave 5 step 1 (docs/wave5-plan.md): document review workflows on their own engine. Status codes with fixed effects,
-- workflow templates of stages (reviewers by person, project role or designation; everyone or anyone; due days),
-- and reviews of a document version stage by stage, each reviewer's code and comment kept.
CREATE SCHEMA dms;
GRANT USAGE ON SCHEMA dms TO aerolith_app;

CREATE TABLE dms.status_code (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{1,4}$'),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  effect text NOT NULL CHECK (effect IN ('approve', 'approve_comments', 'return', 'reject')),
  position int NOT NULL,
  active boolean NOT NULL DEFAULT true
);
SELECT platform.secure_table('dms.status_code');
INSERT INTO dms.status_code (code, label, effect, position) VALUES
  ('A', 'Approved', 'approve', 1),
  ('B', 'Approved with comments', 'approve_comments', 2),
  ('C', 'Revise and resubmit', 'return', 3),
  ('D', 'Rejected', 'reject', 4);

CREATE TABLE dms.workflow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES proj.project (id),    -- NULL: the company's
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  -- [{name, mode: 'all' | 'any', dueDays, reviewers: [{kind: 'user' | 'lead' | 'member' | 'designation', id?}]}]
  stages jsonb NOT NULL CHECK (jsonb_typeof(stages) = 'array' AND jsonb_array_length(stages) BETWEEN 1 AND 10),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
SELECT platform.secure_table('dms.workflow');

CREATE TABLE dms.review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  document_id uuid NOT NULL REFERENCES doc.document (id),
  version_no int NOT NULL,
  workflow_id uuid NOT NULL REFERENCES dms.workflow (id),
  stages jsonb NOT NULL,                           -- the workflow's stages as they were when the review started
  stage int NOT NULL DEFAULT 0,                    -- the current stage (0-based)
  status text NOT NULL DEFAULT 'in_review'
    CHECK (status IN ('in_review', 'approved', 'returned', 'rejected', 'withdrawn')),
  with_comments boolean NOT NULL DEFAULT false,
  resubmits uuid REFERENCES dms.review (id),
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid NOT NULL REFERENCES platform."user" (id),
  closed_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  FOREIGN KEY (document_id, version_no) REFERENCES doc.document_version (document_id, version_no)
);
CREATE INDEX review_document ON dms.review (document_id);
SELECT platform.secure_table('dms.review');
REVOKE DELETE, TRUNCATE ON dms.review FROM aerolith_app;

CREATE TABLE dms.review_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES dms.review (id),
  stage int NOT NULL,
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'done', 'skipped')),
  code text REFERENCES dms.status_code (code),
  comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 4000),
  responded_at timestamptz,
  UNIQUE (review_id, stage, user_id),
  CHECK ((status = 'done') = (code IS NOT NULL))
);
CREATE INDEX review_task_user ON dms.review_task (user_id) WHERE status = 'waiting';
SELECT platform.secure_table('dms.review_task');
REVOKE DELETE, TRUNCATE ON dms.review_task FROM aerolith_app;
