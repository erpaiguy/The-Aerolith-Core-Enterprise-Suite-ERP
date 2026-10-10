-- Wave 2a step 6: progress measurement (docs/04-features.md J6, docs/wave2a-plan.md). The work done, measured on site
-- against the contract BOQ's items as a measurement book: each entry a quantity on a day (from dimensions or as one
-- figure). Kept by line key per project, like the WBS mapping (step 3), so it outlives revisions of the contract BOQ
-- and values the budget's line too. A book is a record: entries are never changed or deleted; a mistake is put right
-- by an entry that reverses it.
CREATE TABLE proj.measurement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  boq_id uuid NOT NULL REFERENCES est.boq (id),          -- the contract BOQ it was measured in
  line_key uuid NOT NULL,
  measured_on date NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty <> 0),
  -- The dimensions as measured: [{description, nos, length, breadth, height, deduct}], or null for a figure.
  dims jsonb,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  -- A correction: this entry cancels that one (once).
  reverses uuid UNIQUE REFERENCES proj.measurement (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX measurement_line ON proj.measurement (project_id, line_key, measured_on);
CREATE INDEX measurement_day ON proj.measurement (project_id, measured_on);
SELECT platform.secure_table('proj.measurement');
REVOKE UPDATE, DELETE, TRUNCATE ON proj.measurement FROM aerolith_app;

-- The contract BOQ items a schedule activity carries out: its physical progress is theirs.
CREATE TABLE sched.activity_line (
  plan_id uuid NOT NULL,
  activity_id bigint NOT NULL,
  line_key uuid NOT NULL,
  PRIMARY KEY (plan_id, activity_id, line_key),
  FOREIGN KEY (plan_id, activity_id) REFERENCES sched.activity (plan_id, id) ON DELETE CASCADE
) PARTITION BY HASH (plan_id);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format('CREATE TABLE sched.activity_line_p%s PARTITION OF sched.activity_line FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    PERFORM platform.secure_table(format('sched.activity_line_p%s', i)::regclass);
  END LOOP;
END $$;
SELECT platform.secure_table('sched.activity_line');
