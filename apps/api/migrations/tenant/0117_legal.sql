-- Wave 9 step 9b.3 (docs/wave9-plan.md): who accepted which version of the legal documents and when, and which
-- versions the company's lawyer has reviewed (until then the pages say they are drafts). Acceptances are never
-- changed or removed: a new version is a new row.
CREATE TABLE platform.legal_acceptance (
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  document text NOT NULL CHECK (document ~ '^[a-z-]{3,40}$'),
  version text NOT NULL CHECK (version ~ '^\d{4}-\d{2}-\d{2}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text CHECK (ip IS NULL OR length(ip) <= 64),
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  PRIMARY KEY (user_id, document, version)
);
SELECT platform.secure_table('platform.legal_acceptance');
-- A record of consent: the app may add to it, never change or remove it.
REVOKE UPDATE, DELETE, TRUNCATE ON platform.legal_acceptance FROM aerolith_app;

CREATE TABLE platform.legal_review (
  document text NOT NULL CHECK (document ~ '^[a-z-]{3,40}$'),
  version text NOT NULL CHECK (version ~ '^\d{4}-\d{2}-\d{2}$'),
  reviewed_by uuid NOT NULL REFERENCES platform."user" (id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR length(note) <= 500),
  PRIMARY KEY (document, version)
);
SELECT platform.secure_table('platform.legal_review');
