-- Wave 4 step 4 (docs/wave4-plan.md): variations and change orders. Requested, priced (new items and changed
-- quantities), approved inside the company and by the client, then carried into the contract BOQ and its budget
-- (keyed together) and the schedule.
CREATE TABLE ctl.variation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  source text NOT NULL CHECK (source IN ('client_instruction', 'site_condition', 'design_change', 'other')),
  instruction_ref text NOT NULL DEFAULT '' CHECK (length(instruction_ref) <= 200),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 4000),
  contract_boq_id uuid NOT NULL REFERENCES est.boq (id),
  days int NOT NULL DEFAULT 0 CHECK (days BETWEEN 0 AND 3650),
  activities jsonb NOT NULL DEFAULT '[]',          -- [{planId, activityId}] extended by `days` on approval
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'submitted', 'approved', 'rejected', 'withdrawn')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 2000),
  started_on date,                                 -- work begun on site (whatever the approval)
  applied boolean NOT NULL DEFAULT false,          -- its lines are in the contract BOQ and budget
  value numeric(20,2) NOT NULL DEFAULT 0,          -- contract value as priced
  cost numeric(20,2) NOT NULL DEFAULT 0,
  client_ref text,
  client_on date,
  approved_value numeric(20,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number)
);
CREATE INDEX variation_project ON ctl.variation (project_id, status);
SELECT platform.secure_table('ctl.variation');
REVOKE DELETE, TRUNCATE ON ctl.variation FROM aerolith_app;

CREATE TABLE ctl.variation_line (
  variation_id uuid NOT NULL REFERENCES ctl.variation (id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position > 0),
  kind text NOT NULL CHECK (kind IN ('new', 'change')),
  line_key uuid NOT NULL,                          -- a new item's key (made here), or the changed contract line's
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  unit text NOT NULL DEFAULT '' CHECK (length(unit) <= 20),
  qty numeric(20,4) NOT NULL,                      -- a new item's quantity, or the change (+/−)
  rate numeric(20,4) NOT NULL CHECK (rate >= 0),   -- contract rate
  cost_rate numeric(20,4) NOT NULL CHECK (cost_rate >= 0),
  rate_analysis_id uuid REFERENCES est.rate_analysis (id),
  approved_qty numeric(20,4),                      -- as the client approved it
  approved_rate numeric(20,4),
  PRIMARY KEY (variation_id, position)
);
SELECT platform.secure_table('ctl.variation_line');

-- Contracts that let variations be billed while the client's approval is pending.
CREATE TABLE ctl.variation_settings (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  bill_pending boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('ctl.variation_settings');
