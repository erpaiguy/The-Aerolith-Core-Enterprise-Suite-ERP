// Free-issue material to subcontractors (docs/wave8-plan.md step 8a.3). Material the stores issue against a work
// order is the subcontractor's to account for: for the work certified, each unit of a line should have taken a set
// quantity of the material (the order's norm), plus the wastage allowed. What was issued (net of returns) beyond that
// allowance is recovered at the order's penal rate: proposed on a draft bill, added as a back-charge when a person
// accepts it, and remembered so the same excess is never recovered twice.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt, mul, plusPct, type Dec } from '../rates/decimal.js';
import { LedgerService } from './ledger.service.js';

type Db = Sql | TransactionSql;

export interface MaterialTerm {
  lineKey: string;
  resourceId: string;
  perUnit: string;
  wastagePct: string;
  penalRate: string;
}
export interface FreeIssueRow {
  resource: { id: string; code: string; name: string; unit: string };
  issued: string;
  returned: string;
  theoretical: string;
  allowed: string;
  excess: string;
  recoveredBefore: string;
  toRecover: string;
  rate: string;
  amount: string;
  recoveredHere: string | null;
}

const q4 = (v: Dec) => fmt(v, 4);
const money = (v: Dec) => fmt(v, 2);

@Injectable()
export class FreeIssueService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly ledger: LedgerService,
  ) {}

  private async order(db: Db, orderId: string) {
    const [o] = await db<
      {
        id: string;
        number: string;
        project_id: string;
        entity_id: string;
        kind: string;
        revision_id: string;
      }[]
    >`
      SELECT o.id, o.number, o.project_id, p.entity_id, o.kind, v.id AS revision_id
      FROM proc.purchase_order o JOIN proj.project p ON p.id = o.project_id
      JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
      WHERE o.id = ${orderId}`;
    if (!o || o.kind !== 'work')
      throw new NotFoundException({ code: 'order_not_found', message: 'No such work order.' });
    return o;
  }

  private async mayBill(db: Db, claims: TenantClaims, projectId: string, write: boolean) {
    const a = await this.projects.access(db, claims, projectId);
    if (!write) return;
    if (!(
      (a.canEdit || a.role === 'member') &&
      (await this.permissions.can(claims, 'billing.edit'))
    ))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          "Free-issue terms and recoveries are for the project's team with the billing permission.",
      });
  }

  private async terms(db: Db, orderId: string) {
    return db<
      (MaterialTerm & { line: string; unit: string; resource: string; resourceUnit: string })[]
    >`
      SELECT m.line_key AS "lineKey", m.resource_id AS "resourceId", m.per_unit::text AS "perUnit",
        m.wastage_pct::text AS "wastagePct", m.penal_rate::text AS "penalRate", r.name AS resource,
        r.unit AS "resourceUnit", l.description AS line, l.unit
      FROM acc.wo_material m JOIN est.resource r ON r.id = m.resource_id
      JOIN proc.purchase_order o ON o.id = m.order_id
      JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
      JOIN proc.po_line l ON l.revision_id = v.id AND l.line_key = m.line_key
      WHERE m.order_id = ${orderId} ORDER BY l.position, r.name`;
  }

  /**
   * Per material: issued against the order by `upto` (less returns), what the work's quantities should have taken,
   * the allowance with wastage, the excess, what earlier bills recovered, and what is left to recover.
   */
  private async reckon(
    db: Db,
    orderId: string,
    upto: string,
    quantities: Map<string, Dec>,
    billId: string | null,
  ): Promise<FreeIssueRow[]> {
    const terms = await this.terms(db, orderId);
    const issued = await db<{ resourceId: string; issued: string; returned: string }[]>`
      SELECT l.resource_id AS "resourceId", sum(l.qty)::text AS issued,
        coalesce(sum((SELECT sum(x.qty) FROM proc.stock_issue_return_line x JOIN proc.stock_issue_return t
          ON t.id = x.return_id WHERE t.issue_id = i.id AND x.position = l.position AND t.returned_on <= ${upto})), 0)
          ::text AS returned
      FROM proc.stock_issue i JOIN proc.stock_issue_line l ON l.issue_id = i.id
      WHERE i.order_id = ${orderId} AND i.issued_on <= ${upto}
      GROUP BY l.resource_id`;
    const recovered = await db<{ resourceId: string; before: string; here: string | null }[]>`
      SELECT w.resource_id AS "resourceId",
        coalesce(sum(w.qty) FILTER (WHERE w.bill_id IS DISTINCT FROM ${billId}), 0)::text AS before,
        sum(w.amount) FILTER (WHERE w.bill_id = ${billId})::text AS here
      FROM acc.wo_recovery w JOIN acc.subcontract_bill b ON b.id = w.bill_id
      WHERE w.order_id = ${orderId} AND b.status <> 'cancelled'
      GROUP BY w.resource_id`;
    const resources = new Map<string, { id: string; code: string; name: string; unit: string }>();
    for (const r of await db<{ id: string; code: string; name: string; unit: string }[]>`
      SELECT id, code, name, unit FROM est.resource
      WHERE id IN ${db([...new Set([...terms.map((t) => t.resourceId), ...issued.map((i) => i.resourceId), '00000000-0000-0000-0000-000000000000'])])}`)
      resources.set(r.id, r);
    const ids = [
      ...new Set([...terms.map((t) => t.resourceId), ...issued.map((i) => i.resourceId)]),
    ];
    return ids
      .map((id) => {
        const mine = terms.filter((t) => t.resourceId === id);
        let theoretical = 0n;
        let allowed = 0n;
        for (const t of mine) {
          const use = mul(quantities.get(t.lineKey) ?? 0n, dec(t.perUnit));
          theoretical += use;
          allowed += plusPct(use, dec(t.wastagePct));
        }
        // The highest penal rate set for the material on the order applies to its excess.
        const rate = mine.reduce((m, t) => (dec(t.penalRate) > m ? dec(t.penalRate) : m), 0n);
        const i = issued.find((x) => x.resourceId === id);
        const net = i ? dec(i.issued) - dec(i.returned) : 0n;
        const excess = net > allowed ? net - allowed : 0n;
        const rec = recovered.find((x) => x.resourceId === id);
        const before = rec ? dec(rec.before) : 0n;
        const toRecover = dec(q4(mine.length && excess > before ? excess - before : 0n));
        return {
          resource: resources.get(id)!,
          issued: q4(i ? dec(i.issued) : 0n),
          returned: q4(i ? dec(i.returned) : 0n),
          theoretical: q4(theoretical),
          allowed: q4(allowed),
          excess: q4(excess),
          recoveredBefore: q4(before),
          toRecover: q4(toRecover),
          rate: q4(rate),
          amount: money(mul(toRecover, rate)),
          recoveredHere: rec?.here ?? null,
        };
      })
      .sort((a, b) => a.resource.name.localeCompare(b.resource.name));
  }

  /** The order's material terms and where it stands on all work measured so far. */
  async forOrder(claims: TenantClaims, orderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, orderId);
    await this.mayBill(db, claims, o.project_id, false);
    const measured = await db<{ lineKey: string; qty: string }[]>`
      SELECT line_key AS "lineKey", sum(qty)::text AS qty FROM acc.wo_measurement
      WHERE order_id = ${orderId} GROUP BY line_key`;
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    return {
      order: { id: o.id, number: o.number },
      terms: await this.terms(db, orderId),
      lines: await db`
        SELECT line_key AS "lineKey", description, unit FROM proc.po_line
        WHERE revision_id = ${o.revision_id} ORDER BY position`,
      rows: await this.reckon(
        db,
        orderId,
        today,
        new Map(measured.map((m) => [m.lineKey, dec(m.qty)])),
        null,
      ),
    };
  }

  async setTerms(claims: TenantClaims, orderId: string, items: MaterialTerm[]) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, orderId);
    await this.mayBill(db, claims, o.project_id, true);
    const lines = new Set(
      (
        await db<
          { line_key: string }[]
        >`SELECT line_key FROM proc.po_line WHERE revision_id = ${o.revision_id}`
      ).map((l) => l.line_key),
    );
    for (const t of items)
      if (!lines.has(t.lineKey))
        throw new BadRequestException({
          code: 'not_this_order',
          message: 'A term names a line not on the order.',
        });
    await db.begin(async (tx) => {
      await tx`DELETE FROM acc.wo_material WHERE order_id = ${orderId}`;
      for (const t of items)
        await tx`
          INSERT INTO acc.wo_material (order_id, line_key, resource_id, per_unit, wastage_pct, penal_rate)
          VALUES (${orderId}, ${t.lineKey}, ${t.resourceId}, ${t.perUnit}, ${t.wastagePct}, ${t.penalRate})`;
    });
    return this.forOrder(claims, orderId);
  }

  private async bill(db: Db, billId: string) {
    const [b] = await db<
      { id: string; order_id: string; status: string; upto: string; ra_no: number }[]
    >`
      SELECT id, order_id, status, to_char(upto, 'YYYY-MM-DD') AS upto, ra_no FROM acc.subcontract_bill
      WHERE id = ${billId}`;
    if (!b) throw new NotFoundException({ code: 'not_found' });
    return b;
  }

  /** On a bill: the work it certifies to date against the material issued by its date. */
  async forBill(claims: TenantClaims, billId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.bill(db, billId);
    const o = await this.order(db, b.order_id);
    await this.mayBill(db, claims, o.project_id, false);
    const cum = await db<{ lineKey: string; qty: string }[]>`
      SELECT line_key AS "lineKey", cum_qty::text AS qty FROM acc.subcontract_bill_line WHERE bill_id = ${billId}`;
    return {
      bill: { id: b.id, raNo: b.ra_no, upto: b.upto, status: b.status },
      rows: await this.reckon(
        db,
        b.order_id,
        b.upto,
        new Map(cum.map((c) => [c.lineKey, dec(c.qty)])),
        billId,
      ),
    };
  }

  /** Adds the excess still to recover as back-charges on a draft bill. */
  async recover(claims: TenantClaims, billId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const b0 = await this.bill(db, billId);
    const o = await this.order(db, b0.order_id);
    await this.mayBill(db, claims, o.project_id, true);
    await db.begin(async (tx) => {
      const [b] = await tx<{ status: string }[]>`
        SELECT status FROM acc.subcontract_bill WHERE id = ${billId} FOR UPDATE`;
      if (b!.status !== 'draft')
        throw new ConflictException({ code: 'not_draft', message: 'Recover on a draft bill.' });
      const view = await this.forBill(claims, billId);
      const due = view.rows.filter((r) => dec(r.amount) > 0n && r.recoveredHere === null);
      if (!due.length)
        throw new BadRequestException({
          code: 'nothing_to_recover',
          message: 'Nothing issued beyond the allowance.',
        });
      const account = await this.ledger.roleAccount(tx, o.entity_id, 'material_consumption');
      const [p] = await tx<{ n: number }[]>`
        SELECT coalesce(max(position), 0)::int AS n FROM acc.subcontract_backcharge WHERE bill_id = ${billId}`;
      for (const [i, r] of due.entries()) {
        await tx`
          INSERT INTO acc.subcontract_backcharge (bill_id, position, description, amount, account_id)
          VALUES (${billId}, ${p!.n + i + 1},
            ${`${r.resource.name}: ${Number(r.toRecover)} ${r.resource.unit} issued beyond the allowance at ₹${Number(r.rate)}`.slice(0, 200)},
            ${r.amount}, ${account})`;
        await tx`
          INSERT INTO acc.wo_recovery (order_id, bill_id, resource_id, qty, rate, amount, created_by)
          VALUES (${o.id}, ${billId}, ${r.resource.id}, ${r.toRecover}, ${r.rate}, ${r.amount}, ${claims.sub})`;
      }
      await tx`UPDATE acc.subcontract_bill SET row_version = row_version + 1, updated_at = now(),
        updated_by = ${claims.sub} WHERE id = ${billId}`;
    });
    return this.forBill(claims, billId);
  }
}
