-- Wave 9 step 9a.5 (docs/wave9-plan.md): what a person sets up for themselves and expects to find on any device:
-- favourite and recent pages, each grid's columns, widths, frozen columns, density and saved views. Small JSON per
-- key; only the person reads or writes their own.
CREATE TABLE platform.user_pref (
  user_id uuid NOT NULL REFERENCES platform."user" (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'),
  value jsonb NOT NULL CHECK (pg_column_size(value) <= 65536),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
SELECT platform.secure_table('platform.user_pref');
