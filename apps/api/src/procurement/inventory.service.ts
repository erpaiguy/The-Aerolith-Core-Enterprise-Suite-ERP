// Inventory (docs/04-features.md R5, docs/wave2b-plan.md step 6): stores at a project's sites and what moves through
// them. Accepted receipt lines come in (receipt.service.ts); issue slips take material out to a WBS element; unused
// material comes back against its issue; transfers go out of one store, travel, and come into another; a stock take
// counts what is there and, once approved, adjusts the book. Every movement goes through the stock ledger.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { ApprovalService, indiaToday, type Outcome } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService, type Permission } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt, type Dec } from '../rates/decimal.js';
import { nextNumber } from '../tender/numbering.js';
import { audit } from '../tender/tender-records.js';
import { RequisitionService } from './requisition.service.js';
import {
  paise,
  share,
  stockIn,
  stockOut,
  unitCost,
  valuation,
  VALUATION_KEY,
  type Valuation,
} from './stock-ledger.js';

type Db = Sql | TransactionSql;
export const STOCK_ADJUSTMENT = 'stock_adjustment';

interface StoreRow {
  id: string;
  project_id: string;
  site_id: string;
  name: string;
  active: boolean;
}

export interface IssueInput {
  issuedOn: string;
  wbsCode: string;
  issuedTo: string;
  purpose: string;
  lines: { resourceId: string; qty: string; boqCode: string | null }[];
  /** The machine the fuel or spares went to (docs/wave3-plan.md step 10). */
  equipmentId?: string | null;
  /** The subcontractor's work order the material is issued against (docs/wave8-plan.md step 8a.3). */
  orderId?: string | null;
}
export interface TransferInput {
  toStoreId: string;
  sentOn: string;
  note: string;
  /** The lorry and its papers (step 8e.3). */
  vehicleNo?: string | null | undefined;
  transporter?: string | null | undefined;
  ewayBillNo?: string | null | undefined;
  lines: { resourceId: string; qty: string }[];
}
export interface CountInput {
  countedOn: string;
  notes: string;
  lines: { resourceId: string; counted: string; reason: string }[];
}

