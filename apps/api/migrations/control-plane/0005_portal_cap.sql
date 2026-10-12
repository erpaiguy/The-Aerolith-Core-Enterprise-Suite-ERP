-- Wave 6 step 5 (docs/wave6-plan.md): portal users (vendors, subcontractors, clients) are free and never seats, but
-- each tenant has a fair-use cap per kind, raised by the operator.
ALTER TABLE core.licence ADD COLUMN portal_cap int NOT NULL DEFAULT 50 CHECK (portal_cap BETWEEN 0 AND 100000);
ALTER TABLE core.licence_event DROP CONSTRAINT licence_event_kind_check;
ALTER TABLE core.licence_event ADD CONSTRAINT licence_event_kind_check CHECK (kind IN ('issued', 'emailed', 'resent',
  'activated', 'device_revoked', 'rotated', 'revoked', 'extended', 'shortened', 'seats_changed', 'portal_cap_changed'));
