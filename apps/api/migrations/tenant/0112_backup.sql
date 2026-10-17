-- Backups (docs/wave8-plan.md step 8g.2): the company's schedule, and a record of every backup taken and of the
-- restore check that proved it can be read back. The files themselves are kept on the server's backup volume.
CREATE TABLE platform.backup_setting (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  -- The hour of the day (IST) the nightly backup is taken, and how many are kept.
  hour smallint NOT NULL DEFAULT 2 CHECK (hour BETWEEN 0 AND 23),
  keep smallint NOT NULL DEFAULT 14 CHECK (keep BETWEEN 1 AND 90),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('platform.backup_setting');

CREATE TABLE platform.backup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  taken_by uuid REFERENCES platform."user" (id),
  file_name text,
  bytes bigint,
  sha256 text,
  tables integer,
  row_count bigint,
  error text,
  checked_at timestamptz,
  check_ok boolean,
  check_note text,
  deleted_at timestamptz
);
CREATE INDEX backup_started ON platform.backup (started_at DESC);
SELECT platform.secure_table('platform.backup');
