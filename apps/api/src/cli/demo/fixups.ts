// After the replay: the database stamped created_at, approved_at and the like with the real now(). Here they are moved
// to the day the thing happened in the story (from each row's own business date, or from the moment the seeder noted
// when it made it). Reminders already past are dropped so nobody's inbox opens on two years of overdue alerts.
// Runs as the database administrator (the app's role may not rewrite audit columns); skipped if there is none.
import postgres from 'postgres';
import type { Ctx } from './ctx.js';

const IST = (col: string, hour: number) => `((${col})::timestamp + interval '${hour} hours') AT TIME ZONE 'Asia/Kolkata'`;

export async function fixHistory(c: Ctx): Promise<void> {
  const adminUrl = process.env.LOCAL_PG_ADMIN_URL;
  const [row] = await c.db<{ db: string }[]>`SELECT current_database() AS db`;
  const db = row!.db;
  if (!adminUrl) {
    process.stdout.write('  (no LOCAL_PG_ADMIN_URL: created-at times left as today)\n');
    return;
  }
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql`SET session_replication_role = replica`.catch(() => {});
    await sql`CREATE TEMP TABLE demo_stamp (id uuid PRIMARY KEY, at timestamptz NOT NULL)`;
    const rows = [...c.stamps.entries()].map(([id, at]) => ({ id, at: new Date(at) }));
    for (let i = 0; i < rows.length; i += 5000)
      await sql`INSERT INTO demo_stamp ${sql(rows.slice(i, i + 5000), 'id', 'at')} ON CONFLICT DO NOTHING`;
    const fixes: [string, string][] = [
      ['vouchers', `UPDATE acc.voucher SET created_at = ${IST('voucher_date', 17)}`],
      ['vendor bills', `UPDATE acc.vendor_bill SET created_at = ${IST('bill_date', 15)}, updated_at = ${IST('bill_date', 15)}`],
      ['client bills', `UPDATE acc.client_bill SET created_at = ${IST('upto + 1', 11)}, updated_at = ${IST('coalesce(certified_on, upto + 1)', 16)}`],
      ['measurements', `UPDATE proj.measurement SET created_at = ${IST('measured_on', 16)}`],
      ['daily reports', `UPDATE proj.daily_report SET created_at = ${IST('report_date', 9)}, updated_at = ${IST('report_date', 18)},
        submitted_at = CASE WHEN submitted_at IS NULL THEN NULL ELSE ${IST('report_date', 18)} END,
        acknowledged_at = CASE WHEN acknowledged_at IS NULL THEN NULL ELSE ${IST('report_date + 1', 10)} END`],
      ['goods receipts', `UPDATE proc.goods_receipt SET created_at = ${IST('received_on', 14)}, updated_at = ${IST('received_on', 14)}`],
      ['tenders', `UPDATE tender.tender SET created_at = ${IST('published_on', 10)}, updated_at = ${IST('coalesce(result_on, published_on)', 17)} WHERE published_on IS NOT NULL`],
      ['rates', `UPDATE est.resource_rate SET created_at = ${IST('effective_from', 10)}`],
      ['incidents', `UPDATE hse.incident SET created_at = occurred_at + interval '1 hour', closed_on = CASE WHEN closed_on IS NULL THEN NULL ELSE (occurred_at AT TIME ZONE 'Asia/Kolkata')::date + 7 END`],
      ['cost baselines', `UPDATE ctl.baseline b SET taken_at = ${IST('p.start_on - 3', 12)} FROM proj.project p WHERE p.id = b.project_id AND p.start_on IS NOT NULL`],
      ['programme baselines', `UPDATE sched.baseline b SET taken_at = ${IST('pl.start_on - 3', 12)} FROM sched.plan pl WHERE pl.id = b.plan_id`],
      ['snags', `UPDATE qa.snag s SET created_at = ${IST('p.actual_finish_on - 12', 11)}, fixed_on = CASE WHEN fixed_on IS NULL THEN NULL ELSE p.actual_finish_on - 6 END, closed_on = CASE WHEN closed_on IS NULL THEN NULL ELSE p.actual_finish_on - 3 END FROM proj.project p WHERE p.id = s.project_id AND p.actual_finish_on IS NOT NULL`],
      // Rows the seeder stamped as it made them.
      ...['proc.purchase_order', 'proc.requisition', 'proj.project', 'crm.lead', 'ctl.variation', 'ctl.risk', 'dms.transmittal', 'qa.ncr', 'qa.inspection', 'qa.test', 'qa.checklist', 'hse.toolbox_talk', 'hr.leave_application', 'pay.run', 'lab.wage_sheet', 'est.boq', 'est.rate_analysis', 'est.resource', 'platform.party', 'proj.drawing', 'doc.document'].map(
        (t) => [t, `UPDATE ${t} x SET created_at = s.at FROM demo_stamp s WHERE x.id = s.id`] as [string, string],
      ),
      ['RFIs', `UPDATE dms.rfi x SET raised_at = s.at FROM demo_stamp s WHERE x.id = s.id`],
      ['order revisions', `UPDATE proc.po_revision r SET created_at = s.at, approved_at = CASE WHEN r.approved_at IS NULL THEN NULL ELSE s.at + interval '2 hours' END FROM demo_stamp s WHERE r.id = s.id`],
      ['order revisions by order', `UPDATE proc.po_revision r SET created_at = o.created_at, approved_at = CASE WHEN r.approved_at IS NULL THEN NULL ELSE o.created_at + interval '2 hours' END FROM proc.purchase_order o WHERE o.id = r.po_id AND r.revision = 0`],
      ['approvals', `UPDATE platform.approval_request a SET submitted_at = s.at, decided_at = CASE WHEN a.decided_at IS NULL THEN NULL ELSE s.at + interval '2 hours' END FROM demo_stamp s WHERE a.doc_id = s.id`],
      ['approvals of orders', `UPDATE platform.approval_request a SET submitted_at = r.created_at, decided_at = CASE WHEN a.decided_at IS NULL THEN NULL ELSE r.approved_at END FROM proc.po_revision r WHERE a.doc_id = r.id`],
      ['leads closed', `UPDATE crm.lead l SET closed_at = (SELECT max(i.happened_at) FROM crm.interaction i WHERE i.lead_id = l.id) WHERE closed_at IS NOT NULL AND EXISTS (SELECT 1 FROM crm.interaction i WHERE i.lead_id = l.id)`],
      ['BOQ versions', `UPDATE est.boq_version v SET frozen_at = s.submitted_at FROM est.boq b JOIN tender.submission s ON s.tender_id = b.tender_id AND s.kind = 'original' WHERE b.id = v.boq_id AND v.frozen_at IS NOT NULL`],
      ['material approvals', `UPDATE qa.material_approval m SET decided_on = (p.start_on - 5) FROM proj.project p WHERE p.id = m.project_id AND m.decided_on IS NOT NULL AND p.start_on IS NOT NULL`],
      ['past reminders', `DELETE FROM platform.notification WHERE due_at IS NULL OR due_at < now()`],
    ];
    let ok = 0;
    for (const [what, q] of fixes) {
      try {
        await sql.unsafe(q);
        ok++;
      } catch (err) {
        process.stdout.write(`  (dates of ${what} left as made: ${(err as Error).message.slice(0, 160)})\n`);
      }
    }
    process.stdout.write(`Moved the made-on times of ${ok} kinds of record to their days in the story.\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
