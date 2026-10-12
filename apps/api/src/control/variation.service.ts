// Variations and change orders (docs/wave4-plan.md step 4): requested and priced (new items from rate analyses or
// typed rates, changed quantities at contract and budget rates), approved inside the company (approval engine,
// `variation`), submitted to the client and decided (often for less); then carried into the contract BOQ (a new
// revision when it was frozen) and its budget, keyed together, and the schedule. Contract BOQs are never locked by
// billing, so the register shows work executed beyond what the client approved.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { ApprovalService, type Outcome } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { BoqService, type Op } from '../boq/boq.service.js';
import { RevisionService } from '../boq/revision.service.js';
import { cents, fromCents } from '../project/money.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { RatesService } from '../rates/rates.service.js';
import { ProgrammeService } from '../schedule/programme.service.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
export const VARIATION = 'variation';
const SECTION = 'VO';

export interface LineInput {
  kind: 'new' | 'change';
  /** A new item's code, or the changed contract line's code. */
  code: string;
  description: string;
  unit: string;
  qty: string;
  rate: string | null;
  costRate: string | null;
  rateAnalysisId: string | null;
}
export interface VariationInput {
  title: string;
  source: 'client_instruction' | 'site_condition' | 'design_change' | 'other';
  instructionRef: string;
  reason: string;
  contractBoqId: string | null;
  days: number;
  activities: { planId: string; activityId: string }[];
  lines: LineInput[];
}
interface VRow {
  id: string;
  project_id: string;
  number: string;
  title: string;
  status: string;
  contract_boq_id: string;
  days: number;
  activities: { planId: string; activityId: string }[];
  applied: boolean;
  row_version: number;
}
interface LRow {
  position: number;
  kind: 'new' | 'change';
  line_key: string;
  code: string;
  description: string;
  unit: string;
  qty: string;
  rate: string;
  cost_rate: string;
  approved_qty: string | null;
  approved_rate: string | null;
}

/** numeric(…,4) text to integer × 10⁴. */
const r4 = (v: string) => {
  const neg = v.startsWith('-');
  const [i = '0', f = ''] = (neg ? v.slice(1) : v).split('.');
  const x = BigInt(i) * 10_000n + BigInt((f + '0000').slice(0, 4));
  return neg ? -x : x;
};
const s4 = (x: bigint) => {
  const neg = x < 0n;
  const a = neg ? -x : x;
  return `${neg ? '-' : ''}${a / 10_000n}.${(a % 10_000n).toString().padStart(4, '0')}`;
};
/** qty × rate (both × 10⁴) in paise, rounded half away from zero. */
const amount = (qty: bigint, rate: bigint) => {
  const x = qty * rate;
  return (x + (x < 0n ? -500_000n : 500_000n)) / 1_000_000n;
};

