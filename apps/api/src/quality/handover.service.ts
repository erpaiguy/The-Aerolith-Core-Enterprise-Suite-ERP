// Handover and defect liability (docs/wave8-plan.md step 8d.3). A unit or area goes to the client against a checklist,
// once no snag is open in it, with a handover certificate; defects the client reports in the liability period are
// logged against the contract until put right; and the period's end shows what it releases (the retention held and the
// performance guarantee). Snags with a back-charge go onto the responsible subcontractor's next draft bill.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { LedgerService } from '../accounts/ledger.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

@Injectable()
export class HandoverService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly ledger: LedgerService,
  ) {}

  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team hands over its work.",
      });
  }

  // --- handover ---

  async handovers(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return this.listHandovers(db, projectId);
  }

  private listHandovers(db: Db, projectId: string) {
    return db`
      SELECT h.id, h.number, h.area, h.handed_to AS "handedTo", h.checklist, h.status,
        to_char(h.handed_on, 'YYYY-MM-DD') AS "handedOn",
        (SELECT count(*)::int FROM qa.snag s WHERE s.project_id = h.project_id AND lower(s.area) = lower(h.area)
          AND s.status <> 'closed') AS "openSnags"
      FROM qa.handover h WHERE h.project_id = ${projectId} ORDER BY h.number`;
  }

  async addHandover(
    claims: TenantClaims,
    projectId: string,
    input: {
      area: string;
      handedTo: string;
      checklist: { item: string; ok: boolean; note: string }[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'handover ' + projectId}))`;
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int + 1 AS n FROM qa.handover WHERE project_id = ${projectId}`;
      await tx`
        INSERT INTO qa.handover (project_id, number, area, handed_to, checklist, created_by)
        VALUES (${projectId}, ${`HO-${String(n!.n).padStart(3, '0')}`}, ${input.area}, ${input.handedTo},
          ${tx.json(input.checklist)}, ${claims.sub})`;
    });
    return this.listHandovers(db, projectId);
  }

  /** Ticks (or unticks) one item of a draft handover's checklist. */
  async check(claims: TenantClaims, id: string, index: number, ok: boolean) {
    const db = await this.tenants.forTenant(claims.ten);
    const [h] = await db<{ project_id: string; status: string; items: number }[]>`
      SELECT project_id, status, jsonb_array_length(checklist) AS items FROM qa.handover WHERE id = ${id}`;
    if (!h) throw new NotFoundException({ code: 'not_found' });
    await this.team(db, claims, h.project_id);
    if (h.status !== 'draft')
      throw new ConflictException({ code: 'handed_over', message: 'Already handed over.' });
    if (index >= h.items) throw new BadRequestException({ code: 'no_such_item' });
    await db`
      UPDATE qa.handover SET checklist = jsonb_set(checklist, ${[String(index), 'ok']}, ${db.json(ok)})
      WHERE id = ${id}`;
    return this.listHandovers(db, h.project_id);
  }

  /** Handed over: every item checked and no snag open in the area. */
  async handOver(claims: TenantClaims, id: string, on: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [h] = await db<
      {
        project_id: string;
        area: string;
        status: string;
        checklist: { item: string; ok: boolean }[];
      }[]
    >`SELECT project_id, area, status, checklist FROM qa.handover WHERE id = ${id}`;
    if (!h) throw new NotFoundException({ code: 'not_found' });
    await this.team(db, claims, h.project_id);
    if (h.status !== 'draft')
      throw new ConflictException({ code: 'handed_over', message: 'Already handed over.' });
    const notOk = h.checklist.filter((c) => !c.ok).map((c) => c.item);
    if (notOk.length)
      throw new BadRequestException({
        code: 'checklist_open',
        message: `Not yet checked: ${notOk.join(', ')}.`,
      });
    const [s] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM qa.snag WHERE project_id = ${h.project_id} AND lower(area) = lower(${h.area})
        AND status <> 'closed'`;
    if (s!.n)
      throw new ConflictException({
        code: 'snags_open',
        message: `${s!.n} snag${s!.n === 1 ? ' is' : 's are'} still open in ${h.area}.`,
      });
    await db.begin(async (tx) => {
      await tx`UPDATE qa.handover SET status = 'handed_over', handed_on = ${on} WHERE id = ${id}`;
      await audit(tx, claims.sub, 'quality.handover', 'handover', id, { on });
    });
    return this.listHandovers(db, h.project_id);
  }

  /** The handover certificate's data. */
  async certificate(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [h] = await db<Record<string, unknown>[]>`
      SELECT h.id, h.number, h.area, h.handed_to AS "handedTo", h.checklist, h.status,
        to_char(h.handed_on, 'YYYY-MM-DD') AS "handedOn", p.id AS "projectId", p.number AS "projectNumber",
        p.name AS project, p.entity_id AS "entityId"
      FROM qa.handover h JOIN proj.project p ON p.id = h.project_id WHERE h.id = ${id}`;
    if (!h) throw new NotFoundException({ code: 'not_found' });
    await this.projects.access(db, claims, h.projectId as string);
    return h;
  }

  // --- defect liability ---

  /** Each client contract's liability period: when it ends, what is open, and what its end releases. */
  async dlp(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const contracts = await db<
      {
        id: string;
        reference: string;
        completionOn: string | null;
        endsOn: string | null;
        dlpMonths: number;
      }[]
    >`
      SELECT id, reference, to_char(completion_on, 'YYYY-MM-DD') AS "completionOn", dlp_months AS "dlpMonths",
        CASE WHEN completion_on IS NULL THEN NULL
          ELSE to_char(completion_on + make_interval(months => dlp_months), 'YYYY-MM-DD') END AS "endsOn"
      FROM ctl.contract WHERE project_id = ${projectId} AND kind = 'client' ORDER BY reference`;
    const [held] = await db<{ held: string; released: string }[]>`
      SELECT
        coalesce((SELECT sum((b.certified ->> 'retention')::numeric) FROM acc.client_bill b
          WHERE b.project_id = ${projectId} AND b.status = 'certified'), 0)::numeric(20,2)::text AS held,
        coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id
          WHERE a.project_id = ${projectId} AND a.kind = 'retention' AND r.status = 'posted'), 0)::numeric(20,2)::text
          AS released`;
    const securities = await db<
      { contractId: string; kind: string; number: string; amount: string; validUntil: string }[]
    >`
      SELECT s.contract_id AS "contractId", s.kind, s.number, s.amount::text, to_char(s.valid_until, 'YYYY-MM-DD') AS "validUntil"
      FROM ctl.security s JOIN ctl.contract c ON c.id = s.contract_id
      WHERE c.project_id = ${projectId} AND s.status = 'held' AND s.kind IN ('performance', 'retention_bond')`;
    const defects = await this.listDefects(db, projectId);
    const today = indiaToday();
    return {
      projectId,
      retention: {
        held: held!.held,
        released: held!.released,
        due: (Number(held!.held) - Number(held!.released)).toFixed(2),
      },
      contracts: contracts.map((c) => ({
        ...c,
        state: !c.endsOn ? 'not_complete' : c.endsOn < today ? 'ended' : 'running',
        securities: securities.filter((s) => s.contractId === c.id),
        openDefects: defects.filter(
          (d) => d.status === 'open' && (d.contractId === c.id || d.contractId === null),
        ).length,
      })),
      defects,
    };
  }

  private listDefects(db: Db, projectId: string) {
    return db<
      {
        id: string;
        contractId: string | null;
        area: string;
        description: string;
        reportedOn: string;
        reportedBy: string;
        responsible: string | null;
        status: string;
        fixedOn: string | null;
      }[]
    >`
      SELECT d.id, d.contract_id AS "contractId", d.area, d.description, to_char(d.reported_on, 'YYYY-MM-DD') AS "reportedOn",
        d.reported_by AS "reportedBy", pa.name AS responsible, d.status, to_char(d.fixed_on, 'YYYY-MM-DD') AS "fixedOn"
      FROM qa.defect d LEFT JOIN platform.party pa ON pa.id = d.responsible_party_id
      WHERE d.project_id = ${projectId} ORDER BY d.status, d.reported_on`;
  }

  async reportDefect(
    claims: TenantClaims,
    projectId: string,
    input: {
      contractId: string | null;
      area: string;
      description: string;
      reportedOn: string;
      reportedBy: string;
      responsiblePartyId: string | null;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    await db`
      INSERT INTO qa.defect (project_id, contract_id, area, description, reported_on, reported_by, responsible_party_id,
        created_by)
      VALUES (${projectId}, ${input.contractId}, ${input.area}, ${input.description}, ${input.reportedOn},
        ${input.reportedBy}, ${input.responsiblePartyId}, ${claims.sub})`;
    return this.dlp(claims, projectId);
  }

  async fixDefect(claims: TenantClaims, id: string, on: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [d] = await db<{ project_id: string; status: string }[]>`
      SELECT project_id, status FROM qa.defect WHERE id = ${id}`;
    if (!d) throw new NotFoundException({ code: 'not_found' });
    await this.team(db, claims, d.project_id);
    if (d.status === 'fixed')
      throw new ConflictException({ code: 'already_fixed', message: 'Already fixed.' });
    await db`UPDATE qa.defect SET status = 'fixed', fixed_on = ${on} WHERE id = ${id}`;
    return this.dlp(claims, d.project_id);
  }

  // --- back-charges from snags ---

  /** The snags with a back-charge on the subcontractor of a draft bill, not yet charged. */
  static pendingBackcharges(db: Db, projectId: string, partyId: string) {
    return db<{ id: string; area: string; description: string; backcharge: string }[]>`
      SELECT id, area, description, backcharge::text FROM qa.snag
      WHERE project_id = ${projectId} AND responsible_party_id = ${partyId} AND backcharge IS NOT NULL
        AND backcharged_bill_id IS NULL ORDER BY created_at`;
  }

  /** Puts the snags' back-charges on a draft subcontract bill, credited to subcontract cost. */
  async chargeSnags(claims: TenantClaims, billId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const [b] = await tx<
        { status: string; project_id: string; party_id: string; entity_id: string }[]
      >`
        SELECT b.status, o.project_id, o.party_id, p.entity_id FROM acc.subcontract_bill b
        JOIN proc.purchase_order o ON o.id = b.order_id JOIN proj.project p ON p.id = o.project_id
        WHERE b.id = ${billId} FOR UPDATE OF b`;
      if (!b) throw new NotFoundException({ code: 'bill_not_found' });
      await this.team(tx, claims, b.project_id);
      if (b.status !== 'draft')
        throw new ConflictException({
          code: 'not_draft',
          message: 'Back-charges go on a draft bill.',
        });
      const snags = await HandoverService.pendingBackcharges(tx, b.project_id, b.party_id);
      if (!snags.length)
        throw new BadRequestException({ code: 'nothing_to_charge', message: 'No snag to charge.' });
      const account = await this.ledger.roleAccount(tx, b.entity_id, 'subcontract_cost');
      const [last] = await tx<{ n: number }[]>`
        SELECT coalesce(max(position), 0)::int AS n FROM acc.subcontract_backcharge WHERE bill_id = ${billId}`;
      let n = last!.n;
      for (const s of snags) {
        await tx`INSERT INTO acc.subcontract_backcharge (bill_id, position, description, amount, account_id)
          VALUES (${billId}, ${++n}, ${`Snag (${s.area}): ${s.description}`.slice(0, 200)}, ${s.backcharge}, ${account})`;
        await tx`UPDATE qa.snag SET backcharged_bill_id = ${billId} WHERE id = ${s.id}`;
      }
      await tx`UPDATE acc.subcontract_bill SET row_version = row_version + 1 WHERE id = ${billId}`;
      await audit(tx, claims.sub, 'quality.snag_backcharge', 'subcontract_bill', billId, {
        snags: snags.length,
      });
      return { charged: snags.length };
    });
  }
}
