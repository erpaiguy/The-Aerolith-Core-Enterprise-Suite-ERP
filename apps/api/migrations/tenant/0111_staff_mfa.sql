-- Two-factor sign-in for staff (docs/wave8-plan.md step 8g.1): an authenticator app (TOTP) for any user who wants it,
-- and, when the company turns it on, required of admins and of everyone who posts to the books. The secret is kept
-- sealed; recovery codes only as hashes.
ALTER TABLE platform."user"
  ADD COLUMN totp_pending_secret text,
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD COLUMN recovery_codes text[] NOT NULL DEFAULT '{}';

CREATE TABLE platform.security_setting (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  require_mfa boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id)
);
SELECT platform.secure_table('platform.security_setting');
