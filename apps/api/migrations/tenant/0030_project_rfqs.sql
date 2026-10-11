-- Wave 2b step 3 (docs/wave2b-plan.md): enquiries to vendors for a project. An RFQ belongs to a tender (Wave 1) or
-- to a project; a project's RFQ asks for what its approved requisitions need, and remembers which lines they were.
ALTER TABLE tender.rfq ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE tender.rfq ADD COLUMN project_id uuid REFERENCES proj.project (id);
ALTER TABLE tender.rfq ADD CONSTRAINT rfq_one_owner CHECK ((tender_id IS NULL) <> (project_id IS NULL));
CREATE INDEX rfq_project ON tender.rfq (project_id) WHERE project_id IS NOT NULL;

-- Which requisition lines an RFQ line asks for (several, when the same material is requisitioned more than once).
CREATE TABLE proc.rfq_requisition_line (
  rfq_line_id uuid NOT NULL REFERENCES tender.rfq_line (id) ON DELETE CASCADE,
  requisition_id uuid NOT NULL,
  position int NOT NULL,
  qty numeric(20,4) NOT NULL,
  PRIMARY KEY (rfq_line_id, requisition_id, position),
  FOREIGN KEY (requisition_id, position) REFERENCES proc.requisition_line (requisition_id, position) ON DELETE CASCADE
);
CREATE INDEX rfq_requisition_line_req ON proc.rfq_requisition_line (requisition_id);
SELECT platform.secure_table('proc.rfq_requisition_line');
