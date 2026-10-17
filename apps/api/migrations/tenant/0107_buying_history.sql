-- Buying with history (docs/wave8-plan.md step 8e.4): a maximum stock level beside the reorder (minimum) level, so a
-- reorder fills the store up to the maximum.
ALTER TABLE proc.reorder_level
  ADD COLUMN max_level numeric(20,4) CHECK (max_level IS NULL OR max_level >= level);
CREATE INDEX stock_move_issue ON proc.stock_move (store_id, resource_id, moved_on) WHERE kind = 'issue';
