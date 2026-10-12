-- Wave 3 step 11 (docs/wave3-plan.md): HR. Designations (with extra permissions, and as approvers), employees with
-- their statutory numbers (Aadhaar only as its last four digits, with consent: the DPDP Act), holiday calendars,
-- deployment to sites, attendance by day, leave types, balances and applications.
CREATE SCHEMA hr;
GRANT USAGE ON SCHEMA hr TO aerolith_app;

CREATE TABLE hr.designation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX designation_name ON hr.designation (lower(name));
SELECT platform.secure_table('hr.designation');
REVOKE DELETE, TRUNCATE ON hr.designation FROM aerolith_app;

-- What a designation adds to its holders' role (never takes away).
CREATE TABLE hr.designation_permission (
  designation_id uuid NOT NULL REFERENCES hr.designation (id),
  permission text NOT NULL CHECK (permission ~ '^[a-z]+\.[a-z_]+$'),
  PRIMARY KEY (designation_id, permission)
);
SELECT platform.secure_table('hr.designation_permission');

CREATE TABLE hr.calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
  -- Working weekdays as bits, Monday = 1, Tuesday = 2 … Sunday = 64 (as the programme's calendars).
  work_week smallint NOT NULL DEFAULT 63 CHECK (work_week BETWEEN 1 AND 127),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE UNIQUE INDEX calendar_name ON hr.calendar (entity_id, lower(name));
CREATE UNIQUE INDEX calendar_one_default ON hr.calendar (entity_id) WHERE is_default;
SELECT platform.secure_table('hr.calendar');
REVOKE DELETE, TRUNCATE ON hr.calendar FROM aerolith_app;

CREATE TABLE hr.holiday (
  calendar_id uuid NOT NULL REFERENCES hr.calendar (id),
  day date NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
  PRIMARY KEY (calendar_id, day)
);
SELECT platform.secure_table('hr.holiday');

-- A site may follow another calendar than its company's default, and has a place for the phone's attendance.
ALTER TABLE proj.site
  ADD COLUMN calendar_id uuid REFERENCES hr.calendar (id),
  ADD COLUMN latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN radius_m int CHECK (radius_m BETWEEN 20 AND 5000),
  ADD CONSTRAINT site_location CHECK ((latitude IS NULL) = (longitude IS NULL)
    AND (radius_m IS NULL OR latitude IS NOT NULL));

CREATE TABLE hr.employee (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9./-]{0,19}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  kind text NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff', 'worker')),
  gender text CHECK (gender IN ('female', 'male', 'other')),
  birth_date date,
  phone text CHECK (phone IS NULL OR phone ~ '^[0-9+ -]{6,20}$'),
  email text CHECK (email IS NULL OR length(email) <= 200),
  address text CHECK (address IS NULL OR length(address) <= 1000),
  joined_on date NOT NULL,
  left_on date,
  grade text NOT NULL DEFAULT '' CHECK (length(grade) <= 40),
  designation_id uuid REFERENCES hr.designation (id),
  department text NOT NULL DEFAULT '' CHECK (length(department) <= 100),
  manager_id uuid REFERENCES hr.employee (id),
  user_id uuid UNIQUE REFERENCES platform."user" (id),
  pan text CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  uan text CHECK (uan ~ '^[0-9]{12}$'),
  esi_number text CHECK (esi_number ~ '^[0-9]{10,17}$'),
  -- The DPDP Act: never the full Aadhaar number; its last four digits, and only with the date of consent.
  aadhaar_last4 text CHECK (aadhaar_last4 ~ '^[0-9]{4}$'),
  aadhaar_consent_on date,
  bank_account text CHECK (bank_account ~ '^[0-9]{6,18}$'),
  bank_ifsc text CHECK (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text NOT NULL DEFAULT '' CHECK (length(bank_name) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (aadhaar_last4 IS NULL OR aadhaar_consent_on IS NOT NULL),
  CHECK (left_on IS NULL OR left_on >= joined_on),
  CHECK (manager_id IS NULL OR manager_id <> id)
);
CREATE UNIQUE INDEX employee_code ON hr.employee (lower(code));
CREATE INDEX employee_entity ON hr.employee (entity_id, code);
CREATE INDEX employee_designation ON hr.employee (designation_id);
SELECT platform.secure_table('hr.employee');
REVOKE DELETE, TRUNCATE ON hr.employee FROM aerolith_app;

-- Where an employee works from a date: a project and site, or the head office (both null). Never changed.
CREATE TABLE hr.deployment (
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  from_date date NOT NULL,
  project_id uuid REFERENCES proj.project (id),
  site_id uuid REFERENCES proj.site (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (employee_id, from_date),
  CHECK (site_id IS NULL OR project_id IS NOT NULL)
);
CREATE INDEX deployment_site ON hr.deployment (site_id, from_date);
SELECT platform.secure_table('hr.deployment');
REVOKE UPDATE, DELETE, TRUNCATE ON hr.deployment FROM aerolith_app;

-- One row a day per employee. A day with no row is absent, a holiday, a weekly off or on leave (worked out).
CREATE TABLE hr.attendance (
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'half_day', 'absent', 'on_duty')),
  in_at timestamptz,
  out_at timestamptz,
  project_id uuid REFERENCES proj.project (id),
  site_id uuid REFERENCES proj.site (id),
  source text NOT NULL CHECK (source IN ('register', 'biometric', 'phone')),
  flag text CHECK (flag IN ('single_punch', 'outside_site', 'no_site_location')),
  latitude numeric(9,6),
  longitude numeric(9,6),
  distance_m int,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (employee_id, day),
  CHECK (out_at IS NULL OR in_at IS NULL OR out_at >= in_at)
);
CREATE INDEX attendance_site ON hr.attendance (site_id, day);
SELECT platform.secure_table('hr.attendance');
REVOKE TRUNCATE ON hr.attendance FROM aerolith_app;

CREATE TABLE hr.leave_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code ~ '^[A-Z]{1,6}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 60),
  paid boolean NOT NULL DEFAULT true,
  days_per_year numeric(5,1) NOT NULL DEFAULT 0 CHECK (days_per_year BETWEEN 0 AND 366),
  accrual text NOT NULL DEFAULT 'annual' CHECK (accrual IN ('annual', 'monthly')),
  carry_forward_max numeric(5,1) NOT NULL DEFAULT 0 CHECK (carry_forward_max >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE UNIQUE INDEX leave_type_code ON hr.leave_type (code);
SELECT platform.secure_table('hr.leave_type');
REVOKE DELETE, TRUNCATE ON hr.leave_type FROM aerolith_app;

-- A leave year's opening balance: typed at the start, or carried forward from the year before.
CREATE TABLE hr.leave_opening (
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  leave_type_id uuid NOT NULL REFERENCES hr.leave_type (id),
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  days numeric(5,1) NOT NULL CHECK (days >= 0),
  carried boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (employee_id, leave_type_id, year)
);
SELECT platform.secure_table('hr.leave_opening');

CREATE TABLE hr.leave_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES hr.employee (id),
  leave_type_id uuid NOT NULL REFERENCES hr.leave_type (id),
  from_date date NOT NULL,
  to_date date NOT NULL,
  half_day boolean NOT NULL DEFAULT false,
  days numeric(5,1) NOT NULL CHECK (days > 0),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled')),
  applied_by uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  CHECK (to_date >= from_date AND extract(year FROM from_date) = extract(year FROM to_date)),
  CHECK (NOT half_day OR from_date = to_date)
);
CREATE INDEX leave_application_employee ON hr.leave_application (employee_id, from_date);
SELECT platform.secure_table('hr.leave_application');
REVOKE DELETE, TRUNCATE ON hr.leave_application FROM aerolith_app;

-- Approval rules may name a designation: any active user whose employee record holds it.
ALTER TABLE platform.approval_rule
  DROP CONSTRAINT approval_rule_approver_check,
  DROP CONSTRAINT approval_rule_check,
  ADD COLUMN designation_id uuid REFERENCES hr.designation (id),
  ADD CONSTRAINT approval_rule_approver_check
    CHECK (approver IN ('project_lead', 'manager', 'admin', 'user', 'designation')),
  ADD CONSTRAINT approval_rule_check CHECK ((approver = 'user') = (user_id IS NOT NULL)
    AND (approver = 'designation') = (designation_id IS NOT NULL));
ALTER TABLE platform.approval_step
  DROP CONSTRAINT approval_step_approver_check,
  ADD COLUMN designation_id uuid REFERENCES hr.designation (id),
  ADD CONSTRAINT approval_step_approver_check
    CHECK (approver IN ('project_lead', 'manager', 'admin', 'user', 'designation'));
