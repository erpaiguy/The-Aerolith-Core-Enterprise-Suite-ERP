-- Letterhead (docs/wave7-plan.md step 7b.1): what each company's printed documents carry at the top and the foot:
-- its contact lines, a footer, the person who signs for it, and its logo (PNG or JPEG, small enough to print sharp).
ALTER TABLE platform.entity
  ADD COLUMN phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 60),
  ADD COLUMN email text NOT NULL DEFAULT '' CHECK (length(email) <= 120),
  ADD COLUMN website text NOT NULL DEFAULT '' CHECK (length(website) <= 120),
  ADD COLUMN letter_footer text NOT NULL DEFAULT '' CHECK (length(letter_footer) <= 500),
  ADD COLUMN signatory_name text NOT NULL DEFAULT '' CHECK (length(signatory_name) <= 120),
  ADD COLUMN signatory_title text NOT NULL DEFAULT '' CHECK (length(signatory_title) <= 120);

CREATE TABLE platform.entity_logo (
  entity_id uuid PRIMARY KEY REFERENCES platform.entity (id),
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 307200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('platform.entity_logo');
