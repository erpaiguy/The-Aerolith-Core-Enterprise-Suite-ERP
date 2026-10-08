-- Wave 1 step 4: units master (P10) and BOQ import jobs (P9). docs/wave1-plan.md.

-- Units of measurement. `aliases` are other spellings found in BOQs, so imports can normalise "Cu.M" or "m3" to "cum".
CREATE TABLE platform.unit (
  code text PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 20),
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('platform.unit');

INSERT INTO platform.unit (code, name, aliases) VALUES
  ('cum', 'Cubic metre', '{m3,cu.m,cu m,cu.m.,cmt,cubic metre,cubic meter,m³}'),
  ('sqm', 'Square metre', '{m2,sq.m,sq m,sq.m.,smt,square metre,square meter,m²}'),
  ('rmt', 'Running metre', '{rm,r.m,r.m.,rmtr,running metre,running meter,m,mtr,metre,meter,lm}'),
  ('nos', 'Numbers', '{no,no.,nos.,number,numbers,each,ea,pcs,pc,piece,unit}'),
  ('kg', 'Kilogram', '{kgs,kg.,kilogram,kilograms}'),
  ('MT', 'Metric tonne', '{t,tonne,tonnes,ton,tons,m.t,mt.}'),
  ('qtl', 'Quintal', '{quintal,quintals}'),
  ('ltr', 'Litre', '{l,lit,litre,liter,litres,liters}'),
  ('sqft', 'Square foot', '{sft,sq.ft,sq ft,ft2,square feet}'),
  ('cft', 'Cubic foot', '{cu.ft,cu ft,ft3,cubic feet}'),
  ('rft', 'Running foot', '{r.ft,running feet,running foot}'),
  ('LS', 'Lump sum', '{l.s,l.s.,lumpsum,lump sum,job}'),
  ('set', 'Set', '{sets}'),
  ('pair', 'Pair', '{pairs}'),
  ('bag', 'Bag', '{bags}'),
  ('day', 'Day', '{days}'),
  ('month', 'Month', '{months}'),
  ('hr', 'Hour', '{hour,hours,hrs}');

-- One import of a file into a BOQ. The uploaded file itself stays on the API server's disk (IMPORT_DIR) while the user
-- maps columns and dry-runs, and is deleted when the import ends: staging rows here would need COPY, which Postgres
-- refuses on tables with row-level security, and would double the tenant's database size during a large import.
CREATE TABLE platform.import_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('boq')),
  target_id uuid NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('xlsx', 'csv')),
  file_size bigint NOT NULL,
  status text NOT NULL DEFAULT 'scanning' CHECK (status IN
    ('scanning', 'uploaded', 'validating', 'validated', 'importing', 'imported', 'failed', 'cancelled')),
  sheets jsonb NOT NULL DEFAULT '[]',     -- [{name, rows, columns, preview}]
  settings jsonb,                         -- sheet, header row, column mapping, structure mode
  summary jsonb,                          -- dry-run counts, total and the first issues
  progress int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX import_job_target ON platform.import_job (kind, target_id, created_at DESC);
SELECT platform.secure_table('platform.import_job');
