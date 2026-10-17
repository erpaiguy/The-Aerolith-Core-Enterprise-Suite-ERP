-- A booking's life after the sale (docs/wave8-plan.md step 8f.1): cancellation with forfeiture, a GST credit note
-- for every demand it reverses and the refund; transfer (nomination) to a new buyer with a transfer fee; stamp duty
-- and registration details; possession offered, the handover with its checklist, and the five-year defect period.
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, 'I2005', 'Forfeiture on cancelled bookings', 'ordinary', 'forfeiture_income'
FROM acc.account g WHERE g.system_key = 'other_income'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = 'i2005' OR a.system_key = 'forfeiture_income');
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, 'I2004', 'Transfer fees from buyers', 'ordinary', 'transfer_fees'
FROM acc.account g WHERE g.system_key = 'other_income'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = 'i2004' OR a.system_key = 'transfer_fees');

-- A charge (the transfer fee) is a demand too, without a stage.
ALTER TABLE re.demand DROP CONSTRAINT demand_kind_check;
ALTER TABLE re.demand ADD CONSTRAINT demand_kind_check CHECK (kind IN ('stage', 'interest', 'charge'));

-- A GST credit note reversing a demand (CGST Act s.34), when its booking is cancelled.
CREATE TABLE re.credit_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  demand_id uuid NOT NULL UNIQUE REFERENCES re.demand (id),
  booking_id uuid NOT NULL REFERENCES re.booking (id),
  issued_on date NOT NULL,
  base numeric(16, 2) NOT NULL CHECK (base >= 0),
  cgst numeric(16, 2) NOT NULL DEFAULT 0,
  sgst numeric(16, 2) NOT NULL DEFAULT 0,
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_by uuid NOT NULL REFERENCES platform."user" (id)
);
SELECT platform.secure_table('re.credit_note');
REVOKE UPDATE, DELETE, TRUNCATE ON re.credit_note FROM aerolith_app;

ALTER TABLE re.booking
  ADD COLUMN cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 1000),
  ADD COLUMN forfeited numeric(16, 2) NOT NULL DEFAULT 0 CHECK (forfeited >= 0),
  ADD COLUMN refunded numeric(16, 2) NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  ADD COLUMN refund_voucher_id uuid REFERENCES acc.voucher (id),
  ADD COLUMN stamp_duty numeric(16, 2) CHECK (stamp_duty >= 0),
  ADD COLUMN registration_fee numeric(16, 2) CHECK (registration_fee >= 0),
  ADD COLUMN registration_no text NOT NULL DEFAULT '' CHECK (length(registration_no) <= 60),
  ADD COLUMN registered_on date,
  ADD COLUMN sub_registrar text NOT NULL DEFAULT '' CHECK (length(sub_registrar) <= 120),
  ADD COLUMN possession_offered_on date,
  ADD COLUMN possession_on date,
  ADD COLUMN handover jsonb NOT NULL DEFAULT '[]';

CREATE TABLE re.booking_transfer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES re.booking (id),
  transferred_on date NOT NULL,
  from_buyer_id uuid NOT NULL REFERENCES re.buyer (id),
  to_buyer_id uuid NOT NULL REFERENCES re.buyer (id),
  fee numeric(16, 2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  demand_id uuid REFERENCES re.demand (id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.secure_table('re.booking_transfer');
REVOKE UPDATE, DELETE, TRUNCATE ON re.booking_transfer FROM aerolith_app;
