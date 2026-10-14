-- Audit trail (docs/wave7-plan.md step 7a.8): every insert, change and delete of the main business records written to
-- platform.audit_log by a trigger, so the trail does not depend on each service remembering to write it. The person
-- is the row's own updated_by (a change) or created_by (a new row) where the table keeps one; a change records the
-- fields that changed, with old and new values when they are short.

CREATE FUNCTION platform.audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  o jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  changed jsonb := '{}';
  k text;
  actor text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR k IN SELECT jsonb_object_keys(n) LOOP
      CONTINUE WHEN k IN ('row_version', 'updated_at', 'updated_by', 'search')
        OR (n -> k) IS NOT DISTINCT FROM (o -> k);
      changed := changed || jsonb_build_object(k,
        CASE WHEN length(coalesce(o ->> k, '')) <= 120 AND length(coalesce(n ->> k, '')) <= 120
          AND jsonb_typeof(coalesce(n -> k, o -> k)) NOT IN ('object', 'array')
        THEN jsonb_build_array(o -> k, n -> k) ELSE NULL END);
    END LOOP;
    IF changed = '{}' THEN RETURN NEW; END IF;  -- nothing a person would call a change
    actor := n ->> 'updated_by';
  ELSIF TG_OP = 'INSERT' THEN
    actor := coalesce(n ->> 'created_by', n ->> 'applied_by', n ->> 'raised_by', n ->> 'submitted_by');
  END IF;
  INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
  VALUES (
    actor::uuid,
    lower(TG_OP),
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    coalesce(n ->> 'id', o ->> 'id'),
    CASE TG_OP
      WHEN 'UPDATE' THEN jsonb_build_object('changed', changed)
      WHEN 'INSERT' THEN jsonb_strip_nulls(jsonb_build_object('number', n ->> 'number', 'status', n ->> 'status',
        'name', coalesce(n ->> 'name', n ->> 'title')))
      ELSE jsonb_strip_nulls(jsonb_build_object('number', o ->> 'number', 'name', coalesce(o ->> 'name', o ->> 'title')))
    END);
  RETURN coalesce(NEW, OLD);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'proj.project', 'proj.daily_report', 'proc.requisition', 'proc.purchase_order', 'proc.goods_receipt',
    'proc.stock_issue', 'proc.stock_transfer', 'acc.voucher', 'acc.vendor_bill', 'acc.client_bill',
    'acc.subcontract_bill', 'acc.client_receipt', 'acc.payment_run', 'ctl.variation', 'tender.tender',
    'platform.party', 'hr.employee', 'hr.leave_application', 'qa.ncr', 'qa.inspection', 'dms.rfi'
  ] LOOP
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON %s
      FOR EACH ROW EXECUTE FUNCTION platform.audit_row()', t);
  END LOOP;
END $$;

-- The screen reads newest first, by person and by record.
CREATE INDEX audit_log_created ON platform.audit_log (created_at DESC);
CREATE INDEX audit_log_actor ON platform.audit_log (actor_id, created_at DESC);
