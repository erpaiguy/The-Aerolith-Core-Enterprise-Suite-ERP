-- MSME suppliers (docs/wave8-plan.md step 8b.4): the Udyam registration and type on the party, from which payables
-- warns of bills nearing 45 days (MSMED Act section 15), the year-end section 43B(h) report of what was not paid in
-- time, and the half-yearly MSME-1 data.
ALTER TABLE platform.party
  ADD COLUMN udyam_no text CHECK (udyam_no ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'),
  ADD COLUMN msme_type text CHECK (msme_type IN ('micro', 'small', 'medium'));
