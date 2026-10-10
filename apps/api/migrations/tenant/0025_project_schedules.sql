-- Wave 2a step 4: project schedules (docs/04-features.md J4, docs/wave2a-plan.md). The tender programme's engine and
-- tables, for a project's plans: activities on the project's WBS, progress as of a data date (actual start and finish,
-- remaining duration), baselines to compare against, and resources assigned to activities.

ALTER TABLE sched.plan DROP CONSTRAINT plan_kind_check;
ALTER TABLE sched.plan ADD CONSTRAINT plan_kind_check CHECK (kind IN ('tender_programme', 'project_schedule'));
ALTER TABLE sched.plan
  ALTER COLUMN tender_id DROP NOT NULL,
  ADD COLUMN project_id uuid REFERENCES proj.project (id),
  -- Progress is as of this day: what is not done is scheduled from it. Null: the plan's start.
  ADD COLUMN data_date date,
  -- The baseline shown against the plan (FK below).
  ADD COLUMN baseline_id uuid;
ALTER TABLE sched.plan ADD CONSTRAINT plan_owner CHECK (
  (kind = 'tender_programme' AND tender_id IS NOT NULL AND project_id IS NULL)
  OR (kind = 'project_schedule' AND project_id IS NOT NULL AND tender_id IS NULL));
CREATE INDEX plan_project ON sched.plan (project_id) WHERE project_id IS NOT NULL;

-- Constant defaults or none: metadata-only on the partitions.
ALTER TABLE sched.activity
  ADD COLUMN wbs_id uuid REFERENCES proj.wbs (id),
  ADD COLUMN actual_start date,
  ADD COLUMN actual_finish date,
  -- Reported working days left (started, not finished); null: duration less the working days since the start.
  ADD COLUMN remaining int CHECK (remaining IS NULL OR remaining BETWEEN 0 AND 36500),
  -- Computed: working days still to do, and not started / in progress / finished.
  ADD COLUMN remaining_left int,
  ADD COLUMN status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'finished')),
  ADD CONSTRAINT activity_actuals CHECK (actual_finish IS NULL OR (actual_start IS NOT NULL
    AND actual_finish >= actual_start));
CREATE INDEX activity_wbs ON sched.activity (plan_id, wbs_id) WHERE wbs_id IS NOT NULL;

-- A baseline: the plan's dates frozen on a day, to measure slippage against. Kept for good (a record).
CREATE TABLE sched.baseline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES sched.plan (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  data_date date NOT NULL,
  finish_on date,
  activity_count int NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  taken_by uuid REFERENCES platform."user" (id)
);
CREATE UNIQUE INDEX baseline_name ON sched.baseline (plan_id, lower(name));
SELECT platform.secure_table('sched.baseline');
REVOKE UPDATE, DELETE, TRUNCATE ON sched.baseline FROM aerolith_app;
ALTER TABLE sched.plan ADD FOREIGN KEY (baseline_id) REFERENCES sched.baseline (id);

CREATE TABLE sched.baseline_activity (
  plan_id uuid NOT NULL,
  baseline_id uuid NOT NULL,
  activity_id bigint NOT NULL,                 -- the activity then (it may since have been deleted)
  start_on date,
  finish_on date,
  duration int NOT NULL,
  PRIMARY KEY (plan_id, baseline_id, activity_id)
) PARTITION BY HASH (plan_id);

-- Resources (the rate library's) an activity needs, per working day.
CREATE TABLE sched.assignment (
  plan_id uuid NOT NULL,
  activity_id bigint NOT NULL,
  resource_id uuid NOT NULL REFERENCES est.resource (id),
  units_per_day numeric(14,4) NOT NULL CHECK (units_per_day > 0),
  PRIMARY KEY (plan_id, activity_id, resource_id),
  FOREIGN KEY (plan_id, activity_id) REFERENCES sched.activity (plan_id, id) ON DELETE CASCADE
) PARTITION BY HASH (plan_id);
CREATE INDEX assignment_resource ON sched.assignment (plan_id, resource_id);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format('CREATE TABLE sched.baseline_activity_p%s PARTITION OF sched.baseline_activity FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    EXECUTE format('CREATE TABLE sched.assignment_p%s PARTITION OF sched.assignment FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    PERFORM platform.secure_table(format('sched.baseline_activity_p%s', i)::regclass);
    PERFORM platform.secure_table(format('sched.assignment_p%s', i)::regclass);
  END LOOP;
END $$;
SELECT platform.secure_table('sched.baseline_activity');
SELECT platform.secure_table('sched.assignment');
REVOKE UPDATE, DELETE, TRUNCATE ON sched.baseline_activity FROM aerolith_app;
