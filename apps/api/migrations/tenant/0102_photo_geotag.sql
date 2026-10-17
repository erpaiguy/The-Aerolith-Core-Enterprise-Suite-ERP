-- Geotagged site photos (docs/wave8-plan.md step 8d.4): when and where a daily report's photo was taken, as the phone
-- gave them. A photo taken without signal waits on the phone and keeps these from the moment it was taken.
ALTER TABLE proj.dr_photo
  ADD COLUMN taken_at timestamptz,
  ADD COLUMN latitude numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN accuracy_m int CHECK (accuracy_m >= 0),
  ADD CHECK ((latitude IS NULL) = (longitude IS NULL));
