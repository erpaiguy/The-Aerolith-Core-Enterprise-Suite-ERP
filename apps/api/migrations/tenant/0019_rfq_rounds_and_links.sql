-- Negotiation rounds (docs/04-features.md E8): a vendor quoting again keeps their earlier quote as a round, so the
-- comparative statement shows the latest and the history shows how each rate moved.
ALTER TABLE tender.rfq_quote ADD COLUMN round int NOT NULL DEFAULT 1 CHECK (round > 0);
CREATE TABLE tender.rfq_quote_round (
  rfq_id uuid NOT NULL,
  party_id uuid NOT NULL,
  round int NOT NULL CHECK (round > 0),
  received_on date NOT NULL,
  reference text,
  gst_mode text NOT NULL,
  gst_pct numeric(5,2) NOT NULL,
  source text NOT NULL,
  rates jsonb NOT NULL,                 -- {"<line id>": {"rate": "123.4", "remark": ""}}
  replaced_at timestamptz NOT NULL DEFAULT now(),
  replaced_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (rfq_id, party_id, round),
  FOREIGN KEY (rfq_id, party_id) REFERENCES tender.rfq_vendor (rfq_id, party_id) ON DELETE CASCADE
);
SELECT platform.secure_table('tender.rfq_quote_round');
REVOKE UPDATE ON tender.rfq_quote_round FROM aerolith_app;

-- A tender document linked to what it belongs to (docs/04-features.md E10): a vendor's quote on an RFQ, a checklist
-- item, an addendum. The document stays in the vault; the link only points at it.
CREATE TABLE doc.document_link (
  document_id uuid NOT NULL REFERENCES doc.document (id),
  target_kind text NOT NULL CHECK (target_kind IN ('rfq_vendor', 'checklist_item', 'addendum')),
  target_id text NOT NULL CHECK (length(target_id) <= 80),   -- rfq_vendor: "<rfq id>/<party id>"
  tender_id uuid NOT NULL REFERENCES tender.tender (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  PRIMARY KEY (document_id, target_kind, target_id)
);
CREATE INDEX document_link_target ON doc.document_link (target_kind, target_id);
SELECT platform.secure_table('doc.document_link');
