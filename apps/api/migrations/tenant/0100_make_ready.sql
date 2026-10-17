-- Look-ahead with constraints (docs/wave8-plan.md step 8d.2): a make-ready log per activity (drawings, material, the
-- work front, approvals, labour, equipment), each with its owner and date and cleared when met; the weekly work plan
-- of what the site commits to from the look-ahead; and, once the week is over, what was done, the percent plan
-- complete (PPC) and the reasons for each miss.
CREATE TABLE sched.constraint_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES sched.plan (id),
  activity_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('drawings', 'material', 'front', 'approvals', 'labour', 'equipment', 'other')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 500),
  owner_id uuid REFERENCES platform."user" (id),
  due_on date NOT NULL,
  cleared_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  FOREIGN KEY (plan_id, activity_id) REFERENCES sched.activity (plan_id, id)
);
CREATE INDEX constraint_item_activity ON sched.constraint_item (plan_id, activity_id);
SELECT platform.secure_table('sched.constraint_item');
REVOKE DELETE, TRUNCATE ON sched.constraint_item FROM aerolith_app;

CREATE TABLE sched.weekly_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES sched.plan (id),
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (plan_id, week_start)
);
SELECT platform.secure_table('sched.weekly_plan');
REVOKE DELETE, TRUNCATE ON sched.weekly_plan FROM aerolith_app;

CREATE TABLE sched.commitment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_plan_id uuid NOT NULL REFERENCES sched.weekly_plan (id),
  activity_id bigint,
  what text NOT NULL CHECK (length(trim(what)) BETWEEN 2 AND 300),
  done boolean,
  miss_reason text CHECK (miss_reason IN ('drawings', 'material', 'front', 'approvals', 'labour', 'equipment',
    'weather', 'predecessor', 'other')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  CHECK (done IS NOT FALSE OR miss_reason IS NOT NULL),
  CHECK (done IS NOT TRUE OR miss_reason IS NULL)
);
CREATE INDEX commitment_week ON sched.commitment (weekly_plan_id);
SELECT platform.secure_table('sched.commitment');
