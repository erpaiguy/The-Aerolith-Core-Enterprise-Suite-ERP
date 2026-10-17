-- The deviation statement (docs/wave8-plan.md step 8d.5): the contract's limit on how far an item's executed quantity
-- may move from the tendered one before it needs fresh sanction or new rates (CPWD clause 12 uses 30% for most items;
-- the contract decides, so it is set per project).
ALTER TABLE ctl.variation_settings
  ADD COLUMN deviation_limit_pct numeric(5, 2) NOT NULL DEFAULT 30 CHECK (deviation_limit_pct BETWEEN 0 AND 1000);
