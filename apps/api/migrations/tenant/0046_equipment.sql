-- Wave 3 step 10 (docs/wave3-plan.md): equipment and fleet. The register (own or hired), allocation to projects,
-- daily log sheets, fuel issued against a machine, maintenance plans and records, and the month's costing.
CREATE SCHEMA eqp;
GRANT USAGE ON SCHEMA eqp TO aerolith_app;

-- Ledgers for the month's costing (skipped where a tenant already used the code or name): own machines charged to
-- projects and recovered (hired machines go to the seeded "Equipment hire").
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key, needs_project)
SELECT g.id, false, g.nature, x.code, x.name, 'ordinary', x.key, x.needs
FROM acc.account g, (VALUES
  ('X3005', 'Equipment charges', 'equipment_charges', true),
  ('X3006', 'Equipment recovered', 'equipment_recovery', false)
) AS x(code, name, key, needs)
WHERE g.system_key = 'site_expenses'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = lower(x.code) OR lower(a.name) = lower(x.name));

CREATE TABLE eqp.equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9./-]{0,29}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  category text NOT NULL CHECK (category IN ('excavator', 'crane', 'mixer', 'vehicle', 'pump', 'other')),
  meter text NOT NULL DEFAULT 'hours' CHECK (meter IN ('hours', 'km')),
  ownership text NOT NULL CHECK (ownership IN ('own', 'hired')),
  asset_id uuid UNIQUE REFERENCES acc.asset (id),
  internal_rate numeric(20,2),                         -- own: charged to projects per hour (or km)
  party_id uuid REFERENCES platform.party (id),        -- hired: the supplier
  hire_basis text CHECK (hire_basis IN ('hour', 'day', 'month')),
  hire_rate numeric(20,2),
  min_hours numeric(8,1) NOT NULL DEFAULT 0 CHECK (min_hours >= 0),   -- hired by the hour: a month's minimum
  operator_by text NOT NULL DEFAULT 'own' CHECK (operator_by IN ('own', 'hirer')),
  fuel_by text NOT NULL DEFAULT 'own' CHECK (fuel_by IN ('own', 'hirer')),
  fuel_norm numeric(8,2) CHECK (fuel_norm IS NULL OR fuel_norm > 0),  -- litres per hour (or per km)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (ownership = 'own' OR (party_id IS NOT NULL AND hire_basis IS NOT NULL AND hire_rate IS NOT NULL)),
  CHECK (ownership = 'hired' OR asset_id IS NULL OR party_id IS NULL)
);
SELECT platform.secure_table('eqp.equipment');
REVOKE DELETE, TRUNCATE ON eqp.equipment FROM aerolith_app;

-- Where a machine is, from a date.
CREATE TABLE eqp.allocation (
  equipment_id uuid NOT NULL REFERENCES eqp.equipment (id),
  from_date date NOT NULL,
  project_id uuid REFERENCES proj.project (id),        -- null: idle in the yard
  site_id uuid REFERENCES proj.site (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (equipment_id, from_date)
);
SELECT platform.secure_table('eqp.allocation');
REVOKE UPDATE, DELETE, TRUNCATE ON eqp.allocation FROM aerolith_app;

CREATE TABLE eqp.log (
  equipment_id uuid NOT NULL REFERENCES eqp.equipment (id),
  log_date date NOT NULL,
  project_id uuid REFERENCES proj.project (id),
  site_id uuid REFERENCES proj.site (id),
  start_reading numeric(12,1),
  end_reading numeric(12,1),
  worked numeric(8,1) NOT NULL DEFAULT 0 CHECK (worked >= 0),        -- hours (or km)
  idle_hours numeric(6,1) NOT NULL DEFAULT 0 CHECK (idle_hours >= 0),
  idle_reason text NOT NULL DEFAULT '' CHECK (length(idle_reason) <= 300),
  breakdown_hours numeric(6,1) NOT NULL DEFAULT 0 CHECK (breakdown_hours >= 0),
  operator text NOT NULL DEFAULT '' CHECK (length(operator) <= 120),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (equipment_id, log_date),
  CHECK (end_reading IS NULL OR start_reading IS NULL OR end_reading >= start_reading)
);
CREATE INDEX log_site ON eqp.log (site_id, log_date);
SELECT platform.secure_table('eqp.log');
REVOKE TRUNCATE ON eqp.log FROM aerolith_app;

-- Fuel (and spares) issued from stores against a machine.
ALTER TABLE proc.stock_issue ADD COLUMN equipment_id uuid REFERENCES eqp.equipment (id);

CREATE TABLE eqp.maintenance_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES eqp.equipment (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  every_hours numeric(8,1) CHECK (every_hours IS NULL OR every_hours > 0),
  every_days int CHECK (every_days IS NULL OR every_days > 0),
  from_date date NOT NULL,
  from_reading numeric(12,1) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK (every_hours IS NOT NULL OR every_days IS NOT NULL)
);
SELECT platform.secure_table('eqp.maintenance_plan');
REVOKE TRUNCATE ON eqp.maintenance_plan FROM aerolith_app;

CREATE TABLE eqp.maintenance_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES eqp.equipment (id),
  plan_id uuid REFERENCES eqp.maintenance_plan (id),
  kind text NOT NULL CHECK (kind IN ('service', 'breakdown')),
  done_on date NOT NULL,
  reading numeric(12,1),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 1000),
  downtime_hours numeric(8,1) NOT NULL DEFAULT 0 CHECK (downtime_hours >= 0),
  cost numeric(20,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('eqp.maintenance_record');
REVOKE UPDATE, DELETE, TRUNCATE ON eqp.maintenance_record FROM aerolith_app;

-- The month's costing, once a month per company: own machines' internal charge (a voucher) and the hire bills made.
CREATE TABLE eqp.costing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  voucher_id uuid REFERENCES acc.voucher (id),
  internal_total numeric(20,2) NOT NULL DEFAULT 0,
  hire_bills jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (entity_id, month)
);
SELECT platform.secure_table('eqp.costing');
REVOKE UPDATE, DELETE, TRUNCATE ON eqp.costing FROM aerolith_app;
