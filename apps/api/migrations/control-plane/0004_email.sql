-- Email delivery (docs/email.md). Rows in core.email_outbox move queued -> sending -> sent | failed | suppressed.
-- Transient failures stay `queued` with a later next_attempt_at.

ALTER TABLE core.email_outbox
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN sending_started_at timestamptz,
  ADD COLUMN provider_message_id text,
  ADD COLUMN subject text;

DROP INDEX core.email_outbox_queued;
CREATE INDEX email_outbox_due ON core.email_outbox (coalesce(next_attempt_at, created_at)) WHERE status = 'queued';

-- Addresses we must not send to again (hard bounces, complaints, manual blocks).
CREATE TABLE core.email_suppression (
  email text PRIMARY KEY CHECK (email = lower(email)),
  reason text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE core.email_suppression ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aerolith_api') THEN
    CREATE POLICY api_all ON core.email_suppression TO aerolith_api USING (true) WITH CHECK (true);
    GRANT SELECT, INSERT, UPDATE, DELETE ON core.email_suppression TO aerolith_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON core.email_suppression FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON core.email_suppression FROM authenticated;
  END IF;
END $$;
