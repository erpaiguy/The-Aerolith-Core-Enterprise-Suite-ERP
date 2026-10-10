-- Wave 2a step 5: macro plans (docs/04-features.md J5, docs/wave2a-plan.md). A project's schedules rolled up through
-- its WBS are computed when asked for, not stored; what is new is how activities are grouped besides the WBS: by
-- package (a contract or subcontract package), trade and zone (block, floor, area). Free text, suggested from the
-- values a project already uses. No defaults: metadata-only on every partition.
ALTER TABLE sched.activity
  ADD COLUMN package text CHECK (package IS NULL OR length(trim(package)) BETWEEN 1 AND 60),
  ADD COLUMN trade text CHECK (trade IS NULL OR length(trim(trade)) BETWEEN 1 AND 60),
  ADD COLUMN zone text CHECK (zone IS NULL OR length(trim(zone)) BETWEEN 1 AND 60);