const q4 = (v: Dec) => fmt(v, 4);
const notFuture = (d: string) => {
  if (d > indiaToday())
    throw new BadRequestException({ code: 'in_future', message: 'Not a date in the future.' });
};

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
    private readonly approvals: ApprovalService,
    private readonly requisitions: RequisitionService,
  ) {}

  onModuleInit() {
    this.approvals.register(STOCK_ADJUSTMENT, {
      label: 'Stock adjustment',
      projectScoped: true,
      link: (countId) => `/stock-counts/${countId}`,
      decided: (tx, id, outcome, claims, comment) => this.decided(tx, id, outcome, claims, comment),
      summary: (db, id) => this.countDetail(db, id),
      canSee: async (db, claims, id) => {
        const [r] = await db<{ project_id: string }[]>`
          SELECT s.project_id FROM proc.stock_count c JOIN proc.store s ON s.id = c.store_id WHERE c.id = ${id}`;
        if (!r) return false;
        return this.projects.access(db, claims, r.project_id).then(
          () => true,
          () => false,
        );
      },
    });
  }

  // --- who may ---

  private async may(db: Db, claims: TenantClaims, projectId: string, permission: Permission) {
    const a = await this.projects.access(db, claims, projectId);
    return (
      (a.canEdit || a.role === 'member' || a.role === 'lead') &&
      (await this.permissions.can(claims, permission))
    );
  }

  private async must(db: Db, claims: TenantClaims, projectId: string, permission: Permission) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member' && a.role !== 'lead')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) works its stores.",
      });
    if (!(await this.permissions.can(claims, permission)))
      throw new ForbiddenException({ code: 'permission_denied', permission });
  }

  private async store(db: Db, id: string) {
    const [s] = await db<StoreRow[]>`SELECT * FROM proc.store WHERE id = ${id}`;
    if (!s) throw new NotFoundException({ code: 'store_not_found' });
    return s;
  }

  private async entityOf(tx: TransactionSql, projectId: string) {
    const [p] = await tx<
      { entity_id: string }[]
    >`SELECT entity_id FROM proj.project WHERE id = ${projectId}`;
    return p!.entity_id;
  }

  // --- valuation method ---

  async getValuation(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const [moved] = await db`SELECT 1 FROM proc.stock_move LIMIT 1`;
    return { method: await valuation(db), changeable: !moved };
  }

  /** Chosen once, before anything moves: changing it later would rewrite every value already in the book. */
  async setValuation(claims: TenantClaims, method: Valuation) {
    if (claims.role !== 'admin')
      throw new ForbiddenException({ code: 'admin_only', message: 'Only the admin sets this.' });
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [moved] = await tx`SELECT 1 FROM proc.stock_move LIMIT 1`;
      if (moved)
        throw new ConflictException({
          code: 'stock_has_moved',
          message: 'Stock has already moved: the valuation method is fixed.',
        });
      await tx`INSERT INTO platform.setting (key, value) VALUES (${VALUATION_KEY}, ${tx.json(method)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      await audit(tx, claims.sub, 'stock.valuation', 'setting', VALUATION_KEY, { method });
    });
    return this.getValuation(claims);
  }

  // --- stores ---

  /**
   * The store a receipt at a site goes into: the one chosen, else the site's only active store, else a new one named
   * after the site. Null when the site has several and none was chosen.
   */
  async storeForReceipt(
    tx: TransactionSql,
    claims: TenantClaims,
    projectId: string,
    siteId: string | null,
    storeId: string | null,
  ) {
    if (storeId) {
      const [s] = await tx<StoreRow[]>`
        SELECT * FROM proc.store WHERE id = ${storeId} AND project_id = ${projectId} AND active`;
      if (!s)
        throw new BadRequestException({
          code: 'store_not_found',
          message: "Choose one of the project's stores.",
        });
      return s.id;
    }
    if (!siteId) return null;
    const stores = await tx<{ id: string }[]>`
      SELECT id FROM proc.store WHERE site_id = ${siteId} AND active ORDER BY created_at`;
    if (stores.length === 1) return stores[0]!.id;
    if (stores.length > 1) return null;
    const [site] = await tx<{ name: string }[]>`SELECT name FROM proj.site WHERE id = ${siteId}`;
    const [s] = await tx<{ id: string }[]>`
      INSERT INTO proc.store (project_id, site_id, name, created_by)
      VALUES (${projectId}, ${siteId}, ${`${site!.name} store`.slice(0, 200)}, ${claims.sub})
      ON CONFLICT DO NOTHING RETURNING id`;
    if (s) return s.id;
    const [again] = await tx<{ id: string }[]>`
      SELECT id FROM proc.store WHERE project_id = ${projectId} AND lower(name) = lower(${`${site!.name} store`})`;
    return again!.id;
  }

  async createStore(
    claims: TenantClaims,
    projectId: string,
    input: { siteId: string; name: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.must(db, claims, projectId, 'stores.manage');
    const [site] =
      await db`SELECT 1 FROM proj.site WHERE id = ${input.siteId} AND project_id = ${projectId}`;
    if (!site)
      throw new BadRequestException({
        code: 'site_not_found',
        message: "Choose one of the project's sites.",
      });
    const id = await db.begin(async (tx) => {
      const [s] = await tx<{ id: string }[]>`
        INSERT INTO proc.store (project_id, site_id, name, created_by)
        VALUES (${projectId}, ${input.siteId}, ${input.name}, ${claims.sub})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!s)
        throw new ConflictException({
          code: 'store_exists',
          message: 'The project has a store by that name.',
        });
      await audit(tx, claims.sub, 'store.create', 'store', s.id, input);
      return s.id;
    });
    return this.getStore(claims, id);
  }

  /**
   * A company's central store, not tied to a project (docs/wave8-plan.md step 8e.3): kept on the company's "central
   * stores" project, made with its yard as the site the first time, which every member of staff works as its team.
   */
  async createCentralStore(
    claims: TenantClaims,
    input: { entityId: string; name: string; yard: string; stateCode: string | null },
  ) {
    if (!(await this.permissions.can(claims, 'stores.manage')))
      throw new ForbiddenException({ code: 'permission_denied', permission: 'stores.manage' });
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'central ' + input.entityId}))`;
      const [e] = await tx`SELECT 1 FROM platform.entity WHERE id = ${input.entityId}`;
      if (!e) throw new BadRequestException({ code: 'entity_not_found' });
      let [p] = await tx<{ id: string }[]>`
        SELECT id FROM proj.project WHERE entity_id = ${input.entityId} AND is_central`;
      if (!p) {
        const [n] = await tx<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM proj.project WHERE is_central`;
        [p] = await tx<{ id: string }[]>`
          INSERT INTO proj.project (entity_id, number, name, status, is_central, created_by, updated_by)
          VALUES (${input.entityId}, ${`CENTRAL-${n!.n + 1}`}, 'Central stores', 'active', true, ${claims.sub},
            ${claims.sub})
          RETURNING id`;
      }
      let [site] = await tx<{ id: string }[]>`
        SELECT id FROM proj.site WHERE project_id = ${p!.id} AND lower(name) = lower(${input.yard})`;
      site ??= (
        await tx<{ id: string }[]>`
          INSERT INTO proj.site (project_id, name, state_code) VALUES (${p!.id}, ${input.yard}, ${input.stateCode})
          RETURNING id`
      )[0];
      const [st] = await tx<{ id: string }[]>`
        INSERT INTO proc.store (project_id, site_id, name, created_by)
        VALUES (${p!.id}, ${site!.id}, ${input.name}, ${claims.sub})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!st)
        throw new ConflictException({
          code: 'store_exists',
          message: 'There is a central store by that name.',
        });
      await audit(tx, claims.sub, 'store.create', 'store', st.id, { ...input, central: true });
      return st.id;
    });
    return this.getStore(claims, id);
  }

  async listStores(claims: TenantClaims, projectId?: string) {
    const db = await this.tenants.forTenant(claims.ten);
    if (projectId) await this.projects.access(db, claims, projectId);
    const all = claims.role === 'admin' || (await this.permissions.can(claims, 'projects.all'));
    return db`
      SELECT s.id, s.name, s.active, p.is_central AS central,
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('id', t.id, 'name', t.name) AS site,
        coalesce((SELECT sum(b.value) FROM proc.stock_balance b WHERE b.store_id = s.id), 0)::text AS value,
        (SELECT count(*)::int FROM proc.stock_balance b WHERE b.store_id = s.id AND b.qty > 0) AS items,
        (SELECT count(*)::int FROM proc.reorder_level r JOIN proc.stock_balance b
          ON b.store_id = r.store_id AND b.resource_id = r.resource_id
          WHERE r.store_id = s.id AND b.qty < r.level) AS below
      FROM proc.store s JOIN proj.project p ON p.id = s.project_id JOIN proj.site t ON t.id = s.site_id
      WHERE ${
        all
          ? db`true`
          : db`(p.is_central OR EXISTS (SELECT 1 FROM proj.member m WHERE m.project_id = s.project_id
              AND m.user_id = ${claims.sub}))`
      }
        ${projectId ? db`AND s.project_id = ${projectId}` : db``}
      ORDER BY p.number, s.name`;
  }

  async getStore(claims: TenantClaims, storeId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.store(db, storeId);
    await this.projects.access(db, claims, s.project_id);
    const [head] = await db`
      SELECT s.id, s.name, s.active, p.is_central AS central,
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('id', t.id, 'name', t.name) AS site
      FROM proc.store s JOIN proj.project p ON p.id = s.project_id JOIN proj.site t ON t.id = s.site_id
      WHERE s.id = ${storeId}`;
    // Every resource that has been in the store or has a reorder level.
    const stock = await db`
      SELECT r.id AS "resourceId", r.code, r.name, r.unit, coalesce(b.qty, 0)::text AS qty,
        coalesce(b.value, 0)::text AS value,
        CASE WHEN coalesce(b.qty, 0) > 0 THEN round(b.value / b.qty, 4)::text END AS rate,
        l.level::text AS "reorderLevel", (l.level IS NOT NULL AND coalesce(b.qty, 0) < l.level) AS below
      FROM est.resource r
      LEFT JOIN proc.stock_balance b ON b.resource_id = r.id AND b.store_id = ${storeId}
      LEFT JOIN proc.reorder_level l ON l.resource_id = r.id AND l.store_id = ${storeId}
      WHERE b.store_id IS NOT NULL OR l.store_id IS NOT NULL
      ORDER BY r.code`;
    const moves = await db`
      SELECT m.id::text AS id, to_char(m.moved_on, 'YYYY-MM-DD') AS "movedOn", m.kind, r.code, r.name, r.unit,
        m.qty::text AS qty, m.value::text AS value, m.doc_type AS "docType", m.doc_id AS "docId",
        m.doc_number AS "docNumber"
      FROM proc.stock_move m JOIN est.resource r ON r.id = m.resource_id
      WHERE m.store_id = ${storeId} ORDER BY m.id DESC LIMIT 50`;
    const transfers = await db`
      SELECT t.id, t.number, t.status, to_char(t.sent_on, 'YYYY-MM-DD') AS "sentOn",
        (t.to_store_id = ${storeId}) AS incoming, f.name AS "fromStore", d.name AS "toStore"
      FROM proc.stock_transfer t JOIN proc.store f ON f.id = t.from_store_id JOIN proc.store d ON d.id = t.to_store_id
      WHERE (t.from_store_id = ${storeId} OR t.to_store_id = ${storeId}) AND t.status = 'in_transit'
      ORDER BY t.sent_on`;
    const [count] = await db<{ id: string; number: string; status: string }[]>`
      SELECT id, number, status FROM proc.stock_count
      WHERE store_id = ${storeId} AND status IN ('draft', 'submitted', 'rejected')`;
    const mayIssue = s.active && (await this.may(db, claims, s.project_id, 'stores.receive'));
    const mayManage = s.active && (await this.may(db, claims, s.project_id, 'stores.manage'));
    return {
      ...head!,
      valuation: await valuation(db),
      stock,
      moves,
      transfers,
      openCount: count ?? null,
      mayIssue,
      mayManage,
    };
  }

  /** A resource's movements in a store, oldest first, with the running balance. */
  async ledger(claims: TenantClaims, storeId: string, resourceId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.store(db, storeId);
    await this.projects.access(db, claims, s.project_id);
    const rows = await db<{ qty: string; value: string }[]>`
      SELECT m.id::text AS id, to_char(m.moved_on, 'YYYY-MM-DD') AS "movedOn", m.kind, m.qty::text AS qty,
        m.value::text AS value, m.doc_type AS "docType", m.doc_id AS "docId", m.doc_number AS "docNumber",
        w.code AS "wbsCode", u.display_name AS "by"
      FROM proc.stock_move m LEFT JOIN proj.wbs w ON w.id = m.wbs_id
      LEFT JOIN platform."user" u ON u.id = m.created_by
      WHERE m.store_id = ${storeId} AND m.resource_id = ${resourceId} ORDER BY m.id`;
    let [q, v] = [0n, 0n];
    const [r] = await db`SELECT id, code, name, unit FROM est.resource WHERE id = ${resourceId}`;
    return {
      resource: r ?? null,
      moves: rows.map((m) => {
        q += dec(m.qty);
        v += dec(m.value);
        return { ...m, balanceQty: q4(q), balanceValue: fmt(v, 2) };
      }),
    };
  }

  async setReorder(
    claims: TenantClaims,
    storeId: string,
    resourceId: string,
    level: string | null,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.store(db, storeId);
    await this.must(db, claims, s.project_id, 'stores.manage');
    const [r] = await db`SELECT 1 FROM est.resource WHERE id = ${resourceId}`;
    if (!r) throw new BadRequestException({ code: 'resource_not_found' });
    await db.begin(async (tx) => {
      if (level === null)
        await tx`DELETE FROM proc.reorder_level WHERE store_id = ${storeId} AND resource_id = ${resourceId}`;
      else
        await tx`INSERT INTO proc.reorder_level (store_id, resource_id, level)
          VALUES (${storeId}, ${resourceId}, ${level})
          ON CONFLICT (store_id, resource_id) DO UPDATE SET level = EXCLUDED.level`;
      await audit(tx, claims.sub, 'store.reorder', 'store', storeId, { resourceId, level });
    });
    return this.getStore(claims, storeId);
  }

  /** A draft requisition for what is below its reorder level: up to the level again. */
  async reorderRequisition(claims: TenantClaims, storeId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.store(db, storeId);
    const below = await db<{ resource_id: string; name: string; unit: string; short: string }[]>`
      SELECT l.resource_id, r.name, r.unit, (l.level - coalesce(b.qty, 0))::text AS short
      FROM proc.reorder_level l JOIN est.resource r ON r.id = l.resource_id
      LEFT JOIN proc.stock_balance b ON b.store_id = l.store_id AND b.resource_id = l.resource_id
      WHERE l.store_id = ${storeId} AND coalesce(b.qty, 0) < l.level ORDER BY r.code`;
    if (!below.length)
      throw new ConflictException({
        code: 'nothing_below',
        message: 'Nothing is below its reorder level.',
      });
    return this.requisitions.create(claims, s.project_id, {
      title: `Reorder for ${s.name}`.slice(0, 300),
      siteId: s.site_id,
      neededBy: null,
      notes: '',
      lines: below.map((b) => ({
        resourceId: b.resource_id,
        description: b.name,
        unit: b.unit,
        qty: b.short,
        rate: null,
        boqCode: null,
        wbsCode: null,
        neededBy: null,
        notes: 'Below the reorder level',
      })),
    });
  }

  // --- issues and returns from site ---

  async issue(claims: TenantClaims, storeId: string, input: IssueInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.store(db, storeId);
    await this.must(db, claims, s.project_id, 'stores.receive');
    notFuture(input.issuedOn);
    if (!s.active)
      throw new ConflictException({ code: 'store_closed', message: 'The store is closed.' });
    if (!input.lines.length)
      throw new BadRequestException({ code: 'no_lines', message: 'Say what is issued.' });
    const [wbs] = await db<{ id: string }[]>`
      SELECT id FROM proj.wbs WHERE project_id = ${s.project_id} AND lower(code) = lower(${input.wbsCode})`;
    if (!wbs)
      throw new BadRequestException({
        code: 'wbs_not_found',
        message: `No WBS element ${input.wbsCode} in the project.`,
      });
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (seen.has(l.resourceId))
        throw new BadRequestException({
          code: 'duplicate_line',
          message: 'A material is twice on the slip.',
        });
      seen.add(l.resourceId);
    }
    if (input.orderId) {
      const [o] = await db<{ kind: string; status: string }[]>`
        SELECT kind, status FROM proc.purchase_order WHERE id = ${input.orderId} AND project_id = ${s.project_id}`;
      if (!o || o.kind !== 'work' || !['issued', 'acknowledged'].includes(o.status))
        throw new BadRequestException({
          code: 'not_a_work_order',
          message: "Issue against an issued work order of the project's.",
        });
    }
    const keys = new Map<string, string>();
    for (const code of new Set(input.lines.map((l) => l.boqCode).filter((x): x is string => !!x))) {
      const found = await db<{ line_key: string }[]>`
        SELECT n.line_key FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
        WHERE b.project_id = ${s.project_id} AND b.kind = 'contract' AND b.archived_at IS NULL
          AND lower(n.code) = lower(${code})`;
      if (found.length !== 1)
        throw new BadRequestException({
          code: 'boq_item_not_found',
          message: `No single item ${code} in the project's contract BOQ.`,
        });
      keys.set(code, found[0]!.line_key);
    }
    const id = await db.begin(async (tx) => {
      const method = await valuation(tx);
      const number = await nextNumber(
        tx,
        'stock_issue',
        await this.entityOf(tx, s.project_id),
        'ISS',
        new Date(),
      );
      const [iss] = await tx<{ id: string }[]>`
        INSERT INTO proc.stock_issue (project_id, store_id, number, issued_on, wbs_id, issued_to, purpose, equipment_id,
          order_id, created_by)
        VALUES (${s.project_id}, ${storeId}, ${number}, ${input.issuedOn}, ${wbs.id}, ${input.issuedTo},
          ${input.purpose}, ${input.equipmentId ?? null}, ${input.orderId ?? null}, ${claims.sub})
        RETURNING id`;
      for (const [i, l] of input.lines.entries()) {
        const qty = dec(l.qty);
        const value = await stockOut(
          tx,
          method,
          {
            storeId,
            resourceId: l.resourceId,
            on: input.issuedOn,
            kind: 'issue',
            docType: 'stock_issue',
            docId: iss!.id,
            docNumber: number,
            wbsId: wbs.id,
            userId: claims.sub,
          },
          qty,
        );
        await tx`INSERT INTO proc.stock_issue_line (issue_id, position, resource_id, line_key, qty, value)
          VALUES (${iss!.id}, ${i + 1}, ${l.resourceId}, ${l.boqCode ? keys.get(l.boqCode)! : null}, ${q4(qty)},
            ${fmt(value, 2)})`;
      }
      await audit(tx, claims.sub, 'stock.issue', 'stock_issue', iss!.id, { number });
      return iss!.id;
    });
    return this.getIssue(claims, id);
  }

  async getIssue(claims: TenantClaims, issueId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<{ project_id: string; store_id: string; active: boolean }[]>`
      SELECT i.project_id, i.store_id, s.active FROM proc.stock_issue i JOIN proc.store s ON s.id = i.store_id
      WHERE i.id = ${issueId}`;
    if (!i) throw new NotFoundException({ code: 'issue_not_found' });
    await this.projects.access(db, claims, i.project_id);
    const [head] = await db`
      SELECT i.id, i.number, to_char(i.issued_on, 'YYYY-MM-DD') AS "issuedOn", i.issued_to AS "issuedTo", i.purpose,
        json_build_object('id', s.id, 'name', s.name) AS store,
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('code', w.code, 'name', w.name) AS wbs, u.display_name AS "issuedBy"
      FROM proc.stock_issue i JOIN proc.store s ON s.id = i.store_id JOIN proj.project p ON p.id = i.project_id
      JOIN proj.wbs w ON w.id = i.wbs_id LEFT JOIN platform."user" u ON u.id = i.created_by
      WHERE i.id = ${issueId}`;
    const lines = await db<{ qty: string; returned: string }[]>`
      SELECT l.position, r.id AS "resourceId", r.code, r.name, r.unit, l.qty::text AS qty, l.value::text AS value,
        n.code AS "boqCode",
        coalesce((SELECT sum(x.qty) FROM proc.stock_issue_return_line x JOIN proc.stock_issue_return t
          ON t.id = x.return_id WHERE t.issue_id = l.issue_id AND x.position = l.position), 0)::text AS returned
      FROM proc.stock_issue_line l JOIN est.resource r ON r.id = l.resource_id
      LEFT JOIN LATERAL (SELECT n.code FROM est.boq_node n JOIN est.boq b ON b.id = n.boq_id
        WHERE n.line_key = l.line_key AND b.project_id = ${i.project_id} AND b.kind = 'contract' LIMIT 1) n ON true
      WHERE l.issue_id = ${issueId} ORDER BY l.position`;
    return {
      ...head!,
      lines,
      mayReturn:
        i.active &&
        lines.some((l) => dec(l.returned) < dec(l.qty)) &&
        (await this.may(db, claims, i.project_id, 'stores.receive')),
    };
  }

  /** Unused material back to the store, at the value it went out at; no more than went out. */
  async returnToStore(
    claims: TenantClaims,
    issueId: string,
    input: { returnedOn: string; lines: { position: number; qty: string }[] },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<
      { project_id: string; store_id: string; number: string; wbs_id: string }[]
    >`
      SELECT project_id, store_id, number, wbs_id FROM proc.stock_issue WHERE id = ${issueId}`;
    if (!i) throw new NotFoundException({ code: 'issue_not_found' });
    await this.must(db, claims, i.project_id, 'stores.receive');
    notFuture(input.returnedOn);
    if (!input.lines.length)
      throw new BadRequestException({ code: 'no_lines', message: 'Say what comes back.' });
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proc.stock_issue WHERE id = ${issueId} FOR UPDATE`;
      const method = await valuation(tx);
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO proc.stock_issue_return (issue_id, returned_on, created_by)
        VALUES (${issueId}, ${input.returnedOn}, ${claims.sub}) RETURNING id`;
      for (const l of input.lines) {
        const [x] = await tx<
          { resource_id: string; qty: string; value: string; rq: string; rv: string }[]
        >`
          SELECT l.resource_id, l.qty::text AS qty, l.value::text AS value,
            coalesce(sum(x.qty), 0)::text AS rq, coalesce(sum(x.value), 0)::text AS rv
          FROM proc.stock_issue_line l
          LEFT JOIN proc.stock_issue_return t ON t.issue_id = l.issue_id
          LEFT JOIN proc.stock_issue_return_line x ON x.return_id = t.id AND x.position = l.position
          WHERE l.issue_id = ${issueId} AND l.position = ${l.position}
          GROUP BY l.resource_id, l.qty, l.value`;
        if (!x) throw new BadRequestException({ code: 'line_not_found' });
        const [qty, issued, back] = [dec(l.qty), dec(x.qty), dec(x.rq)];
        if (qty + back > issued)
          throw new ConflictException({
            code: 'over_issued',
            message: `Line ${l.position}: ${fmt(issued - back, 4, 0)} is out on site, not ${fmt(qty, 4, 0)}.`,
          });
        // The last of it comes back at exactly what is left of the issue's value.
        const value =
          qty + back === issued ? dec(x.value) - dec(x.rv) : share(dec(x.value), qty, issued);
        await tx`INSERT INTO proc.stock_issue_return_line (return_id, position, qty, value)
          VALUES (${r!.id}, ${l.position}, ${q4(qty)}, ${fmt(value, 2)})`;
        await stockIn(
          tx,
          method,
          {
            storeId: i.store_id,
            resourceId: x.resource_id,
            on: input.returnedOn,
            kind: 'issue_return',
            docType: 'stock_issue',
            docId: issueId,
            docNumber: i.number,
            wbsId: i.wbs_id,
            userId: claims.sub,
          },
          qty,
          value,
        );
      }
      await audit(tx, claims.sub, 'stock.issue_return', 'stock_issue', issueId, {
        lines: input.lines.length,
      });
    });
    return this.getIssue(claims, issueId);
  }

  // --- transfers ---

  async transfer(claims: TenantClaims, storeId: string, input: TransferInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const from = await this.store(db, storeId);
    await this.must(db, claims, from.project_id, 'stores.manage');
    const to = await this.store(db, input.toStoreId);
    await this.projects.access(db, claims, to.project_id);
    notFuture(input.sentOn);
    if (from.id === to.id)
      throw new BadRequestException({
        code: 'same_store',
        message: 'Choose another store to send it to.',
      });
    if (!from.active || !to.active)
      throw new ConflictException({
        code: 'store_closed',
        message: 'One of the stores is closed.',
      });
    if (!input.lines.length)
      throw new BadRequestException({ code: 'no_lines', message: 'Say what is sent.' });
    if (new Set(input.lines.map((l) => l.resourceId)).size !== input.lines.length)
      throw new BadRequestException({
        code: 'duplicate_line',
        message: 'A material is twice on the transfer.',
      });
    const id = await db.begin(async (tx) => {
      const method = await valuation(tx);
      const number = await nextNumber(
        tx,
        'stock_transfer',
        await this.entityOf(tx, from.project_id),
        'TRN',
        new Date(),
      );
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO proc.stock_transfer (number, from_store_id, to_store_id, sent_on, note, vehicle_no, transporter,
          eway_bill_no, created_by)
        VALUES (${number}, ${from.id}, ${to.id}, ${input.sentOn}, ${input.note}, ${input.vehicleNo ?? null},
          ${input.transporter ?? null}, ${input.ewayBillNo ?? null}, ${claims.sub}) RETURNING id`;
      for (const [i, l] of input.lines.entries()) {
        const qty = dec(l.qty);
        const value = await stockOut(
          tx,
          method,
          {
            storeId: from.id,
            resourceId: l.resourceId,
            on: input.sentOn,
            kind: 'transfer_out',
            docType: 'stock_transfer',
            docId: t!.id,
            docNumber: number,
            userId: claims.sub,
          },
          qty,
        );
        await tx`INSERT INTO proc.stock_transfer_line (transfer_id, position, resource_id, qty, value)
          VALUES (${t!.id}, ${i + 1}, ${l.resourceId}, ${q4(qty)}, ${fmt(value, 2)})`;
      }
      await audit(tx, claims.sub, 'stock.transfer', 'stock_transfer', t!.id, { number, to: to.id });
      return t!.id;
    });
    return this.getTransfer(claims, id);
  }

  private async transferRow(db: Db, id: string, lock = false) {
    const rows = lock
      ? await db<
          {
            id: string;
            number: string;
            from_store_id: string;
            to_store_id: string;
            status: string;
          }[]
        >`
          SELECT * FROM proc.stock_transfer WHERE id = ${id} FOR UPDATE`
      : await db<
          {
            id: string;
            number: string;
            from_store_id: string;
            to_store_id: string;
            status: string;
          }[]
        >`
          SELECT * FROM proc.stock_transfer WHERE id = ${id}`;
    if (!rows[0]) throw new NotFoundException({ code: 'transfer_not_found' });
    return rows[0];
  }

  /**
   * Arrived: into the receiving store at what it cost the sender. A line that came short (step 8e.3) takes in what
   * arrived at its share of the value; the rest is a transit loss, kept on the line with the reason.
   */
  async receiveTransfer(
    claims: TenantClaims,
    transferId: string,
    receivedOn: string,
    short: { position: number; receivedQty: string; reason: string }[] = [],
  ) {
    return this.landTransfer(claims, transferId, receivedOn, 'in', short);
  }

  /** Not sent after all (or turned back): into the sending store again, at the same value. */
  async cancelTransfer(claims: TenantClaims, transferId: string) {
    return this.landTransfer(claims, transferId, indiaToday(), 'back');
  }

  private async landTransfer(
    claims: TenantClaims,
    transferId: string,
    on: string,
    way: 'in' | 'back',
    short: { position: number; receivedQty: string; reason: string }[] = [],
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const t0 = await this.transferRow(db, transferId);
    const store = await this.store(db, way === 'in' ? t0.to_store_id : t0.from_store_id);
    await this.must(
      db,
      claims,
      store.project_id,
      way === 'in' ? 'stores.receive' : 'stores.manage',
    );
    notFuture(on);
    await db.begin(async (tx) => {
      const t = await this.transferRow(tx, transferId, true);
      if (t.status !== 'in_transit')
        throw new ConflictException({
          code: 'not_in_transit',
          message: `It is already ${t.status}.`,
        });
      const method = await valuation(tx);
      const lines = await tx<
        { position: number; resource_id: string; qty: string; value: string }[]
      >`
        SELECT position, resource_id, qty::text AS qty, value::text AS value FROM proc.stock_transfer_line
        WHERE transfer_id = ${transferId} ORDER BY position`;
      for (const x of short)
        if (!lines.some((l) => l.position === x.position))
          throw new BadRequestException({ code: 'no_such_line' });
      for (const l0 of lines) {
        const s = way === 'in' ? short.find((x) => x.position === l0.position) : undefined;
        let l = l0;
        if (s) {
          const [sent, came] = [dec(l0.qty), dec(s.receivedQty)];
          if (came > sent)
            throw new BadRequestException({
              code: 'more_than_sent',
              message: `Line ${l0.position}: more arrived than was sent.`,
            });
          if (came < sent && s.reason.trim().length < 3)
            throw new BadRequestException({
              code: 'reason_needed',
              message: `Line ${l0.position}: say why it came short.`,
            });
          // The value that arrived is the sent value's share; the rest is lost.
          const kept = fmt(sent === 0n ? 0n : (dec(l0.value) * came) / sent, 2);
          const lost = dec(l0.value) - dec(kept);
          await tx`
            UPDATE proc.stock_transfer_line SET received_qty = ${q4(came)}, lost_qty = ${q4(sent - came)},
              lost_value = ${fmt(lost, 2)}, loss_reason = ${came < sent ? s.reason.trim() : null}
            WHERE transfer_id = ${transferId} AND position = ${l0.position}`;
          if (came === 0n) continue;
          l = { ...l0, qty: q4(came), value: kept };
        } else if (way === 'in')
          await tx`UPDATE proc.stock_transfer_line SET received_qty = qty
            WHERE transfer_id = ${transferId} AND position = ${l0.position}`;
        await stockIn(
          tx,
          method,
          {
            storeId: store.id,
            resourceId: l.resource_id,
            on,
            kind: way === 'in' ? 'transfer_in' : 'transfer_back',
            docType: 'stock_transfer',
            docId: transferId,
            docNumber: t.number,
            userId: claims.sub,
          },
          dec(l.qty),
          dec(l.value),
        );
      }
      await tx`UPDATE proc.stock_transfer SET status = ${way === 'in' ? 'received' : 'cancelled'},
          received_on = ${way === 'in' ? on : null}, received_by = ${way === 'in' ? claims.sub : null},
          row_version = row_version + 1
        WHERE id = ${transferId}`;
      await audit(
        tx,
        claims.sub,
        `stock.transfer_${way === 'in' ? 'received' : 'cancelled'}`,
        'stock_transfer',
        transferId,
        {},
      );
    });
    return this.getTransfer(claims, transferId);
  }

  async getTransfer(claims: TenantClaims, transferId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const t = await this.transferRow(db, transferId);
    const [from, to] = [await this.store(db, t.from_store_id), await this.store(db, t.to_store_id)];
    // Either end's team sees it.
    const seen = await Promise.all(
      [from.project_id, to.project_id].map((p) =>
        this.projects.access(db, claims, p).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (!seen.some(Boolean)) throw new NotFoundException({ code: 'transfer_not_found' });
    const [head] = await db`
      SELECT t.id, t.number, t.status, to_char(t.sent_on, 'YYYY-MM-DD') AS "sentOn",
        to_char(t.received_on, 'YYYY-MM-DD') AS "receivedOn", t.note, t.vehicle_no AS "vehicleNo", t.transporter,
        t.eway_bill_no AS "ewayBillNo",
        json_build_object('id', f.id, 'name', f.name, 'project', fp.number) AS "fromStore",
        json_build_object('id', d.id, 'name', d.name, 'project', dp.number) AS "toStore",
        u.display_name AS "sentBy", v.display_name AS "receivedBy"
      FROM proc.stock_transfer t
      JOIN proc.store f ON f.id = t.from_store_id JOIN proj.project fp ON fp.id = f.project_id
      JOIN proc.store d ON d.id = t.to_store_id JOIN proj.project dp ON dp.id = d.project_id
      LEFT JOIN platform."user" u ON u.id = t.created_by LEFT JOIN platform."user" v ON v.id = t.received_by
      WHERE t.id = ${transferId}`;
    const lines = await db`
      SELECT l.position, r.code, r.name, r.unit, l.qty::text AS qty, l.value::text AS value,
        l.received_qty::text AS "receivedQty", l.lost_qty::text AS "lostQty", l.lost_value::text AS "lostValue",
        l.loss_reason AS "lossReason"
      FROM proc.stock_transfer_line l JOIN est.resource r ON r.id = l.resource_id
      WHERE l.transfer_id = ${transferId} ORDER BY l.position`;
    const transit = t.status === 'in_transit';
    return {
      ...head!,
      lines,
      mayReceive:
        transit && seen[1]! && (await this.may(db, claims, to.project_id, 'stores.receive')),
      mayCancel:
        transit && seen[0]! && (await this.may(db, claims, from.project_id, 'stores.manage')),
    };
  }

  // --- stock take ---

  private async countLines(tx: TransactionSql, storeId: string, lines: CountInput['lines']) {
    if (new Set(lines.map((l) => l.resourceId)).size !== lines.length)
      throw new BadRequestException({
        code: 'duplicate_line',
        message: 'A material is counted twice.',
      });
    const out = [];
    for (const l of lines) {
      const [b] = await tx<{ qty: string }[]>`
        SELECT qty::text AS qty FROM proc.stock_balance WHERE store_id = ${storeId} AND resource_id = ${l.resourceId}`;
      const [r] = await tx`SELECT 1 FROM est.resource WHERE id = ${l.resourceId}`;
      if (!r) throw new BadRequestException({ code: 'resource_not_found' });
      out.push({
        resource_id: l.resourceId,
        book_qty: b?.qty ?? '0',
        counted_qty: q4(dec(l.counted)),
        unit_cost: fmt(await unitCost(tx, storeId, l.resourceId), 6),
        reason: l.reason,
      });
    }
    return out;
  }

  async startCount(claims: TenantClaims, storeId: string, input: CountInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.store(db, storeId);
    await this.must(db, claims, s.project_id, 'stores.manage');
    notFuture(input.countedOn);
    const id = await db.begin(async (tx) => {
      const [open] = await tx`SELECT 1 FROM proc.stock_count WHERE store_id = ${storeId}
        AND status IN ('draft', 'submitted', 'rejected')`;
      if (open)
        throw new ConflictException({
          code: 'count_open',
          message: 'A count of this store is already open.',
        });
      const number = await nextNumber(
        tx,
        'stock_count',
        await this.entityOf(tx, s.project_id),
        'STK',
        new Date(),
      );
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO proc.stock_count (store_id, number, counted_on, notes, created_by, updated_by)
        VALUES (${storeId}, ${number}, ${input.countedOn}, ${input.notes}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      const lines = await this.countLines(tx, storeId, input.lines);
      if (lines.length)
        await tx`INSERT INTO proc.stock_count_line ${tx(lines.map((l) => ({ ...l, count_id: c!.id })))}`;
      await audit(tx, claims.sub, 'stock.count', 'stock_count', c!.id, { number });
      return c!.id;
    });
    return this.getCount(claims, id);
  }

  private async countRow(db: Db, id: string, lock = false) {
    type Row = {
      id: string;
      store_id: string;
      number: string;
      status: string;
      row_version: number;
    };
    const rows = lock
      ? await db<Row[]>`SELECT * FROM proc.stock_count WHERE id = ${id} FOR UPDATE`
      : await db<Row[]>`SELECT * FROM proc.stock_count WHERE id = ${id}`;
    if (!rows[0]) throw new NotFoundException({ code: 'count_not_found' });
    return rows[0];
  }

  async updateCount(claims: TenantClaims, countId: string, rowVersion: number, input: CountInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const c0 = await this.countRow(db, countId);
    const s = await this.store(db, c0.store_id);
    await this.must(db, claims, s.project_id, 'stores.manage');
    notFuture(input.countedOn);
    await db.begin(async (tx) => {
      const [u] =
        await tx`UPDATE proc.stock_count SET counted_on = ${input.countedOn}, notes = ${input.notes},
          status = 'draft', status_reason = NULL, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1
        WHERE id = ${countId} AND row_version = ${rowVersion} AND status IN ('draft', 'rejected') RETURNING id`;
      if (!u)
        throw new ConflictException({
          code: 'not_editable',
          message: 'Someone changed it, or it is waiting for approval or done.',
        });
      // A line already counted keeps the book quantity it was counted against.
      const before = new Map(
        (
          await tx<{ resource_id: string; book_qty: string; unit_cost: string }[]>`
            SELECT resource_id, book_qty::text AS book_qty, unit_cost::text AS unit_cost FROM proc.stock_count_line
            WHERE count_id = ${countId}`
        ).map((l) => [l.resource_id, l]),
      );
      const lines = (await this.countLines(tx, c0.store_id, input.lines)).map((l) => {
        const b = before.get(l.resource_id);
        return b ? { ...l, book_qty: b.book_qty, unit_cost: b.unit_cost } : l;
      });
      await tx`DELETE FROM proc.stock_count_line WHERE count_id = ${countId}`;
      if (lines.length)
        await tx`INSERT INTO proc.stock_count_line ${tx(lines.map((l) => ({ ...l, count_id: countId })))}`;
    });
    return this.getCount(claims, countId);
  }

  /** The value of the differences, gains and losses alike: what the approver is asked to accept. */
  private async differenceValue(db: Db, countId: string) {
    const lines = await db<{ book_qty: string; counted_qty: string; unit_cost: string }[]>`
      SELECT book_qty::text AS book_qty, counted_qty::text AS counted_qty, unit_cost::text AS unit_cost
      FROM proc.stock_count_line WHERE count_id = ${countId}`;
    return lines.reduce((sum, l) => {
      const d = dec(l.counted_qty) - dec(l.book_qty);
      return sum + paise(((d < 0n ? -d : d) * dec(l.unit_cost)) / 10n ** 12n);
    }, 0n);
  }

  async submitCount(claims: TenantClaims, countId: string, rowVersion: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const c0 = await this.countRow(db, countId);
    const s = await this.store(db, c0.store_id);
    await this.must(db, claims, s.project_id, 'stores.manage');
    await db.begin(async (tx) => {
      const c = await this.countRow(tx, countId, true);
      if (c.row_version !== rowVersion)
        throw new ConflictException({ code: 'stale_row', message: 'Someone changed it. Reload.' });
      if (c.status !== 'draft' && c.status !== 'rejected')
        throw new ConflictException({
          code: 'not_submittable',
          message: 'This cannot be submitted.',
        });
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM proc.stock_count_line WHERE count_id = ${countId}`;
      if (!n!.n)
        throw new BadRequestException({ code: 'no_lines', message: 'Count something first.' });
      const res = await this.approvals.submit(tx, claims, {
        docType: STOCK_ADJUSTMENT,
        docId: countId,
        projectId: s.project_id,
        title: `${c.number} · ${s.name}`,
        amount: fmt(await this.differenceValue(tx, countId), 2),
      });
      await tx`UPDATE proc.stock_count SET status = 'submitted', status_reason = NULL, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${countId}`;
      if (res.status === 'approved') await this.post(tx, countId, claims);
      await audit(tx, claims.sub, 'stock.count_submit', 'stock_count', countId, {
        status: res.status,
      });
    });
    return this.getCount(claims, countId);
  }

  /** Approved: each difference posts, gains at the counted cost, losses valued as any issue is. */
  private async post(tx: TransactionSql, countId: string, claims: TenantClaims) {
    const c = await this.countRow(tx, countId, true);
    const method = await valuation(tx);
    const [h] = await tx<{ counted_on: string }[]>`
      SELECT to_char(counted_on, 'YYYY-MM-DD') AS counted_on FROM proc.stock_count WHERE id = ${countId}`;
    const lines = await tx<
      { resource_id: string; book_qty: string; counted_qty: string; unit_cost: string }[]
    >`
      SELECT resource_id, book_qty::text AS book_qty, counted_qty::text AS counted_qty, unit_cost::text AS unit_cost
      FROM proc.stock_count_line WHERE count_id = ${countId}`;
    for (const l of lines) {
      const d = dec(l.counted_qty) - dec(l.book_qty);
      if (d === 0n) continue;
      const ref = {
        storeId: c.store_id,
        resourceId: l.resource_id,
        on: h!.counted_on,
        kind: 'adjustment' as const,
        docType: 'stock_count',
        docId: countId,
        docNumber: c.number,
        userId: claims.sub,
      };
      if (d > 0n) await stockIn(tx, method, ref, d, paise((d * dec(l.unit_cost)) / 10n ** 12n));
      else await stockOut(tx, method, ref, -d);
    }
    await tx`UPDATE proc.stock_count SET status = 'posted', posted_at = now(), row_version = row_version + 1
      WHERE id = ${countId}`;
  }

  private async decided(
    tx: TransactionSql,
    countId: string,
    outcome: Outcome,
    claims: TenantClaims,
    comment: string | null,
  ) {
    if (outcome === 'approved') await this.post(tx, countId, claims);
    else
      await tx`UPDATE proc.stock_count SET status = ${outcome === 'rejected' ? 'rejected' : 'draft'},
        status_reason = ${outcome === 'rejected' ? comment : null}, row_version = row_version + 1
        WHERE id = ${countId}`;
  }

  async discardCount(claims: TenantClaims, countId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.countRow(db, countId);
    const s = await this.store(db, c.store_id);
    await this.must(db, claims, s.project_id, 'stores.manage');
    const [u] =
      await db`UPDATE proc.stock_count SET status = 'discarded', row_version = row_version + 1
      WHERE id = ${countId} AND status IN ('draft', 'rejected') RETURNING id`;
    if (!u)
      throw new ConflictException({
        code: 'not_discardable',
        message: 'Withdraw it from approval first.',
      });
    return this.getCount(claims, countId);
  }

  private async countDetail(db: Db, countId: string) {
    const [head] = await db`
      SELECT c.id, c.number, c.status, c.status_reason AS "statusReason",
        to_char(c.counted_on, 'YYYY-MM-DD') AS "countedOn", c.notes, c.row_version AS "rowVersion",
        json_build_object('id', s.id, 'name', s.name) AS store,
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project
      FROM proc.stock_count c JOIN proc.store s ON s.id = c.store_id JOIN proj.project p ON p.id = s.project_id
      WHERE c.id = ${countId}`;
    const lines = await db<{ bookQty: string; countedQty: string; unitCost: string }[]>`
      SELECT r.id AS "resourceId", r.code, r.name, r.unit, l.book_qty::text AS "bookQty",
        l.counted_qty::text AS "countedQty", l.unit_cost::text AS "unitCost", l.reason
      FROM proc.stock_count_line l JOIN est.resource r ON r.id = l.resource_id
      WHERE l.count_id = ${countId} ORDER BY r.code`;
    return {
      ...head!,
      lines: lines.map((l) => {
        const d = dec(l.countedQty) - dec(l.bookQty);
        return {
          ...l,
          difference: q4(d),
          value: fmt(paise((d * dec(l.unitCost)) / 10n ** 12n), 2),
        };
      }),
    };
  }

  async getCount(claims: TenantClaims, countId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.countRow(db, countId);
    const s = await this.store(db, c.store_id);
    await this.projects.access(db, claims, s.project_id);
    const mayManage = await this.may(db, claims, s.project_id, 'stores.manage');
    return {
      ...(await this.countDetail(db, countId)),
      approval: await this.approvals.latestFor(db, claims, STOCK_ADJUSTMENT, countId),
      mayEdit: mayManage && (c.status === 'draft' || c.status === 'rejected'),
    };
  }

  // --- reports ---

  /**
   * What the project has used, by material: the budget in force, accepted from suppliers, issued to work (net of what
   * came back), in its stores; and issued by WBS element.
   */
  async consumption(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const resources = await db`
      WITH budget AS (
        SELECT l.resource_id, l.qty FROM proj.material_budget_line l
        JOIN proj.material_budget b ON b.id = l.budget_id
        WHERE b.project_id = ${projectId} AND b.status = 'approved'
      ), moves AS (
        SELECT m.resource_id,
          sum(CASE WHEN m.kind IN ('receipt', 'receipt_cancelled') THEN m.qty ELSE 0 END) AS received,
          sum(CASE WHEN m.kind IN ('issue', 'issue_return') THEN -m.qty ELSE 0 END) AS issued,
          sum(CASE WHEN m.kind IN ('issue', 'issue_return') THEN -m.value ELSE 0 END) AS issued_value
        FROM proc.stock_move m JOIN proc.store s ON s.id = m.store_id
        WHERE s.project_id = ${projectId} GROUP BY m.resource_id
      ), stock AS (
        SELECT b.resource_id, sum(b.qty) AS qty, sum(b.value) AS value
        FROM proc.stock_balance b JOIN proc.store s ON s.id = b.store_id
        WHERE s.project_id = ${projectId} GROUP BY b.resource_id
      ), ids AS (
        SELECT resource_id FROM budget UNION SELECT resource_id FROM moves UNION SELECT resource_id FROM stock
      )
      SELECT r.id AS "resourceId", r.code, r.name, r.unit, bu.qty::text AS budget,
        coalesce(mv.received, 0)::text AS received, coalesce(mv.issued, 0)::text AS issued,
        coalesce(mv.issued_value, 0)::text AS "issuedValue", coalesce(st.qty, 0)::text AS "inStock",
        coalesce(st.value, 0)::text AS "stockValue"
      FROM ids JOIN est.resource r ON r.id = ids.resource_id
      LEFT JOIN budget bu ON bu.resource_id = ids.resource_id
      LEFT JOIN moves mv ON mv.resource_id = ids.resource_id
      LEFT JOIN stock st ON st.resource_id = ids.resource_id
      WHERE r.kind = 'material' OR mv.resource_id IS NOT NULL
      ORDER BY r.code`;
    const byWbs = await db`
      SELECT w.code AS "wbsCode", w.name AS "wbsName", r.code, r.name, r.unit,
        sum(-m.qty)::text AS qty, sum(-m.value)::text AS value
      FROM proc.stock_move m JOIN proc.store s ON s.id = m.store_id JOIN proj.wbs w ON w.id = m.wbs_id
      JOIN est.resource r ON r.id = m.resource_id
      WHERE s.project_id = ${projectId} AND m.kind IN ('issue', 'issue_return')
      GROUP BY w.code, w.name, r.code, r.name, r.unit ORDER BY w.code, r.code`;
    return { resources, byWbs };
  }
}
