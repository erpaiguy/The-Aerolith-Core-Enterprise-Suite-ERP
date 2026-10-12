-- Wave 5 step 2 (docs/wave5-plan.md): mark-up and comments on a document version. A comment numbered per version,
-- on a page with an optional highlight box (fractions of the page), maybe part of a review; replies in order; resolved.
CREATE TABLE dms.markup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  version_no int NOT NULL,
  number int NOT NULL,
  review_id uuid REFERENCES dms.review (id),
  page int NOT NULL CHECK (page BETWEEN 0 AND 100000),  -- 0: the document as a whole
  -- The box as fractions of the page: left, top, width, height.
  x numeric(6, 5), y numeric(6, 5), w numeric(6, 5), h numeric(6, 5),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  author_id uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by uuid REFERENCES platform."user" (id),
  resolved_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (document_id, version_no, number),
  FOREIGN KEY (document_id, version_no) REFERENCES doc.document_version (document_id, version_no),
  CHECK ((x IS NULL) = (y IS NULL) AND (x IS NULL) = (w IS NULL) AND (x IS NULL) = (h IS NULL)),
  CHECK (x IS NULL OR (page > 0 AND x >= 0 AND y >= 0 AND w > 0 AND h > 0 AND x + w <= 1 AND y + h <= 1)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX markup_review ON dms.markup (review_id) WHERE review_id IS NOT NULL;
SELECT platform.secure_table('dms.markup');
REVOKE DELETE, TRUNCATE ON dms.markup FROM aerolith_app;

CREATE TABLE dms.markup_reply (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  markup_id uuid NOT NULL REFERENCES dms.markup (id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  author_id uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX markup_reply_markup ON dms.markup_reply (markup_id, created_at);
SELECT platform.secure_table('dms.markup_reply');
REVOKE DELETE, TRUNCATE ON dms.markup_reply FROM aerolith_app;
