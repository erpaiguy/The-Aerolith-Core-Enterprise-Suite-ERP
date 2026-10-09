-- Wave 1 step 11: the tender programme (docs/04-features.md E9, docs/05-database.md §6, docs/wave1-plan.md step 11).
-- The `sched` schema is shared with project schedules (Wave 2a); here a plan is always a tender programme, a
-- submission document with no link to any live project. Activities and links are partitioned by plan like BOQ lines,
-- for the 50,000-activity schedules of Wave 2a. Dates are computed by the engine (packages/shared/src/schedule.ts)
-- and stored, so lists and prints read them without recalculating.

CREATE SCHEMA sched;
GRANT USAGE ON SCHEMA sched TO aerolith_app;

CREATE TABLE sched.plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'tender_programme' CHECK (kind IN ('tender_programme')),
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  start_on date NOT NULL,                              -- the data date: nothing starts before it
  calendar_id uuid,                                    -- the default calendar (FK below)
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  -- Computed by the last recalculation.
  finish_on date,
  duration int,                                        -- working days of the default calendar
  activity_count int NOT NULL DEFAULT 0,
  computed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX plan_tender ON sched.plan (tender_id);
SELECT platform.secure_table('sched.plan');

CREATE TABLE sched.calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES sched.plan (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  -- Working weekdays as bits, Monday = 1, Tuesday = 2 … Sunday = 64.
  work_week smallint NOT NULL CHECK (work_week BETWEEN 0 AND 127),
  holidays date[] NOT NULL DEFAULT '{}' CHECK (cardinality(holidays) <= 2000),
  working_days date[] NOT NULL DEFAULT '{}' CHECK (cardinality(working_days) <= 2000),
  UNIQUE (plan_id, name)
);
SELECT platform.secure_table('sched.calendar');
ALTER TABLE sched.plan ADD FOREIGN KEY (calendar_id) REFERENCES sched.calendar (id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE sched.activity (
  plan_id uuid NOT NULL REFERENCES sched.plan (id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  parent_id bigint,                                    -- the summary row it sits under
  pos double precision NOT NULL,                       -- order among its siblings
  kind text NOT NULL CHECK (kind IN ('task', 'milestone', 'summary')),
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(name) <= 500),
  duration int NOT NULL DEFAULT 0 CHECK (duration BETWEEN 0 AND 36500),
  calendar_id uuid REFERENCES sched.calendar (id),      -- null: the plan's
  constraint_type text CHECK (constraint_type IN ('SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO')),
  constraint_date date,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  -- Computed.
  early_start date,
  early_finish date,
  late_start date,
  late_finish date,
  total_float int,
  free_float int,
  critical boolean NOT NULL DEFAULT false,
  row_version int NOT NULL DEFAULT 1,
  PRIMARY KEY (plan_id, id),
  CHECK ((constraint_type IS NULL) = (constraint_date IS NULL))
) PARTITION BY HASH (plan_id);
CREATE UNIQUE INDEX activity_code ON sched.activity (plan_id, lower(code));
CREATE INDEX activity_parent ON sched.activity (plan_id, parent_id);

CREATE TABLE sched.relation (
  plan_id uuid NOT NULL,
  pred_id bigint NOT NULL,
  succ_id bigint NOT NULL,
  type text NOT NULL CHECK (type IN ('FS', 'SS', 'FF', 'SF')),
  lag int NOT NULL DEFAULT 0 CHECK (lag BETWEEN -3650 AND 3650),
  PRIMARY KEY (plan_id, pred_id, succ_id),
  CHECK (pred_id <> succ_id),
  FOREIGN KEY (plan_id, pred_id) REFERENCES sched.activity (plan_id, id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id, succ_id) REFERENCES sched.activity (plan_id, id) ON DELETE CASCADE
) PARTITION BY HASH (plan_id);
CREATE INDEX relation_succ ON sched.relation (plan_id, succ_id);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format('CREATE TABLE sched.activity_p%s PARTITION OF sched.activity FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    EXECUTE format('CREATE TABLE sched.relation_p%s PARTITION OF sched.relation FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    PERFORM platform.secure_table(format('sched.activity_p%s', i)::regclass);
    PERFORM platform.secure_table(format('sched.relation_p%s', i)::regclass);
  END LOOP;
END $$;
SELECT platform.secure_table('sched.activity');
SELECT platform.secure_table('sched.relation');

-- Programmes are archived, not deleted.
REVOKE DELETE, TRUNCATE ON sched.plan FROM aerolith_app;
