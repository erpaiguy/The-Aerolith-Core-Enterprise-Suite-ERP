-- Snags, handover and defect liability (docs/wave8-plan.md step 8d.3). A snag names who answers for it, by when, and
-- what it will be back-charged if they do not put it right (taken onto their next subcontract bill). A unit or area
-- is handed over against a checklist, with no snag open in it, and gets a handover certificate. Defects reported in
-- the defect liability period are logged against the client contract; reminders before the period ends (with the
-- contract) tie the release of retention and the performance guarantee to their being cleared.
ALTER TABLE qa.snag
  ADD COLUMN responsible_party_id uuid REFERENCES platform.party (id),
  ADD COLUMN due_on date,
  ADD COLUMN backcharge numeric(20,2) CHECK (backcharge IS NULL OR backcharge > 0),
  ADD COLUMN backcharged_bill_id uuid REFERENCES acc.subcontract_bill (id);

CREATE TABLE qa.handover (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  number text NOT NULL,
  area text NOT NULL CHECK (length(trim(area)) BETWEEN 1 AND 120),
  handed_to text NOT NULL CHECK (length(trim(handed_to)) BETWEEN 2 AND 200),
  checklist jsonb NOT NULL DEFAULT '[]',               -- [{item, ok, note}]
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'handed_over')),
  handed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (project_id, number),
  CHECK ((status = 'handed_over') = (handed_on IS NOT NULL))
);
SELECT platform.secure_table('qa.handover');
REVOKE DELETE, TRUNCATE ON qa.handover FROM aerolith_app;

CREATE TABLE qa.defect (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  contract_id uuid REFERENCES ctl.contract (id),
  area text NOT NULL CHECK (length(trim(area)) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 1000),
  reported_on date NOT NULL,
  reported_by text NOT NULL DEFAULT '' CHECK (length(reported_by) <= 200),
  responsible_party_id uuid REFERENCES platform.party (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed')),
  fixed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK ((status = 'fixed') = (fixed_on IS NOT NULL))
);
CREATE INDEX defect_project ON qa.defect (project_id, status);
SELECT platform.secure_table('qa.defect');
REVOKE DELETE, TRUNCATE ON qa.defect FROM aerolith_app;
