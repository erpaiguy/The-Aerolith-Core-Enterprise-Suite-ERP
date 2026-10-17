-- Receipts and transfers as they really happen (docs/wave8-plan.md step 8e.3): an order's over-receipt tolerance
-- (weighbridge loads of sand and aggregate rarely match the order to the kilo), the transporter and e-way bill on
-- receipts and transfers, what actually arrived on a transfer with the transit loss, and a company's central store,
-- kept on a "central stores" project that every member of staff works as its team.
ALTER TABLE proj.project ADD COLUMN is_central boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX project_central ON proj.project (entity_id) WHERE is_central;

ALTER TABLE proc.purchase_order
  ADD COLUMN receipt_tolerance_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (receipt_tolerance_pct BETWEEN 0 AND 25);

ALTER TABLE proc.goods_receipt
  ADD COLUMN transporter text CHECK (transporter IS NULL OR length(transporter) <= 200),
  ADD COLUMN eway_bill_no text CHECK (eway_bill_no IS NULL OR eway_bill_no ~ '^[0-9]{12}$');

ALTER TABLE proc.stock_transfer
  ADD COLUMN vehicle_no text CHECK (vehicle_no IS NULL OR length(vehicle_no) <= 30),
  ADD COLUMN transporter text CHECK (transporter IS NULL OR length(transporter) <= 200),
  ADD COLUMN eway_bill_no text CHECK (eway_bill_no IS NULL OR eway_bill_no ~ '^[0-9]{12}$');

-- What arrived of each line; the rest is lost in transit, at its share of the line's value, with the reason.
ALTER TABLE proc.stock_transfer_line
  ADD COLUMN received_qty numeric(20,4) CHECK (received_qty >= 0),
  ADD COLUMN lost_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (lost_qty >= 0),
  ADD COLUMN lost_value numeric(20,2) NOT NULL DEFAULT 0 CHECK (lost_value >= 0),
  ADD COLUMN loss_reason text CHECK (loss_reason IS NULL OR length(loss_reason) <= 500);
