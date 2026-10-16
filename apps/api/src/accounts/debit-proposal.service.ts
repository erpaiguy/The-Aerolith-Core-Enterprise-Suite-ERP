// Debit notes from the stores (docs/wave8-plan.md step 8a.5): what the order and the stores say a supplier should be
// debited, proposed for accounts to raise in one step rather than typed:
// - billed beyond what was accepted on an order line, once goods have gone back to the supplier or the order is
//   closed (no more is coming): the extra quantity at the billed rate, against the bill with most outstanding;
// - billed above the order's rate on a posted bill line: the difference × the quantity, against that bill.
// What each note came from is recorded, so the same difference is never proposed again.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt, mul } from '../rates/decimal.js';
import { PayableService } from './payable.service.js';

type Db = Sql | TransactionSql;

export interface Proposal {
  key: string;
  kind: 'short' | 'rate';
  bill: { id: string; billNo: string; party: string; outstanding: string };
  order: string;
  lineKey: string;
  description: string;
  unit: string;
  qty: string;
  rate: string;
  taxable: string;
  gstPct: string;
  reason: string;
}

const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

@Injectable()
export class DebitProposalService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly payables: PayableService,
  ) {}

  private async proposalsOf(db: Db, entityId: string): Promise<Proposal[]> {
    const outstanding = this.payables.outstandingSql(db);
    // Billed beyond accepted, per order line.
    const short = await db<
      {
        lineKey: string;
        order: string;
        description: string;
        unit: string;
        billed: string;
        accepted: string;
        noted: string;
        rate: string;
        gstPct: string;
        billId: string;
        billNo: string;
        party: string;
        outstanding: string;
        returns: string | null;
      }[]
    >`
      WITH billed AS (
        SELECT bl.line_key, sum(bl.qty) AS qty, max(bl.rate) AS rate, max(bl.gst_pct) AS gst_pct
        FROM acc.vendor_bill_line bl JOIN acc.vendor_bill b ON b.id = bl.bill_id
        WHERE b.entity_id = ${entityId} AND b.status = 'posted' AND bl.line_key IS NOT NULL GROUP BY bl.line_key),
      accepted AS (
        SELECT g.line_key, sum(g.accepted_qty) AS qty,
          string_agg(DISTINCT t.number, ', ') AS returns
        FROM proc.grn_line g JOIN proc.goods_receipt h ON h.id = g.receipt_id AND h.status = 'posted'
        LEFT JOIN proc.goods_return t ON t.receipt_id = h.id
        GROUP BY g.line_key)
      SELECT x.line_key AS "lineKey", o.number AS order, l.description, l.unit, x.qty::text AS billed,
        coalesce(a.qty, 0)::text AS accepted,
        coalesce((SELECT sum(d.source_qty) FROM acc.debit_note d WHERE d.source_kind = 'short'
          AND d.source_line_key = x.line_key), 0)::text AS noted,
        x.rate::text AS rate, x.gst_pct::text AS "gstPct", bb.id AS "billId", bb.bill_no AS "billNo",
        p.name AS party, bb.outstanding::text AS outstanding, a.returns
      FROM billed x
      JOIN proc.po_line l ON l.line_key = x.line_key
      JOIN proc.po_revision v ON v.id = l.revision_id AND v.status = 'approved'
      JOIN proc.purchase_order o ON o.id = v.po_id AND o.kind = 'purchase'
      JOIN platform.party p ON p.id = o.party_id
      LEFT JOIN accepted a ON a.line_key = x.line_key
      JOIN LATERAL (
        SELECT b.id, b.bill_no, ${outstanding} AS outstanding FROM acc.vendor_bill b
        JOIN acc.vendor_bill_line bl ON bl.bill_id = b.id AND bl.line_key = x.line_key
        WHERE b.status = 'posted' ORDER BY ${outstanding} DESC LIMIT 1) bb ON true
      WHERE x.qty > coalesce(a.qty, 0) AND (o.status IN ('closed', 'cancelled') OR a.returns IS NOT NULL)`;
    // Billed above the order's rate, per posted bill line.
    const rate = await db<
      {
        billId: string;
        billNo: string;
        party: string;
        outstanding: string;
        order: string;
        lineKey: string;
        description: string;
        unit: string;
        qty: string;
        billed: string;
        ordered: string;
        gstPct: string;
        noted: boolean;
      }[]
    >`
      SELECT b.id AS "billId", b.bill_no AS "billNo", p.name AS party, ${outstanding}::text AS outstanding,
        o.number AS order, bl.line_key AS "lineKey", bl.description, coalesce(bl.unit, l.unit) AS unit,
        bl.qty::text AS qty, bl.rate::text AS billed, l.rate::text AS ordered, bl.gst_pct::text AS "gstPct",
        EXISTS (SELECT 1 FROM acc.debit_note d WHERE d.bill_id = b.id AND d.source_kind = 'rate'
          AND d.source_line_key = bl.line_key) AS noted
      FROM acc.vendor_bill b JOIN acc.vendor_bill_line bl ON bl.bill_id = b.id
      JOIN platform.party p ON p.id = b.party_id
      JOIN proc.po_line l ON l.line_key = bl.line_key
      JOIN proc.po_revision v ON v.id = l.revision_id AND v.status = 'approved'
      JOIN proc.purchase_order o ON o.id = v.po_id
      WHERE b.entity_id = ${entityId} AND b.status = 'posted' AND bl.rate > l.rate`;
    const out: Proposal[] = [];
    for (const s of short) {
      const extra = dec(s.billed) - dec(s.accepted) - dec(s.noted);
      if (extra <= 0n) continue;
      const taxable = mul(extra, dec(s.rate));
      out.push({
        key: `short:${s.billId}:${s.lineKey}`,
        kind: 'short',
        bill: { id: s.billId, billNo: s.billNo, party: s.party, outstanding: s.outstanding },
        order: s.order,
        lineKey: s.lineKey,
        description: s.description,
        unit: s.unit,
        qty: fmt(extra, 4),
        rate: s.rate,
        taxable: fmt(taxable, 2),
        gstPct: s.gstPct,
        reason:
          `${s.description}: billed ${Number(s.billed)} ${s.unit}, accepted ${Number(s.accepted)}${
            s.returns ? ` (returned on ${s.returns})` : ''
          }`.slice(0, 500),
      });
    }
    for (const r of rate) {
      if (r.noted) continue;
      const taxable = mul(dec(r.qty), dec(r.billed) - dec(r.ordered));
      if (taxable <= 0n) continue;
      out.push({
        key: `rate:${r.billId}:${r.lineKey}`,
        kind: 'rate',
        bill: { id: r.billId, billNo: r.billNo, party: r.party, outstanding: r.outstanding },
        order: r.order,
        lineKey: r.lineKey,
        description: r.description,
        unit: r.unit,
        qty: r.qty,
        rate: fmt(dec(r.billed) - dec(r.ordered), 4),
        taxable: fmt(taxable, 2),
        gstPct: r.gstPct,
        reason:
          `${r.description}: billed at ₹${Number(r.billed)}, ordered at ₹${Number(r.ordered)}`.slice(
            0,
            500,
          ),
      });
    }
    return out.sort(
      (a, b) => a.bill.party.localeCompare(b.bill.party) || a.key.localeCompare(b.key),
    );
  }

  async proposals(claims: TenantClaims, entityId: string) {
    if (!(await this.permissions.can(claims, 'accounts.view')))
      throw new NotFoundException({ code: 'not_found' });
    const db = await this.tenants.forTenant(claims.ten);
    return {
      proposals: await this.proposalsOf(db, entityId),
      mayPost: await this.permissions.can(claims, 'accounts.post'),
    };
  }

  /** Raises the debit note a proposal describes, worked out again now. */
  async accept(claims: TenantClaims, entityId: string, key: string, date = indiaToday()) {
    const db = await this.tenants.forTenant(claims.ten);
    const p = (await this.proposalsOf(db, entityId)).find((x) => x.key === key);
    if (!p)
      throw new BadRequestException({
        code: 'no_such_proposal',
        message: 'That difference is already noted, or no longer stands.',
      });
    await this.payables.debitNote(
      claims,
      p.bill.id,
      { date, reason: p.reason, taxable: p.taxable, gstPct: p.gstPct },
      { kind: p.kind, lineKey: p.lineKey, qty: p.qty },
    );
    return this.proposals(claims, entityId);
  }
}
