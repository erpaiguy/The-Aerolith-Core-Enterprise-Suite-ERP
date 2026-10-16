-- Budget check on purchase orders (docs/wave8-plan.md step 8a.4): when an order revision is put up, each line for a
-- material in the project's approved material budget is checked against what the budget allows less what the
-- project's other orders in force already take. Over budget, the revision carries the figures and the reason given;
-- it goes ahead only for the project's lead or to an approver, never on its own.
ALTER TABLE proc.po_revision
  ADD COLUMN over_budget jsonb,
  ADD COLUMN over_budget_reason text CHECK (over_budget_reason IS NULL OR length(over_budget_reason) <= 1000);
