-- Wave 6 step 4 (docs/wave6-plan.md): a phone that lost signal sends its saved forms again with the key it made; the
-- first answer is kept for 7 days and returned to every repeat, so nothing is posted twice.
CREATE TABLE platform.idempotency (
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,80}$'),
  user_id uuid NOT NULL REFERENCES platform."user" (id),
  route text NOT NULL CHECK (length(route) <= 200),
  status int NOT NULL,
  body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_age ON platform.idempotency (created_at);
SELECT platform.secure_table('platform.idempotency');
