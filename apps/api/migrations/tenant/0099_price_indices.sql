-- Price escalation done properly (docs/wave8-plan.md step 8d.1): a master of index series (the Wholesale Price Index,
-- the Consumer Price Index for industrial workers, steel and cement prices) with a value for each month. A bill's
-- escalation takes each component's index as the average of the series over the bill's period. Subcontract work
-- orders take the same escalation terms.
CREATE TABLE acc.price_index (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{2,40}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  source text NOT NULL DEFAULT '' CHECK (length(source) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('acc.price_index');
REVOKE DELETE, TRUNCATE ON acc.price_index FROM aerolith_app;

CREATE TABLE acc.price_index_value (
  series_key text NOT NULL REFERENCES acc.price_index (key),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  value numeric(14,4) NOT NULL CHECK (value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (series_key, month)
);
SELECT platform.secure_table('acc.price_index_value');
REVOKE DELETE, TRUNCATE ON acc.price_index_value FROM aerolith_app;

-- The common series, ready for their values.
INSERT INTO acc.price_index (key, name, source) VALUES
  ('wpi_all', 'WPI: all commodities (2011-12 = 100)', 'Office of the Economic Adviser, DPIIT'),
  ('cpi_iw', 'CPI for industrial workers (2016 = 100)', 'Labour Bureau'),
  ('wpi_steel', 'WPI: mild steel, long products', 'Office of the Economic Adviser, DPIIT'),
  ('wpi_cement', 'WPI: cement (all types)', 'Office of the Economic Adviser, DPIIT'),
  ('wpi_hsd', 'WPI: high speed diesel', 'Office of the Economic Adviser, DPIIT'),
  ('wpi_bitumen', 'WPI: bitumen', 'Office of the Economic Adviser, DPIIT')
ON CONFLICT DO NOTHING;

ALTER TABLE acc.subcontract_terms ADD COLUMN escalation jsonb;
