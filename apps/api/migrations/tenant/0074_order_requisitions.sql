-- Orders from requisitions (docs/wave7-plan.md step 7c.4): which approved requisition lines an order was made from.
-- Kept with the order through its amendments; a line on a live order is not offered again.
CREATE TABLE proc.po_requisition_line (
  po_id uuid NOT NULL REFERENCES proc.purchase_order (id),
  requisition_id uuid NOT NULL,
  position int NOT NULL,
  order_position int NOT NULL CHECK (order_position > 0),   -- the order's first revision line it became
  PRIMARY KEY (po_id, requisition_id, position),
  FOREIGN KEY (requisition_id, position) REFERENCES proc.requisition_line (requisition_id, position)
);
CREATE INDEX po_requisition_line_req ON proc.po_requisition_line (requisition_id, position);
SELECT platform.secure_table('proc.po_requisition_line');
REVOKE UPDATE, DELETE, TRUNCATE ON proc.po_requisition_line FROM aerolith_app;
