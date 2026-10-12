-- Wave 6 step 6 (docs/wave6-plan.md): the public API's keys, webhooks with their outbox of deliveries, the Tally
-- agent's record of what reached Tally, and which e-invoice provider each company uses.

-- A key acts as the admin or manager who made it; only the HMAC of its secret is kept.
CREATE TABLE platform.api_key (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  secret_hmac text NOT NULL,
  last4 text NOT NULL,
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['reports:read', 'tally']::text[] AND cardinality(scopes) > 0),
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('platform.api_key');
REVOKE DELETE, TRUNCATE ON platform.api_key FROM aerolith_app;

CREATE TABLE platform.webhook (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 500),
  events text[] NOT NULL CHECK (events <@ ARRAY['order.issued', 'receipt.posted', 'bill.certified',
    'portal.submission', 'ping']::text[] AND cardinality(events) > 0),
  secret_sealed text NOT NULL,                       -- sealed with the control-plane key; shown once
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.secure_table('platform.webhook');
REVOKE DELETE, TRUNCATE ON platform.webhook FROM aerolith_app;

-- The outbox: written in the same transaction as the change, sent by the worker with retries.
CREATE TABLE platform.webhook_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES platform.webhook (id),
  event_id uuid NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  last_status int,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX webhook_delivery_due ON platform.webhook_delivery (next_at) WHERE status = 'pending';
CREATE INDEX webhook_delivery_hook ON platform.webhook_delivery (webhook_id, created_at DESC);
SELECT platform.secure_table('platform.webhook_delivery');

-- What the Tally agent sent, per voucher (and per master); a failure stays pending with Tally's answer.
CREATE TABLE acc.tally_sync (
  voucher_id uuid PRIMARY KEY REFERENCES acc.voucher (id),
  status text NOT NULL CHECK (status IN ('created', 'failed')),
  response text NOT NULL DEFAULT '' CHECK (length(response) <= 2000),
  attempts int NOT NULL DEFAULT 1,
  synced_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.secure_table('acc.tally_sync');
REVOKE DELETE, TRUNCATE ON acc.tally_sync FROM aerolith_app;
