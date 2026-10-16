-- Debit notes from the stores (docs/wave8-plan.md step 8a.5): a debit note proposed from what the stores and the order
-- say (billed beyond what was accepted, once goods went back or the order is closed; billed above the order's rate)
-- records what it came from, so the same difference is never noted twice.
ALTER TABLE acc.debit_note
  ADD COLUMN source_kind text CHECK (source_kind IN ('short', 'rate')),
  ADD COLUMN source_line_key uuid,
  ADD COLUMN source_qty numeric(20,4),
  ADD CONSTRAINT debit_note_source CHECK ((source_kind IS NULL) = (source_line_key IS NULL));
CREATE INDEX debit_note_source_line ON acc.debit_note (source_line_key) WHERE source_line_key IS NOT NULL;
