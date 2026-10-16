-- GST TDS by government clients (docs/wave8-plan.md step 8b.2, CGST Act section 51): the 2% a government department
-- deducts from a payment is recorded on the receipt apart from income-tax TDS, waits as a receivable, and once the
-- deductor's return shows it (GSTR-7A) and it is accepted on the portal, moves to the electronic cash ledger.
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, x.code, x.name, 'ordinary', x.key
FROM (VALUES
  ('loans_and_advances', 'A5012', 'GST TDS deducted by clients (section 51)', 'gst_tds_receivable'),
  ('loans_and_advances', 'A5013', 'GST electronic cash ledger', 'gst_cash_ledger')
) AS x(parent, code, name, key)
JOIN acc.account g ON g.system_key = x.parent
WHERE NOT EXISTS (SELECT 1 FROM acc.account a
  WHERE lower(a.code) = lower(x.code) OR lower(a.name) = lower(x.name) OR a.system_key = x.key);

ALTER TABLE acc.client_receipt ADD COLUMN gst_tds numeric(20,2) NOT NULL DEFAULT 0 CHECK (gst_tds >= 0);

-- A deductor's credit as GSTR-7A shows it, accepted into the cash ledger.
CREATE TABLE acc.gst_tds_credit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES platform.entity (id),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  deductor_gstin text NOT NULL CHECK (deductor_gstin ~ '^[0-9]{2}[0-9A-Z]{13}$'),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  accepted_on date NOT NULL,
  voucher_id uuid NOT NULL REFERENCES acc.voucher (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id),
  UNIQUE (entity_id, party_id, month)
);
SELECT platform.secure_table('acc.gst_tds_credit');
REVOKE UPDATE, DELETE, TRUNCATE ON acc.gst_tds_credit FROM aerolith_app;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc.gst_tds_credit
  FOR EACH ROW EXECUTE FUNCTION platform.audit_row();
