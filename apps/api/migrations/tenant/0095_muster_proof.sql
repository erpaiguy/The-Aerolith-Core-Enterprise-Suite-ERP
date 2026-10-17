-- A muster you can trust (docs/wave8-plan.md step 8c.2): a muster marked from a phone carries where the phone was,
-- against the site's geofence, and a photo of the gang; marked without signal, it waits in the phone's outbox and is
-- sent once, with its idempotency key, when the signal returns. Away from the site the marks stand but are flagged.
CREATE TABLE lab.muster_proof (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES proj.site (id),
  day date NOT NULL,
  party_id uuid NOT NULL REFERENCES lab.contractor (party_id),
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  distance_m int,
  flag text CHECK (flag IN ('outside_site', 'no_site_location', 'no_location')),
  photo bytea CHECK (photo IS NULL OR octet_length(photo) <= 600000),
  photo_type text CHECK (photo_type IN ('image/jpeg', 'image/png', 'image/webp')),
  workers int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  CHECK ((photo IS NULL) = (photo_type IS NULL)),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX muster_proof_day ON lab.muster_proof (site_id, day, party_id);
SELECT platform.secure_table('lab.muster_proof');
REVOKE UPDATE, DELETE, TRUNCATE ON lab.muster_proof FROM aerolith_app;