@Injectable()
export class VariationService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly approvals: ApprovalService,
    private readonly boqs: BoqService,
    private readonly revisions: RevisionService,
    private readonly rates: RatesService,
    private readonly programmes: ProgrammeService,
  ) {}

  onModuleInit() {
    this.approvals.register(VARIATION, {
      label: 'Variation',
      projectScoped: true,
      link: (id) => `/variations/${id}`,
      decided: (tx, id, outcome, claims, comment) => this.decided(tx, id, outcome, claims, comment),
      summary: async (db, id) => {
        const [v] =
          await db`SELECT number, title, value::text AS value, cost::text AS cost FROM ctl.variation WHERE id = ${id}`;
        return v ?? null;
      },
      canSee: async (db, claims, id) => {
        const [v] = await db<
          { project_id: string }[]
        >`SELECT project_id FROM ctl.variation WHERE id = ${id}`;
        if (!v) return false;
        return this.projects.access(db, claims, v.project_id).then(
          () => true,
          () => false,
        );
      },
    });
  }

  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team raises its variations.",
      });
  }

  private async commercial(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'billing.edit')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'billing.edit',
        message: "The client's decision is recorded with the billing permission.",
      });
  }

  private async row(db: Db, id: string, lock = false) {
    const [v] = lock
      ? await db<VRow[]>`SELECT * FROM ctl.variation WHERE id = ${id} FOR UPDATE`
      : await db<VRow[]>`SELECT * FROM ctl.variation WHERE id = ${id}`;
    if (!v) throw new NotFoundException({ code: 'not_found', message: 'No such variation.' });
    return v;
  }

  private lines(db: Db, id: string) {
    return db<LRow[]>`
      SELECT position, kind, line_key, code, description, unit, qty::text, rate::text, cost_rate::text,
        approved_qty::text, approved_rate::text
      FROM ctl.variation_line WHERE variation_id = ${id} ORDER BY position`;
  }

  /** The contract BOQ a variation changes, and the budget BOQ that goes with it (same source, else the only one). */
  private async books(db: Db, projectId: string, contractBoqId: string | null) {
    const [c] = contractBoqId
      ? await db<{ id: string; source: string | null }[]>`
          SELECT id, source_boq_id AS source FROM est.boq
          WHERE id = ${contractBoqId} AND project_id = ${projectId} AND kind = 'contract' AND archived_at IS NULL`
      : await db<{ id: string; source: string | null }[]>`
          SELECT id, source_boq_id AS source FROM est.boq
          WHERE project_id = ${projectId} AND kind = 'contract' AND archived_at IS NULL ORDER BY created_at LIMIT 1`;
    if (!c)
      throw new BadRequestException({
        code: 'no_contract_boq',
        message: 'The project has no contract BOQ to vary.',
      });
    const budgets = await db<{ id: string; source: string | null }[]>`
      SELECT id, source_boq_id AS source FROM est.boq
      WHERE project_id = ${projectId} AND kind = 'budget' AND archived_at IS NULL ORDER BY created_at`;
    const b =
      (c.source && budgets.find((x) => x.source === c.source)) ||
      (budgets.length === 1 ? budgets[0] : undefined);
    return { contract: c.id, budget: b?.id ?? null };
  }

  /** Prices the lines: new items from an analysis or typed rates; changed lines at their contract and budget rates. */
  private async price(
    db: Db,
    projectId: string,
    contractBoqId: string,
    budgetBoqId: string | null,
    lines: LineInput[],
  ) {
    const [t] = await db<{ contract: string; budget: string }[]>`
      SELECT coalesce(sum(n.amount) FILTER (WHERE b.kind = 'contract'), 0)::text AS contract,
        coalesce(sum(n.amount) FILTER (WHERE b.kind = 'budget'), 0)::text AS budget
      FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
      WHERE b.project_id = ${projectId} AND b.archived_at IS NULL`;
    const [contract, budget] = [cents(t!.contract), cents(t!.budget)];
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const out = [];
    for (const [i, l] of lines.entries()) {
      const at = `Line ${i + 1}`;
      if (r4(l.qty) === 0n)
        throw new BadRequestException({ code: 'no_quantity', message: `${at}: a quantity.` });
      if (l.kind === 'change') {
        const [n] = await db<
          { line_key: string; description: string; unit: string; rate: string }[]
        >`
          SELECT n.line_key, t.description, n.unit, n.rate::text FROM est.boq_node n
          JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
          WHERE n.boq_id = ${contractBoqId} AND n.node_type = 'item' AND lower(n.code) = lower(${l.code})`;
        if (!n)
          throw new BadRequestException({
            code: 'line_not_found',
            message: `${at}: no item ${l.code} in the contract BOQ.`,
          });
        const [b] = budgetBoqId
          ? await db<{ rate: string }[]>`
              SELECT rate::text FROM est.boq_node WHERE boq_id = ${budgetBoqId} AND line_key = ${n.line_key} AND node_type = 'item'`
          : [];
        const rate = r4(l.rate ?? n.rate);
        const costRate =
          l.costRate !== null
            ? r4(l.costRate)
            : b
              ? r4(b.rate)
              : contract
                ? (rate * budget) / contract
                : rate;
        out.push({
          ...l,
          lineKey: n.line_key,
          description: l.description || n.description,
          unit: n.unit,
          rate,
          costRate,
        });
      } else {
        let costRate = l.costRate !== null ? r4(l.costRate) : null;
        let unit = l.unit;
        let description = l.description;
        if (l.rateAnalysisId) {
          const c = await this.rates.boqRate(db, l.rateAnalysisId, today);
          costRate ??= r4(c.boqRate);
          unit ||= c.unit;
          description ||= c.description;
        }
        if (costRate === null && l.rate === null)
          throw new BadRequestException({
            code: 'not_priced',
            message: `${at}: a rate analysis, a cost rate or a rate.`,
          });
        // The contract rate: as typed, else the cost rate with the project's markup (contract ÷ budget).
        const rate =
          l.rate !== null
            ? r4(l.rate)
            : budget
              ? (costRate! * contract + budget / 2n) / budget
              : costRate!;
        costRate ??= contract ? (rate * budget) / contract : rate;
        if (!unit) throw new BadRequestException({ code: 'no_unit', message: `${at}: a unit.` });
        out.push({ ...l, lineKey: randomUUID(), description, unit, rate, costRate });
      }
    }
    return out;
  }

  private async save(
    tx: TransactionSql,
    id: string,
    priced: Awaited<ReturnType<VariationService['price']>>,
  ) {
    await tx`DELETE FROM ctl.variation_line WHERE variation_id = ${id}`;
    let value = 0n;
    let cost = 0n;
    for (const [i, l] of priced.entries()) {
      const q = r4(l.qty);
      value += amount(q, l.rate);
      cost += amount(q, l.costRate);
      await tx`
        INSERT INTO ctl.variation_line (variation_id, position, kind, line_key, code, description, unit, qty, rate, cost_rate,
          rate_analysis_id)
        VALUES (${id}, ${i + 1}, ${l.kind}, ${l.lineKey}, ${l.code}, ${l.description}, ${l.unit}, ${s4(q)}, ${s4(l.rate)},
          ${s4(l.costRate)}, ${l.rateAnalysisId})`;
    }
    await tx`UPDATE ctl.variation SET value = ${fromCents(value)}, cost = ${fromCents(cost)} WHERE id = ${id}`;
  }

  async create(claims: TenantClaims, projectId: string, input: VariationInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const books = await this.books(db, projectId, input.contractBoqId);
    const priced = await this.price(db, projectId, books.contract, books.budget, input.lines);
    const id = await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const [n] = await tx<
        { n: number }[]
      >`SELECT count(*)::int + 1 AS n FROM ctl.variation WHERE project_id = ${projectId}`;
      const number = `VO-${String(n!.n).padStart(3, '0')}`;
      const [v] = await tx<{ id: string }[]>`
        INSERT INTO ctl.variation (project_id, number, title, source, instruction_ref, reason, contract_boq_id, days, activities,
          created_by, updated_by)
        VALUES (${projectId}, ${number}, ${input.title}, ${input.source}, ${input.instructionRef}, ${input.reason}, ${books.contract},
          ${input.days}, ${tx.json(input.activities)}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      await this.save(tx, v!.id, priced);
      await audit(tx, claims.sub, 'variation.create', 'variation', v!.id, { number });
      return v!.id;
    });
    return this.get(claims, id);
  }

  async update(claims: TenantClaims, id: string, input: VariationInput & { rowVersion: number }) {
    const db = await this.tenants.forTenant(claims.ten);
    const v0 = await this.row(db, id);
    await this.team(db, claims, v0.project_id);
    if (v0.status !== 'draft')
      throw new ConflictException({
        code: 'not_draft',
        message: 'Only a draft variation is changed.',
      });
    const books = await this.books(db, v0.project_id, input.contractBoqId ?? v0.contract_boq_id);
    const priced = await this.price(db, v0.project_id, books.contract, books.budget, input.lines);
    await db.begin(async (tx) => {
      const r = await tx`
        UPDATE ctl.variation SET title = ${input.title}, source = ${input.source}, instruction_ref = ${input.instructionRef},
          reason = ${input.reason}, contract_boq_id = ${books.contract}, days = ${input.days}, activities = ${tx.json(input.activities)},
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id} AND row_version = ${input.rowVersion} AND status = 'draft' RETURNING 1`;
      if (!r.length)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed it; reload and try again.',
        });
      await this.save(tx, id, priced);
    });
    return this.get(claims, id);
  }

  /** Submitted for approval inside the company; with no rule it goes to the client at once. */
  async submit(claims: TenantClaims, id: string, rowVersion: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const v0 = await this.row(db, id);
    await this.team(db, claims, v0.project_id);
    await db.begin(async (tx) => {
      const v = await this.row(tx, id, true);
      if (v.status !== 'draft' || v.row_version !== rowVersion)
        throw new ConflictException({
          code: 'stale',
          message: 'Only a draft, as last read, is submitted.',
        });
      const [n] = await tx<{ n: number; value: string }[]>`
        SELECT (SELECT count(*)::int FROM ctl.variation_line WHERE variation_id = ${id}) AS n, value::text AS value
        FROM ctl.variation WHERE id = ${id}`;
      if (!n!.n)
        throw new BadRequestException({ code: 'no_lines', message: 'A variation needs a line.' });
      await tx`UPDATE ctl.variation SET status = 'pending', status_reason = NULL, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1 WHERE id = ${id}`;
      const r = await this.approvals.submit(tx, claims, {
        docType: VARIATION,
        docId: id,
        projectId: v.project_id,
        title: `${v.number} ${v.title}`,
        amount: n!.value,
      });
      if (r.status === 'approved') await this.toClient(tx, claims, id);
      await audit(tx, claims.sub, 'variation.submit', 'variation', id, {});
    });
    return this.get(claims, id);
  }

  private async decided(
    tx: TransactionSql,
    id: string,
    outcome: Outcome,
    claims: TenantClaims,
    comment: string | null,
  ) {
    if (outcome === 'approved') await this.toClient(tx, claims, id);
    else
      await tx`UPDATE ctl.variation SET status = 'draft', status_reason = ${comment ?? outcome}, updated_at = now(),
          row_version = row_version + 1 WHERE id = ${id}`;
  }

  /** Approved inside the company: submitted to the client; billed from now if the contract lets pending ones be. */
  private async toClient(tx: TransactionSql, claims: TenantClaims, id: string) {
    const v = await this.row(tx, id, true);
    await tx`UPDATE ctl.variation SET status = 'submitted', updated_at = now(), row_version = row_version + 1 WHERE id = ${id}`;
    const [s] = await tx<{ bill_pending: boolean }[]>`
      SELECT bill_pending FROM ctl.variation_settings WHERE project_id = ${v.project_id}`;
    if (s?.bill_pending) await this.carry(tx, claims, v, 'apply');
  }

  /**
   * The client's decision. Approved: at the quantities and rates the client allowed (each line as proposed unless
   * given), carried into the BOQs (or corrected there, if already billed while pending) and the schedule extended.
   * Rejected: anything already carried is taken back.
   */
  async clientDecision(
    claims: TenantClaims,
    id: string,
    input: {
      decision: 'approved' | 'rejected';
      reference: string;
      date: string;
      lines: { position: number; qty?: string | undefined; rate?: string | undefined }[];
      rowVersion: number;
    },
  ) {
    await this.commercial(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const v0 = await this.row(db, id);
    await this.projects.access(db, claims, v0.project_id);
    const extend = await db.begin(async (tx) => {
      const v = await this.row(tx, id, true);
      if (v.status !== 'submitted' || v.row_version !== input.rowVersion)
        throw new ConflictException({
          code: 'not_submitted',
          message: 'Only a variation submitted to the client, as last read, is decided.',
        });
      if (input.decision === 'rejected') {
        if (v.applied) await this.carry(tx, claims, v, 'revert');
        await tx`UPDATE ctl.variation SET status = 'rejected', client_ref = ${input.reference}, client_on = ${input.date},
            approved_value = 0, applied = false, updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
          WHERE id = ${id}`;
        await audit(tx, claims.sub, 'variation.client_rejected', 'variation', id, {
          reference: input.reference,
        });
        return null;
      }
      const lines = await this.lines(tx, id);
      let value = 0n;
      for (const l of lines) {
        const given = input.lines.find((x) => x.position === l.position);
        const qty = given?.qty !== undefined ? r4(given.qty) : r4(l.qty);
        const rate = given?.rate !== undefined ? r4(given.rate) : r4(l.rate);
        if (qty !== 0n && qty > 0n !== r4(l.qty) > 0n)
          throw new BadRequestException({
            code: 'sign',
            message: `Line ${l.position}: the client's quantity goes the other way.`,
          });
        value += amount(qty, rate);
        await tx`UPDATE ctl.variation_line SET approved_qty = ${s4(qty)}, approved_rate = ${s4(rate)}
          WHERE variation_id = ${id} AND position = ${l.position}`;
      }
      await this.carry(tx, claims, v, v.applied ? 'adjust' : 'apply');
      await tx`UPDATE ctl.variation SET status = 'approved', client_ref = ${input.reference}, client_on = ${input.date},
          approved_value = ${fromCents(value)}, updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'variation.client_approved', 'variation', id, {
        value: fromCents(value),
      });
      return v.days > 0 ? v.activities : null;
    });
    const schedule: string[] = [];
    if (extend)
      for (const a of extend) {
        // Each activity named takes the variation's days on top of its duration (its own transaction: the schedule
        // is worked out again).
        try {
          const [p] = await db<{ row_version: number; duration: number }[]>`
            SELECT p.row_version, a.duration FROM sched.plan p JOIN sched.activity a ON a.plan_id = p.id
            WHERE p.id = ${a.planId} AND a.id = ${a.activityId} AND p.project_id = ${v0.project_id}`;
          if (!p) continue;
          await this.programmes.change(claims, a.planId, p.row_version, [
            { op: 'update', id: a.activityId, duration: p.duration + v0.days },
          ]);
          schedule.push(a.activityId);
        } catch {
          // The approval stands; the schedule is left for the planner.
        }
      }
    return { ...(await this.get(claims, id)), extended: schedule };
  }

  /**
   * Into the contract BOQ (and its budget at cost, keyed the same): `apply` adds new items under "Variations" and
   * moves changed quantities; `adjust` corrects them to what the client approved; `revert` takes them back (a new
   * item already measured stays, to be credited). A frozen contract BOQ gets a new revision, frozen again as the
   * variation's number.
   */
  private async carry(
    tx: TransactionSql,
    claims: TenantClaims,
    v: VRow,
    mode: 'apply' | 'adjust' | 'revert',
  ) {
    const lines = await this.lines(tx, v.id);
    const books = await this.books(tx, v.project_id, v.contract_boq_id);
    for (const [boqId, cost] of [
      [books.contract, false],
      [books.budget, true],
    ] as const) {
      if (!boqId) continue;
      const [b] = await tx<{ status: string; version_no: number }[]>`
        SELECT status, version_no FROM est.boq WHERE id = ${boqId} FOR UPDATE`;
      const frozen = b!.status !== 'draft';
      if (frozen)
        await tx`UPDATE est.boq SET status = 'draft', version_no = version_no + 1, updated_at = now(), updated_by = ${claims.sub},
            row_version = row_version + 1 WHERE id = ${boqId}`;
      const ops: Op[] = [];
      const keys: Record<string, string> = {};
      const node = async (key: string) =>
        (
          await tx<
            { id: string; qty: string; rate: string; row_version: number; measured: boolean }[]
          >`
            SELECT n.id::text, coalesce(n.qty, 0)::text AS qty, coalesce(n.rate, 0)::text AS rate, n.row_version,
              EXISTS (SELECT 1 FROM proj.measurement m WHERE m.project_id = ${v.project_id} AND m.line_key = n.line_key) AS measured
            FROM est.boq_node n WHERE n.boq_id = ${boqId} AND n.line_key = ${key} AND n.node_type = 'item'`
        )[0];
      let section: string | null = null;
      const sectionId = async () => {
        if (section) return section;
        const [s] = await tx<{ id: string }[]>`
          SELECT id::text FROM est.boq_node WHERE boq_id = ${boqId} AND parent_id IS NULL AND node_type = 'section' AND code = ${SECTION}`;
        if (s) return (section = s.id);
        const [last] = await tx<{ id: string }[]>`
          SELECT id::text FROM est.boq_node WHERE boq_id = ${boqId} AND parent_id IS NULL ORDER BY sort_key DESC LIMIT 1`;
        ops.push({
          op: 'insert',
          tempId: 'tVO',
          parentId: null,
          afterId: last?.id ?? null,
          type: 'section',
          code: SECTION,
          description: 'Variations',
        });
        return (section = 'tVO');
      };
      let after: string | null = null;
      for (const l of lines) {
        const rate = cost ? l.cost_rate : mode === 'revert' ? l.rate : (l.approved_rate ?? l.rate);
        const want =
          mode === 'revert'
            ? 0n
            : r4(mode === 'adjust' || l.approved_qty !== null ? (l.approved_qty ?? l.qty) : l.qty);
        const had =
          mode === 'apply' ? 0n : r4(mode === 'adjust' ? l.qty : (l.approved_qty ?? l.qty));
        const n = await node(l.line_key);
        if (l.kind === 'new') {
          if (!n) {
            if (mode !== 'apply') continue;
            const tempId = `t${l.position}`;
            ops.push({
              op: 'insert',
              tempId,
              parentId: await sectionId(),
              afterId: after,
              type: 'item',
              code: l.code,
              description: l.description,
              unit: l.unit,
              qty: s4(want),
              rate,
            });
            keys[tempId] = l.line_key;
            after = tempId;
          } else if (mode === 'revert') {
            if (!n.measured) ops.push({ op: 'delete', id: n.id, rowVersion: n.row_version });
          } else
            ops.push({
              op: 'update',
              id: n.id,
              rowVersion: n.row_version,
              qty: s4(want),
              ...(cost ? {} : { rate }),
            });
        } else {
          if (!n) continue; // a budget without the line: the contract alone moves
          const qty = r4(n.qty) + (mode === 'revert' ? -had : want - had);
          ops.push({ op: 'update', id: n.id, rowVersion: n.row_version, qty: s4(qty) });
        }
      }
      if (ops.length) {
        const r = await this.boqs.applyInTx(tx, claims, boqId, ops);
        for (const [tempId, key] of Object.entries(keys)) {
          const nodeId = (r.idMap as Record<string, string>)[tempId];
          if (nodeId)
            await tx`UPDATE est.boq_node SET line_key = ${key} WHERE boq_id = ${boqId} AND id = ${nodeId}`;
        }
      }
      if (frozen)
        await this.revisions.freezeInTx(tx, claims.sub, boqId, {
          kind: 'internal',
          label: v.number,
          note: `${v.number} ${v.title}`,
        });
    }
    await tx`UPDATE ctl.variation SET applied = ${mode !== 'revert'} WHERE id = ${v.id}`;
  }

  async withdraw(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const v0 = await this.row(db, id);
    await this.team(db, claims, v0.project_id);
    await db.begin(async (tx) => {
      const v = await this.row(tx, id, true);
      if (!['draft', 'pending', 'submitted'].includes(v.status))
        throw new ConflictException({
          code: 'decided',
          message: 'A decided variation stays on the record.',
        });
      if (v.status === 'pending') await this.approvals.withdrawFor(tx, claims, VARIATION, id);
      if (v.applied) await this.carry(tx, claims, v, 'revert');
      await tx`UPDATE ctl.variation SET status = 'withdrawn', applied = false, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1 WHERE id = ${id}`;
    });
    return this.get(claims, id);
  }

  async started(claims: TenantClaims, id: string, on: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const v = await this.row(db, id);
    await this.team(db, claims, v.project_id);
    await db`UPDATE ctl.variation SET started_on = ${on} WHERE id = ${id}`;
    return this.get(claims, id);
  }

  async setBillPending(claims: TenantClaims, projectId: string, on: boolean) {
    await this.commercial(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    await db`
      INSERT INTO ctl.variation_settings (project_id, bill_pending, updated_by) VALUES (${projectId}, ${on}, ${claims.sub})
      ON CONFLICT (project_id) DO UPDATE SET bill_pending = EXCLUDED.bill_pending, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    return this.register(claims, projectId);
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [v] = await db<Record<string, unknown>[]>`
      SELECT v.id, v.project_id AS "projectId", v.number, v.title, v.source, v.instruction_ref AS "instructionRef", v.reason,
        v.contract_boq_id AS "contractBoqId", v.days, v.activities, v.status, v.status_reason AS "statusReason",
        to_char(v.started_on, 'YYYY-MM-DD') AS "startedOn", v.applied, v.value::text AS value, v.cost::text AS cost,
        v.client_ref AS "clientRef", to_char(v.client_on, 'YYYY-MM-DD') AS "clientOn", v.approved_value::text AS "approvedValue",
        v.row_version AS "rowVersion"
      FROM ctl.variation v WHERE v.id = ${id}`;
    if (!v) throw new NotFoundException({ code: 'not_found', message: 'No such variation.' });
    await this.projects.access(db, claims, v.projectId as string);
    const lines = await db`
      SELECT position, kind, code, description, unit, qty::text, rate::text, cost_rate::text AS "costRate",
        round(qty * rate, 2)::text AS value, round(qty * cost_rate, 2)::text AS cost,
        approved_qty::text AS "approvedQty", approved_rate::text AS "approvedRate", rate_analysis_id AS "rateAnalysisId"
      FROM ctl.variation_line WHERE variation_id = ${id} ORDER BY position`;
    return { ...v, lines, approval: await this.approvals.latestFor(db, claims, VARIATION, id) };
  }

  /** The project's variations, totals by status, and those executed but not approved by the client. */
  async register(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const list = await db<
      {
        id: string;
        number: string;
        title: string;
        status: string;
        value: string;
        cost: string;
        approvedValue: string | null;
        startedOn: string | null;
        applied: boolean;
        overMeasured: boolean;
      }[]
    >`
      SELECT v.id, v.number, v.title, v.status, v.value::text AS value, v.cost::text AS cost,
        v.approved_value::text AS "approvedValue", to_char(v.started_on, 'YYYY-MM-DD') AS "startedOn", v.applied,
        EXISTS (
          SELECT 1 FROM ctl.variation_line l
          JOIN est.boq_node n ON n.boq_id = v.contract_boq_id AND n.line_key = l.line_key AND n.node_type = 'item'
          WHERE l.variation_id = v.id
            AND (SELECT coalesce(sum(m.qty), 0) FROM proj.measurement m WHERE m.project_id = v.project_id AND m.line_key = l.line_key)
              > coalesce(n.qty, 0) - CASE WHEN v.applied AND l.kind = 'change' THEN l.qty WHEN v.applied THEN coalesce(n.qty, 0) ELSE 0 END
        ) AS "overMeasured"
      FROM ctl.variation v WHERE v.project_id = ${projectId} ORDER BY v.number`;
    const totals: Record<string, { count: number; value: string }> = {};
    for (const v of list) {
      const t = (totals[v.status] ??= { count: 0, value: '0.00' });
      t.count++;
      t.value = fromCents(
        cents(t.value) + cents(v.status === 'approved' ? (v.approvedValue ?? v.value) : v.value),
      );
    }
    const open = ['draft', 'pending', 'submitted'];
    const [s] = await db<{ bill_pending: boolean }[]>`
      SELECT bill_pending FROM ctl.variation_settings WHERE project_id = ${projectId}`;
    const boqs = await db<{ id: string; name: string }[]>`
      SELECT id, name FROM est.boq WHERE project_id = ${projectId} AND kind = 'contract' AND archived_at IS NULL ORDER BY created_at`;
    return {
      variations: list.map(({ overMeasured, ...v }) => ({
        ...v,
        executedNotApproved: open.includes(v.status) && (v.startedOn !== null || overMeasured),
      })),
      totals,
      atRisk: fromCents(
        list
          .filter((v) => open.includes(v.status) && (v.startedOn !== null || v.overMeasured))
          .reduce((a, v) => a + cents(v.value), 0n),
      ),
      billPending: s?.bill_pending ?? false,
      contractBoqs: boqs,
      mayDecide: await this.permissions.can(claims, 'billing.edit'),
    };
  }
}
