-- GST reverse charge and Rule 37 (docs/wave8-plan.md step 8b.1). A bill under reverse charge carries no GST from the
-- supplier: the company owes the tax itself (paid in cash, GSTR-3B table 3.1(d)) and takes the same tax as input
-- credit (table 4(A)(3)) unless the ledger's credit is blocked. Input credit on a bill still unpaid 180 days after its
-- date is reversed (Rule 37, table 4(B)(2)) and taken back when the bill is paid.
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, x.code, x.name, x.kind, x.key
FROM (VALUES
  ('duties_and_taxes', 'L5014', 'CGST payable, reverse charge', 'tax', 'rcm_cgst'),
  ('duties_and_taxes', 'L5015', 'SGST payable, reverse charge', 'tax', 'rcm_sgst'),
  ('duties_and_taxes', 'L5016', 'IGST payable, reverse charge', 'tax', 'rcm_igst'),
  ('loans_and_advances', 'A5011', 'Input credit reversed, unpaid suppliers (Rule 37)', 'ordinary', 'itc_rule37')
) AS x(parent, code, name, kind, key)
JOIN acc.account g ON g.system_key = x.parent
WHERE NOT EXISTS (SELECT 1 FROM acc.account a
  WHERE lower(a.code) = lower(x.code) OR lower(a.name) = lower(x.name) OR a.system_key = x.key);

ALTER TABLE acc.vendor_bill
  ADD COLUMN rcm_category text CHECK (rcm_category IN ('unregistered', 'gta', 'legal', 'security', 'renting', 'other')),
  ADD COLUMN rcm_cgst numeric(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN rcm_sgst numeric(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN rcm_igst numeric(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN rcm_blocked numeric(20,2) NOT NULL DEFAULT 0;   -- the part of it on ledgers whose credit is blocked

-- A supplier whose services fall under reverse charge, so their bills default to it.
ALTER TABLE platform.party
  ADD COLUMN rcm_category text CHECK (rcm_category IN ('unregistered', 'gta', 'legal', 'security', 'renting', 'other'));

CREATE TABLE acc.itc_reversal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  bill_id uuid NOT NULL REFERENCES acc.vendor_bill (id),
  reversed_on date NOT NULL,
  unpaid numeric(20,2) NOT NULL CHECK (unpaid > 0),
  cgst numeric(20,2) NOT NULL DEFAULT 0,
  sgst numeric(20,2) NOT NULL DEFAULT 0,
  igst numeric(20,2) NOT NULL DEFAULT 0,
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  reclaimed_on date,
  reclaim_voucher_id uuid REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE UNIQUE INDEX itc_reversal_open ON acc.itc_reversal (bill_id) WHERE reclaimed_on IS NULL;
CREATE INDEX itc_reversal_entity ON acc.itc_reversal (entity_id, reversed_on);
SELECT platform.secure_table('acc.itc_reversal');
REVOKE DELETE, TRUNCATE ON acc.itc_reversal FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.itc_reversal
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
