-- The daily reminder digest (docs/wave8-plan.md step 8g.3): one email a morning per person with what is overdue,
-- due this week, waiting on them, and expiring. Staff give their own address and may turn it off.
ALTER TABLE platform."user"
  ADD COLUMN email text CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  ADD COLUMN digest_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN digest_sent_on date;
