-- Kinds of BOQ item (docs/04-features.md E3: alternates/options, provisional sums; Indian tenders' "rate only" items).
--   normal       quantity × rate, counted in the total
--   provisional  a provisional sum the client fixes: counted in the total; pricing markups are not applied to it
--   rate_only    priced for the record, no amount, not in the total (the client asks for the rate only)
--   alternate    an alternate or option: priced, its value shown, not in the total
-- Items of the last two kinds keep amount NULL, so every subtotal, total, comparison and dashboard leaves them out
-- without knowing about kinds.
ALTER TABLE est.boq_node ADD COLUMN item_kind text NOT NULL DEFAULT 'normal'
  CHECK (item_kind IN ('normal', 'provisional', 'rate_only', 'alternate'));
ALTER TABLE est.boq_node_hist ADD COLUMN item_kind text NOT NULL DEFAULT 'normal';
-- Few lines are of another kind: found without reading the BOQ.
CREATE INDEX boq_node_kind ON est.boq_node (boq_id, item_kind) WHERE item_kind <> 'normal';
