-- TDS on flat buyers' payments (docs/wave8-plan.md step 8b.5, section 194-IA): a buyer paying for a unit of ₹50 lakh
-- or more deducts 1% and deposits it by Form 26QB. The receipt settles the demand by the cash and the TDS together;
-- the TDS waits as TDS receivable, with the 26QB acknowledgement, until 26AS shows it under the buyer's PAN.
ALTER TABLE re.receipt
  ADD COLUMN tds numeric(16, 2) NOT NULL DEFAULT 0 CHECK (tds >= 0),
  ADD COLUMN tds_ack text NOT NULL DEFAULT '' CHECK (length(tds_ack) <= 40);
