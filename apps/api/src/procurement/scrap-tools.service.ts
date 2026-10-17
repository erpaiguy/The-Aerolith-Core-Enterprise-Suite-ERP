// Scrap and tools (docs/wave8-plan.md step 8e.5). Scrap is noted on site as it arises and sold to a scrap buyer: the
// sale bills the buyer with GST (within the state or across, by the buyer's GSTIN against the site's state) and
// credits the scrap sales ledger. Returnable tools go to a person or gang until a date; what comes back, what is
// lost, and what is overdue.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { LedgerService } from '../accounts/ledger.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt, mul } from '../rates/decimal.js';
import { nextNumber } from '../tender/numbering.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export interface ScrapSaleInput {
  partyId: string;
  siteId: string;
  soldOn: string;
  lines: { material: string; unit: string; qty: string; rate: string; gstPct: string }[];
}

@Injectable()
export class ScrapToolsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
  ) {}

  private async must(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member' && a.role !== 'lead')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team keeps its scrap and tools.",
      });
    if (!(await this.permissions.can(claims, 'stores.manage')))
      throw new ForbiddenException({ code: 'permission_denied', permission: 'stores.manage' });
  }

  // --- scrap ---

  /** What scrap is on hand, material by material: noted less sold. */
  private balances(db: Db, projectId: string) {
    return db<{ material: string; unit: string; noted: string; sold: string; onHand: string }[]>`
      WITH noted AS (
        SELECT lower(material) AS m, lower(unit) AS u, min(material) AS material, min(unit) AS unit, sum(qty) AS qty
        FROM proc.scrap_entry WHERE project_id = ${projectId} GROUP BY 1, 2
      ),
      sold AS (
        SELECT lower(l.material) AS m, lower(l.unit) AS u, sum(l.qty) AS qty
        FROM proc.scrap_sale_line l JOIN proc.scrap_sale s ON s.id = l.sale_id
        WHERE s.project_id = ${projectId} GROUP BY 1, 2
      )
      SELECT n.material, n.unit, n.qty::text AS noted, coalesce(s.qty, 0)::text AS sold,
        (n.qty - coalesce(s.qty, 0))::text AS "onHand"
      FROM noted n LEFT JOIN sold s ON s.m = n.m AND s.u = n.u ORDER BY n.material`;
  }

  async scrap(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const [entries, sales] = await Promise.all([
      db`
        SELECT e.id, e.material, e.unit, e.qty::text AS qty, e.source, to_char(e.noted_on, 'YYYY-MM-DD') AS "notedOn",
          e.note, u.display_name AS by
        FROM proc.scrap_entry e LEFT JOIN platform."user" u ON u.id = e.created_by
        WHERE e.project_id = ${projectId} ORDER BY e.noted_on DESC, e.created_at DESC LIMIT 100`,
      db`
        SELECT s.id, s.number, pa.name AS buyer, to_char(s.sold_on, 'YYYY-MM-DD') AS "soldOn", s.amount::text AS amount,
          (s.cgst + s.sgst + s.igst)::text AS gst, s.total::text AS total, v.number AS voucher
        FROM proc.scrap_sale s JOIN platform.party pa ON pa.id = s.party_id JOIN acc.voucher v ON v.id = s.voucher_id
        WHERE s.project_id = ${projectId} ORDER BY s.sold_on DESC, s.number DESC`,
    ]);
    const a = await this.projects.access(db, claims, projectId);
    return {
      balances: await this.balances(db, projectId),
      entries,
      sales,
      mayManage:
        (a.canEdit || a.role === 'member' || a.role === 'lead') &&
        (await this.permissions.can(claims, 'stores.manage')),
    };
  }

  async noteScrap(
    claims: TenantClaims,
    projectId: string,
    input: {
      material: string;
      unit: string;
      qty: string;
      source: string;
      notedOn: string;
      note: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.must(db, claims, projectId);
    if (input.notedOn > indiaToday())
      throw new BadRequestException({ code: 'future', message: 'Scrap is noted when it arises.' });
    await db.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        INSERT INTO proc.scrap_entry (project_id, material, unit, qty, source, noted_on, note, created_by)
        VALUES (${projectId}, ${input.material}, ${input.unit}, ${input.qty}, ${input.source}, ${input.notedOn},
          ${input.note}, ${claims.sub}) RETURNING id`;
      await audit(tx, claims.sub, 'scrap.note', 'scrap_entry', e!.id, { ...input });
    });
    return this.scrap(claims, projectId);
  }

  /** Sells scrap on hand to a buyer: the buyer Dr, scrap sales Cr, output GST Cr. */
  async sell(claims: TenantClaims, projectId: string, input: ScrapSaleInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.must(db, claims, projectId);
    if (!input.lines.length)
      throw new BadRequestException({ code: 'no_lines', message: 'Say what is sold.' });
    if (input.soldOn > indiaToday())
      throw new BadRequestException({ code: 'future', message: 'Not sold yet.' });
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'scrap ' + projectId}))`;
      const [p] = await tx<{ entity_id: string; number: string }[]>`
        SELECT entity_id, number FROM proj.project WHERE id = ${projectId}`;
      const [site] = await tx<{ state_code: string | null }[]>`
        SELECT state_code FROM proj.site WHERE id = ${input.siteId} AND project_id = ${projectId}`;
      if (!site)
        throw new BadRequestException({
          code: 'site_not_found',
          message: "Choose one of the project's sites.",
        });
      const [buyer] = await tx<{ name: string; gstin: string | null }[]>`
        SELECT name, gstin FROM platform.party WHERE id = ${input.partyId} AND deleted_at IS NULL`;
      if (!buyer) throw new BadRequestException({ code: 'party_not_found' });
      const onHand = new Map(
        (await this.balances(tx, projectId)).map((b) => [
          `${b.material.toLowerCase()}|${b.unit.toLowerCase()}`,
          dec(b.onHand),
        ]),
      );
      const inter =
        !!buyer.gstin && !!site.state_code && buyer.gstin.slice(0, 2) !== site.state_code;
      let [amount, cgst, sgst, igst] = [0n, 0n, 0n, 0n];
      const lines = input.lines.map((l, i) => {
        const k = `${l.material.toLowerCase()}|${l.unit.toLowerCase()}`;
        const left = onHand.get(k) ?? 0n;
        if (dec(l.qty) > left)
          throw new ConflictException({
            code: 'more_than_on_hand',
            message: `${l.material}: ${fmt(left, 4, 0)} ${l.unit} of scrap is on hand.`,
          });
        onHand.set(k, left - dec(l.qty));
        const a = dec(fmt(mul(dec(l.qty), dec(l.rate)), 2));
        const tax = (pct: number) => dec(fmt((a * dec(String(pct))) / dec('100'), 2));
        if (inter) igst += tax(Number(l.gstPct));
        else {
          cgst += tax(Number(l.gstPct) / 2);
          sgst += tax(Number(l.gstPct) / 2);
        }
        amount += a;
        return { position: i + 1, ...l, amount: fmt(a, 2) };
      });
      const total = amount + cgst + sgst + igst;
      const number = await nextNumber(tx, 'scrap_sale', p!.entity_id, 'SCR', new Date());
      const saleId = randomUUID();
      const line = (
        accountId: string | null,
        partyId: string | null,
        debit: bigint,
        credit: bigint,
        note: string,
      ) => ({
        accountId,
        partyId,
        debit: fmt(debit, 2),
        credit: fmt(credit, 2),
        projectId,
        siteId: input.siteId,
        costCodeId: null,
        note,
      });
      const role = (r: Parameters<LedgerService['roleAccount']>[2]) =>
        this.ledger.roleAccount(tx, p!.entity_id, r);
      const note = `Scrap sale ${number} to ${buyer.name}`;
      const vlines = [
        line(null, input.partyId, total, 0n, note),
        line(await role('scrap_sales'), null, 0n, amount, note),
        ...(cgst ? [line(await role('output_cgst'), null, 0n, cgst, note)] : []),
        ...(sgst ? [line(await role('output_sgst'), null, 0n, sgst, note)] : []),
        ...(igst ? [line(await role('output_igst'), null, 0n, igst, note)] : []),
      ];
      const v = await this.ledger.post(
        tx,
        claims,
        {
          entityId: p!.entity_id,
          type: 'sales',
          date: input.soldOn,
          narration: `${note}, ${p!.number}`,
          reference: number,
          lines: vlines,
        },
        { kind: 'scrap_sale', id: saleId },
      );
      await tx`
        INSERT INTO proc.scrap_sale (id, project_id, site_id, number, party_id, sold_on, amount, cgst, sgst, igst, total,
          voucher_id, created_by)
        VALUES (${saleId}, ${projectId}, ${input.siteId}, ${number}, ${input.partyId}, ${input.soldOn}, ${fmt(amount, 2)},
          ${fmt(cgst, 2)}, ${fmt(sgst, 2)}, ${fmt(igst, 2)}, ${fmt(total, 2)}, ${v!.id}, ${claims.sub})`;
      for (const l of lines)
        await tx`
          INSERT INTO proc.scrap_sale_line (sale_id, position, material, unit, qty, rate, gst_pct, amount)
          VALUES (${saleId}, ${l.position}, ${l.material}, ${l.unit}, ${l.qty}, ${l.rate}, ${l.gstPct}, ${l.amount})`;
      await audit(tx, claims.sub, 'scrap.sale', 'scrap_sale', saleId, {
        number,
        total: fmt(total, 2),
      });
      return saleId;
    });
    return { id, ...(await this.scrap(claims, projectId)) };
  }

  // --- returnable tools ---

  async tools(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    const today = indiaToday();
    const issues = await db`
      SELECT id, tool, qty, issued_to AS "issuedTo", to_char(issued_on, 'YYYY-MM-DD') AS "issuedOn",
        to_char(due_on, 'YYYY-MM-DD') AS "dueOn", returned_qty AS returned, lost_qty AS lost,
        qty - returned_qty - lost_qty AS out, to_char(closed_on, 'YYYY-MM-DD') AS "closedOn", note,
        closed_on IS NULL AND due_on < ${today} AS overdue
      FROM proc.tool_issue WHERE project_id = ${projectId}
      ORDER BY closed_on IS NOT NULL, due_on, tool`;
    return {
      issues,
      mayManage:
        (a.canEdit || a.role === 'member' || a.role === 'lead') &&
        (await this.permissions.can(claims, 'stores.manage')),
    };
  }

  async issueTool(
    claims: TenantClaims,
    projectId: string,
    input: {
      tool: string;
      qty: number;
      issuedTo: string;
      issuedOn: string;
      dueOn: string;
      note: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.must(db, claims, projectId);
    if (input.dueOn < input.issuedOn)
      throw new BadRequestException({
        code: 'due_before_issue',
        message: 'Due back before it was issued.',
      });
    await db.begin(async (tx) => {
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO proc.tool_issue (project_id, tool, qty, issued_to, issued_on, due_on, note, created_by)
        VALUES (${projectId}, ${input.tool}, ${input.qty}, ${input.issuedTo}, ${input.issuedOn}, ${input.dueOn},
          ${input.note}, ${claims.sub}) RETURNING id`;
      await audit(tx, claims.sub, 'tool.issue', 'tool_issue', t!.id, { ...input });
    });
    return this.tools(claims, projectId);
  }

  /** Back in (some or all), or lost; the issue closes when nothing is still out. */
  async returnTool(
    claims: TenantClaims,
    id: string,
    input: { returned: number; lost: number; on: string; note: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db<
      {
        project_id: string;
        qty: number;
        returned_qty: number;
        lost_qty: number;
        closed_on: string | null;
      }[]
    >`
      SELECT project_id, qty, returned_qty, lost_qty, closed_on FROM proc.tool_issue WHERE id = ${id}`;
    if (!t) throw new NotFoundException({ code: 'not_found' });
    await this.must(db, claims, t.project_id);
    if (t.closed_on)
      throw new ConflictException({ code: 'closed', message: 'All of it is accounted for.' });
    const out = t.qty - t.returned_qty - t.lost_qty;
    if (input.returned + input.lost < 1 || input.returned + input.lost > out)
      throw new BadRequestException({ code: 'bad_qty', message: `${out} are still out.` });
    if (input.lost > 0 && input.note.trim().length < 3)
      throw new BadRequestException({ code: 'reason_needed', message: 'Say how they were lost.' });
    await db.begin(async (tx) => {
      await tx`
        UPDATE proc.tool_issue SET returned_qty = returned_qty + ${input.returned}, lost_qty = lost_qty + ${input.lost},
          closed_on = CASE WHEN qty = returned_qty + ${input.returned} + lost_qty + ${input.lost} THEN ${input.on}::date END,
          note = CASE WHEN ${input.note} = '' THEN note ELSE left(${input.note}, 500) END
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'tool.return', 'tool_issue', id, { ...input });
    });
    return this.tools(claims, t.project_id);
  }

  /** Tools not back by their day, across the projects a person sees. */
  async overdueTools(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const all = claims.role === 'admin' || (await this.permissions.can(claims, 'projects.all'));
    return db`
      SELECT t.id, p.id AS "projectId", p.number AS project, t.tool, t.qty - t.returned_qty - t.lost_qty AS out,
        t.issued_to AS "issuedTo", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn", (${indiaToday()}::date - t.due_on) AS "daysLate"
      FROM proc.tool_issue t JOIN proj.project p ON p.id = t.project_id
      WHERE t.closed_on IS NULL AND t.due_on < ${indiaToday()}
        AND ${all ? db`true` : db`EXISTS (SELECT 1 FROM proj.member m WHERE m.project_id = p.id AND m.user_id = ${claims.sub})`}
      ORDER BY t.due_on, p.number`;
  }
}
