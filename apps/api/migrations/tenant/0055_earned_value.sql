-- Wave 4 step 3 (docs/wave4-plan.md): earned value. Computed from the schedule, the measurement book, the budget and
-- the ledger; only the project's chosen estimate-at-completion method is stored.
CREATE TABLE ctl.ev_settings (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  method text NOT NULL DEFAULT 'cpi' CHECK (method IN ('cpi', 'budget_rate', 'cpi_spi', 'bottom_up')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('ctl.ev_settings');
