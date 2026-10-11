-- Wave 2b step 7 (docs/wave2b-plan.md): daily site reports. One per site per day, built up through the day from a
-- phone, submitted by the site, acknowledged by the project's lead; a submitted report changes only by a correction
-- with a reason. Materials received and issued that day are read from the receipts and issue slips, not typed again.

CREATE TABLE proj.daily_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proj.project (id),
  site_id uuid NOT NULL REFERENCES proj.site (id),
  report_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'acknowledged')),
  weather_am text CHECK (weather_am IN ('clear', 'cloudy', 'rain', 'heavy_rain', 'storm')),
  weather_pm text CHECK (weather_pm IN ('clear', 'cloudy', 'rain', 'heavy_rain', 'storm')),
  rain_hours numeric(4,1) CHECK (rain_hours IS NULL OR rain_hours BETWEEN 0 AND 24),
  safety text NOT NULL DEFAULT '' CHECK (length(safety) <= 4000),
  visitors text NOT NULL DEFAULT '' CHECK (length(visitors) <= 2000),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 8000),
  submitted_at timestamptz,
  submitted_by uuid REFERENCES platform."user" (id),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (site_id, report_date)
);
CREATE INDEX daily_report_project ON proj.daily_report (project_id, report_date DESC);
SELECT platform.secure_table('proj.daily_report');
REVOKE DELETE, TRUNCATE ON proj.daily_report FROM aerolith_app;

-- Who worked: by trade, own or a labour contractor's.
CREATE TABLE proj.dr_manpower (
  report_id uuid NOT NULL REFERENCES proj.daily_report (id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position > 0),
  trade text NOT NULL CHECK (length(trim(trade)) BETWEEN 1 AND 100),
  party_id uuid REFERENCES platform.party (id),        -- the labour contractor; none for our own
  headcount int NOT NULL CHECK (headcount BETWEEN 1 AND 10000),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  PRIMARY KEY (report_id, position)
);
SELECT platform.secure_table('proj.dr_manpower');

-- Plant and equipment on site: hours worked, and idle with why.
CREATE TABLE proj.dr_equipment (
  report_id uuid NOT NULL REFERENCES proj.daily_report (id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position > 0),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  ownership text NOT NULL CHECK (ownership IN ('own', 'hired')),
  count int NOT NULL DEFAULT 1 CHECK (count BETWEEN 1 AND 1000),
  hours_worked numeric(6,1) NOT NULL DEFAULT 0 CHECK (hours_worked >= 0),
  hours_idle numeric(6,1) NOT NULL DEFAULT 0 CHECK (hours_idle >= 0),
  idle_reason text NOT NULL DEFAULT '' CHECK (length(idle_reason) <= 500),
  PRIMARY KEY (report_id, position)
);
SELECT platform.secure_table('proj.dr_equipment');

-- Work done today, as the site claims it (the measurement book stays what is billed).
CREATE TABLE proj.dr_work (
  report_id uuid NOT NULL REFERENCES proj.daily_report (id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position > 0),
  line_key uuid,                                       -- the contract BOQ item, if given
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1000),
  qty numeric(20,4) CHECK (qty IS NULL OR qty >= 0),
  unit text NOT NULL DEFAULT '' CHECK (length(unit) <= 20),
  PRIMARY KEY (report_id, position)
);
SELECT platform.secure_table('proj.dr_work');

-- Hindrances: what held work up, for how long, and on whose account (the evidence for extensions of time later).
CREATE TABLE proj.dr_hindrance (
  report_id uuid NOT NULL REFERENCES proj.daily_report (id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position > 0),
  cause text NOT NULL CHECK (cause IN ('rain', 'drawings', 'client_decision', 'materials', 'labour', 'equipment',
    'power_water', 'site_access', 'other')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1000),
  hours numeric(4,1) NOT NULL CHECK (hours > 0 AND hours <= 24),
  account text NOT NULL CHECK (account IN ('client', 'contractor', 'neutral')),
  PRIMARY KEY (report_id, position)
);
SELECT platform.secure_table('proj.dr_hindrance');

-- Photos, kept in the tenant's file store (the documents' one) by their content hash. Removed from a draft report
-- by hiding; the file is kept.
CREATE TABLE proj.dr_photo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES proj.daily_report (id),
  storage_key text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes int NOT NULL CHECK (size_bytes > 0),
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 300),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX dr_photo_report ON proj.dr_photo (report_id, created_at);
CREATE INDEX dr_photo_key ON proj.dr_photo (storage_key);
SELECT platform.secure_table('proj.dr_photo');
REVOKE DELETE, TRUNCATE ON proj.dr_photo FROM aerolith_app;

-- What happened to the report: submitted, acknowledged, corrected (with why).
CREATE TABLE proj.dr_event (
  id bigserial PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES proj.daily_report (id),
  kind text NOT NULL CHECK (kind IN ('submitted', 'acknowledged', 'corrected')),
  comment text CHECK (comment IS NULL OR length(comment) <= 2000),
  actor_id uuid REFERENCES platform."user" (id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dr_event_report ON proj.dr_event (report_id, id);
SELECT platform.secure_table('proj.dr_event');
REVOKE UPDATE, DELETE, TRUNCATE ON proj.dr_event FROM aerolith_app;
