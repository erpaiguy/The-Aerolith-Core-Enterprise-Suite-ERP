-- Foreign-currency items (docs/01-mvp.md "currency"): an item priced in another currency (an imported lift in USD)
-- keeps its foreign rate; its rupee rate is the foreign rate at the BOQ's exchange rate for that currency, and
-- changing that exchange rate re-prices every such item. Amounts and totals stay in the BOQ's currency.
CREATE TABLE est.boq_currency (
  boq_id uuid NOT NULL REFERENCES est.boq (id),
  code text NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  rate numeric(20,6) NOT NULL CHECK (rate > 0),     -- rupees for one unit of the currency
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (boq_id, code)
);
SELECT platform.secure_table('est.boq_currency');

ALTER TABLE est.boq_node
  ADD COLUMN foreign_currency text CHECK (foreign_currency IS NULL OR foreign_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN foreign_rate numeric(20,4);
ALTER TABLE est.boq_node_hist ADD COLUMN foreign_currency text, ADD COLUMN foreign_rate numeric(20,4);
CREATE INDEX boq_node_foreign ON est.boq_node (boq_id, foreign_currency) WHERE foreign_currency IS NOT NULL;
