-- Wave 2a step 2: a project's BOQs (docs/04-features.md J2, docs/wave2a-plan.md). A BOQ belongs to a tender (the
-- estimate) or to a project (its contract BOQ, at the rates the client pays, or its budget, at what the work should
-- cost us). Project BOQs are ordinary BOQs: the grid, import and export, versions and bulk edit work on them as they
-- are; bid pricing and RFQs stay with tenders.

ALTER TABLE est.boq ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE est.boq
  ADD COLUMN project_id uuid REFERENCES proj.project (id),
  ADD COLUMN kind text NOT NULL DEFAULT 'estimate' CHECK (kind IN ('estimate', 'contract', 'budget')),
  -- Copied from this tender BOQ, at this version (its submitted one).
  ADD COLUMN source_boq_id uuid REFERENCES est.boq (id),
  ADD COLUMN source_version_no int,
  -- How the copied rates were set: {"factor": the bid's markup factor, "scale": to meet the contract value}.
  ADD COLUMN rate_basis jsonb;
ALTER TABLE est.boq ADD CONSTRAINT boq_one_owner CHECK ((tender_id IS NULL) <> (project_id IS NULL));
ALTER TABLE est.boq ADD CONSTRAINT boq_kind_owner CHECK ((kind = 'estimate') = (tender_id IS NOT NULL));
CREATE INDEX boq_project ON est.boq (project_id) WHERE project_id IS NOT NULL;
-- A tender BOQ becomes one contract BOQ and one budget per project, not two of either.
CREATE UNIQUE INDEX boq_from_source ON est.boq (project_id, kind, source_boq_id) WHERE source_boq_id IS NOT NULL;

-- Copying a won tender's BOQs into the project runs in the background: a million-line BOQ takes minutes to write (its
-- search indexes are most of it). One transaction, so a copy is all or nothing; this row says how it went.
CREATE TABLE proj.boq_copy (
  project_id uuid PRIMARY KEY REFERENCES proj.project (id),
  status text NOT NULL CHECK (status IN ('copying', 'done', 'failed')),
  match_contract_value boolean NOT NULL,
  result jsonb,                            -- the scale used, totals, residual, the BOQs made
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid REFERENCES platform."user" (id),
  finished_at timestamptz
);
SELECT platform.secure_table('proj.boq_copy');
