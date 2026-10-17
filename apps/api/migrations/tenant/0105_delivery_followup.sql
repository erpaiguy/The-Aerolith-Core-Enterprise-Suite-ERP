-- Delivery follow-up (docs/wave8-plan.md step 8e.2): an order line's quantity due in instalments (staggered steel and
-- ready-mix deliveries), the buyer's expediting notes with the date the supplier promised, read against what came.
CREATE TABLE proc.delivery_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  line_key uuid NOT NULL,
  due_on date NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (po_id, line_key, due_on)
);
CREATE INDEX delivery_schedule_due ON proc.delivery_schedule (due_on);
SELECT platform.secure_table('proc.delivery_schedule');

CREATE TABLE proc.expedite_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  noted_on date NOT NULL,
  note text NOT NULL CHECK (length(trim(note)) BETWEEN 3 AND 2000),
  promised_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX expedite_note_po ON proc.expedite_note (po_id, noted_on);
SELECT platform.secure_table('proc.expedite_note');
REVOKE UPDATE, DELETE, TRUNCATE ON proc.expedite_note FROM aerolith_app;
