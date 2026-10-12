-- Wave 6 step 3 (docs/wave6-plan.md): saved reports (a spec over the reporting model, never SQL), who they are shared
-- with, their schedules, and the Excel files the schedules make, kept for 30 days.
CREATE SCHEMA bi;
GRANT USAGE ON SCHEMA bi TO aerolith_app;

CREATE TABLE bi.report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  spec jsonb NOT NULL,
  chart jsonb NOT NULL DEFAULT '{"kind": "table"}',
  shared_with text NOT NULL DEFAULT 'nobody' CHECK (shared_with IN ('nobody', 'managers', 'everyone')),
  owner_id uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX report_owner ON bi.report (owner_id);
SELECT platform.secure_table('bi.report');

CREATE TABLE bi.schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES bi.report (id) ON DELETE CASCADE,
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  weekday int CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),        -- 1 Monday … 7 Sunday
  monthday int CHECK (monthday IS NULL OR monthday BETWEEN 1 AND 28),
  recipients uuid[] NOT NULL DEFAULT '{}',
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  last_error text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  CHECK ((cadence = 'weekly') = (weekday IS NOT NULL)),
  CHECK ((cadence = 'monthly') = (monthday IS NOT NULL))
);
CREATE INDEX schedule_due ON bi.schedule (next_run_at) WHERE active;
SELECT platform.secure_table('bi.schedule');

CREATE TABLE bi.export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid REFERENCES bi.schedule (id) ON DELETE SET NULL,
  report_id uuid NOT NULL REFERENCES bi.report (id) ON DELETE CASCADE,
  file_name text NOT NULL,
  bytes bytea NOT NULL CHECK (length(bytes) <= 5242880),
  rows int NOT NULL,
  made_at timestamptz NOT NULL DEFAULT now(),
  readers uuid[] NOT NULL
);
CREATE INDEX export_made ON bi.export (made_at);
SELECT platform.secure_table('bi.export');
