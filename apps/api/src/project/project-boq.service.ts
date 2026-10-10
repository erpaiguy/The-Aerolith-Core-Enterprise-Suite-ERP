// A project's BOQs (docs/04-features.md J2, docs/wave2a-plan.md step 2). From the won tender, each of its BOQs becomes
// two: the contract BOQ at the quoted rates (what the client pays: the estimate rate × the bid's markup factor,
// rounded to paise; provisional sums as they are) and the budget at the estimate rates (what the work should cost
// us). Both from the version submitted to the client. If the price was negotiated down, the contract BOQ's rates can
// be scaled to the project's contract value. Contract minus budget is the planned margin.
//
// The copies are ordinary BOQs (est.boq with a project_id): the grid, import/export, revisions and bulk edit work on
// them unchanged; ProjectAccess keeps them to the project's team.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { recomputeTotals } from '../boq/boq.service.js';
import { stateAt } from '../boq/revision.service.js';
import { priceBid, type GstMode, type Markup } from '../pricing/pricing.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { add, cents, fromCents, pct, ratio, sub } from './money.js';
import { ProjectService } from './project.service.js';

type Db = Sql | TransactionSql;
export type ProjectBoqKind = 'contract' | 'budget';

/** Scaling to the contract value goes down (a negotiated reduction), or up by rounding at most. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.001;
/** Advisory lock namespace held by a running copy (with the project's hash). */
const COPY_LOCK = 23_002;

/** A tender BOQ to copy, at the version the client was given. */
interface Source {
  id: string;
  name: string;
  currency: string;
  rateDate: string;
  version: number;
  /** false: no version was submitted, so the current one is used. */
  submitted: boolean;
  /** The bid's markup factor on this BOQ (provisional sums take none). */
  factor: string;
  /** At quoted rates: normal items, and provisional sums. At estimate rates: the BOQ's total. */
  quotedNormal: string;
  provisional: string;
  estimateTotal: string;
}

const LIST = `b.id, b.name, b.kind, b.status, b.version_no AS "versionNo", b.total::text AS total,
  b.node_count AS "nodeCount", b.item_count AS "itemCount", b.source_boq_id AS "sourceBoqId",
  b.source_version_no AS "sourceVersionNo", b.rate_basis AS "rateBasis", b.archived_at AS "archivedAt",
  b.updated_at AS "updatedAt"`;

@Injectable()
export class ProjectBoqService implements OnModuleDestroy {
  private readonly log = new Logger(ProjectBoqService.name);
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  private async mayChange(db: Db, claims: TenantClaims, projectId: string, leadOnly: boolean) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && (leadOnly || a.role !== 'member'))
      throw new ForbiddenException({
        code: 'forbidden',
        message: leadOnly
          ? "Only the project's lead or someone allowed to edit projects sets up its contract BOQ and budget."
          : "Only the project's team (not its viewers) adds BOQs.",
      });
  }

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return db`
      SELECT ${db.unsafe(LIST)}, s.name AS "sourceName"
      FROM est.boq b LEFT JOIN est.boq s ON s.id = b.source_boq_id
      WHERE b.project_id = ${projectId}
      ORDER BY b.archived_at IS NOT NULL, b.kind, b.created_at`;
  }

  /** An empty contract BOQ or budget, for work that did not come through a tender (or a package added later). */
  async create(
    claims: TenantClaims,
    projectId: string,
    input: { name: string; kind: ProjectBoqKind; notes: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayChange(db, claims, projectId, false);
    const id = await db.begin(async (tx) => {
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO est.boq (project_id, kind, name, notes, created_by, updated_by)
        VALUES (${projectId}, ${input.kind}, ${input.name}, ${input.notes}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      const data = { boqId: b!.id, name: input.name, kind: input.kind };
      await projectEvent(tx, projectId, 'boq_created', data, claims.sub);
      await audit(tx, claims.sub, 'boq.create', 'boq', b!.id, { projectId, ...data });
      return b!.id;
    });
    const [row] = await db`SELECT ${db.unsafe(LIST)} FROM est.boq b WHERE b.id = ${id}`;
    return row!;
  }

  /**
   * What copying the tender's BOQs would give: each BOQ, the version used, its factor, its total at quoted and at
   * estimate rates, against the project's contract value, and the scale that meets it.
   */
  async preview(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const p = await project(db, projectId);
    const copyNow = await copyState(db, projectId);
    if (!p.tender_id)
      return { tenderId: null, sources: [], copied: false, copy: copyNow, ...scaling(p.value, []) };
    const sources = await this.sources(db, p.tender_id);
    const [c] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM est.boq WHERE project_id = ${projectId} AND source_boq_id IS NOT NULL`;
    return {
      tenderId: p.tender_id,
      copy: copyNow,
      sources: sources.map(({ quotedNormal, provisional, ...s }) => ({
        ...s,
        quotedTotal: add(quotedNormal, provisional),
      })),
      copied: c!.n > 0,
      ...scaling(p.value, sources),
    };
  }

  /**
   * Copies each BOQ of the project's tender into a contract BOQ and a budget, once. Checked here; the copy itself runs
   * in the background (a large BOQ takes minutes) and `preview` reports how it went.
   */
  async fromTender(
    claims: TenantClaims,
    projectId: string,
    input: { matchContractValue: boolean },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayChange(db, claims, projectId, true);
    const state = await copyState(db, projectId);
    if (state?.status === 'copying')
      throw new ConflictException({ code: 'copy_running', message: 'The BOQs are being copied.' });
    const p = await project(db, projectId);
    await this.plan(db, projectId, p, input.matchContractValue);
    const [claimed] = await db`
      INSERT INTO proj.boq_copy (project_id, status, match_contract_value, started_by)
      VALUES (${projectId}, 'copying', ${input.matchContractValue}, ${claims.sub})
      ON CONFLICT (project_id) DO UPDATE SET status = 'copying', match_contract_value = EXCLUDED.match_contract_value,
        result = NULL, error = NULL, started_at = now(), started_by = EXCLUDED.started_by, finished_at = NULL
      WHERE proj.boq_copy.status <> 'copying'
      RETURNING 1`;
    if (!claimed)
      throw new ConflictException({ code: 'copy_running', message: 'The BOQs are being copied.' });
    const done = this.copyAll(db, claims, projectId, input.matchContractValue)
      .catch(async (err: unknown) => {
        const known = err instanceof BadRequestException || err instanceof ConflictException;
        if (!known)
          this.log.error(
            `BOQ copy for project ${projectId}: ${(err as Error).stack ?? String(err)}`,
          );
        const message = known
          ? ((err.getResponse() as { message?: string }).message ?? err.message)
          : `The copy failed: ${(err as Error).message ?? String(err)}`;
        await db`UPDATE proj.boq_copy SET status = 'failed', error = ${message.slice(0, 2000)}, finished_at = now()
          WHERE project_id = ${projectId} AND status = 'copying'`.catch(() => {});
      })
      .finally(() => this.running.delete(projectId));
    this.running.set(projectId, done);
    return { copy: await copyState(db, projectId) };
  }

  /** Lets copies in flight finish (or fail) before the database pool closes. */
  async onModuleDestroy() {
    await Promise.allSettled([...this.running.values()]);
  }

  /** The sources and the scale to use, or why the copy cannot be made. */
  private async plan(db: Db, projectId: string, p: ProjectRow, match: boolean) {
    if (!p.tender_id)
      throw new ConflictException({
        code: 'no_tender',
        message: 'This project did not come from a tender here. Add its BOQs directly.',
      });
    const [copied] = await db`
      SELECT 1 FROM est.boq WHERE project_id = ${projectId} AND source_boq_id IS NOT NULL LIMIT 1`;
    if (copied)
      throw new ConflictException({
        code: 'boqs_copied',
        message: "The tender's BOQs are already this project's. Revise them instead.",
      });
    const sources = await this.sources(db, p.tender_id);
    if (!sources.length)
      throw new ConflictException({
        code: 'no_tender_boqs',
        message: 'The tender has no BOQ to copy.',
      });
    const s = scaling(p.value, sources);
    if (!match) return { tenderId: p.tender_id, sources, scale: '1' };
    if (!s.scale)
      throw new BadRequestException({
        code: 'no_contract_value',
        message: 'Set the contract value first, or copy at the quoted rates.',
      });
    const k = Number(s.scale);
    if (k < MIN_SCALE || k > MAX_SCALE)
      throw new BadRequestException({
        code: 'scale_out_of_range',
        message:
          k > MAX_SCALE
            ? `The contract value is above the quoted rates' total (${s.quotedTotal}, before GST). If it includes GST, enter it without.`
            : 'The contract value is less than half the quoted total. Check it, or copy at the quoted rates.',
      });
    return { tenderId: p.tender_id, sources, scale: s.scale };
  }

  /** The copy, in one transaction: checked again under the project's copy lock, then every BOQ twice. */
  private async copyAll(db: Sql, claims: TenantClaims, projectId: string, match: boolean) {
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${COPY_LOCK}, hashtext(${projectId}))`;
      const p = await project(tx, projectId);
      const { tenderId, sources, scale } = await this.plan(tx, projectId, p, match);
      const made: { sourceBoqId: string; contractId: string; budgetId: string }[] = [];
      for (const src of sources) {
        const basis = {
          factor: src.factor,
          scale,
          ...(src.submitted ? {} : { unsubmitted: true }),
        };
        const contractId = await copy(tx, claims.sub, projectId, src, 'contract', basis);
        const budgetId = await copy(tx, claims.sub, projectId, src, 'budget', {
          factor: '1',
          scale: '1',
        });
        made.push({ sourceBoqId: src.id, contractId, budgetId });
      }
      const [t] = await tx<{ contract: string; budget: string }[]>`
        SELECT coalesce(sum(total) FILTER (WHERE kind = 'contract'), 0)::text AS contract,
          coalesce(sum(total) FILTER (WHERE kind = 'budget'), 0)::text AS budget
        FROM est.boq WHERE project_id = ${projectId} AND source_boq_id IS NOT NULL`;
      // Rates are rounded to paise one by one: a scaled contract misses the value by a little, kept on record.
      const residual = match && p.value ? sub(p.value, t!.contract) : null;
      if (residual !== null)
        await tx`UPDATE est.boq SET rate_basis = rate_basis || ${tx.json({ residual })}
          WHERE project_id = ${projectId} AND kind = 'contract' AND source_boq_id IS NOT NULL`;
      const data = {
        tenderId,
        boqs: made,
        scale,
        contractTotal: t!.contract,
        budgetTotal: t!.budget,
        residual,
      };
      await projectEvent(tx, projectId, 'boqs_from_tender', data, claims.sub);
      await audit(tx, claims.sub, 'project.boqs_from_tender', 'project', projectId, data);
      await tx`UPDATE proj.boq_copy SET status = 'done', result = ${tx.json(JSON.parse(JSON.stringify(data)))},
          finished_at = now()
        WHERE project_id = ${projectId}`;
    });
  }

  /**
   * Budget against contract: the totals and planned margin, and per contract BOQ its top-level lines beside the
   * budget's (matched by line, so sections renamed or re-coded in either still pair up).
   */
  async summary(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const p = await project(db, projectId);
    const [t] = await db<
      { contract: string; budget: string; contracts: number; budgets: number }[]
    >`
      SELECT coalesce(sum(total) FILTER (WHERE kind = 'contract'), 0)::text AS contract,
        coalesce(sum(total) FILTER (WHERE kind = 'budget'), 0)::text AS budget,
        count(*) FILTER (WHERE kind = 'contract')::int AS contracts,
        count(*) FILTER (WHERE kind = 'budget')::int AS budgets
      FROM est.boq WHERE project_id = ${projectId} AND archived_at IS NULL`;
    const pairs = await db<
      {
        contractId: string;
        name: string;
        contract: string;
        budgetId: string | null;
        budget: string | null;
      }[]
    >`
      SELECT c.id AS "contractId", c.name, c.total::text AS contract, bu.id AS "budgetId", bu.total::text AS budget
      FROM est.boq c
      LEFT JOIN est.boq bu ON bu.project_id = c.project_id AND bu.kind = 'budget' AND bu.archived_at IS NULL
        AND bu.source_boq_id = c.source_boq_id
      WHERE c.project_id = ${projectId} AND c.kind = 'contract' AND c.archived_at IS NULL
      ORDER BY c.created_at`;
    const boqs = [];
    for (const pr of pairs) {
      const lines = await db<
        { code: string | null; description: string; contract: string; budget: string | null }[]
      >`
        SELECT cn.code, ct.description,
          (CASE cn.node_type WHEN 'section' THEN cn.subtotal ELSE coalesce(cn.amount, 0) END)::text AS contract,
          (CASE bn.node_type WHEN 'section' THEN bn.subtotal WHEN 'item' THEN coalesce(bn.amount, 0) END)::text
            AS budget
        FROM est.boq_node cn
        JOIN est.boq_node_text ct ON ct.boq_id = cn.boq_id AND ct.node_id = cn.id
        LEFT JOIN est.boq_node bn ON bn.boq_id = ${pr.budgetId} AND bn.line_key = cn.line_key AND bn.depth = 0
        WHERE cn.boq_id = ${pr.contractId} AND cn.depth = 0 AND cn.node_type <> 'note'
        ORDER BY cn.sort_key LIMIT 200`;
      boqs.push({
        ...pr,
        margin: pr.budget === null ? null : sub(pr.contract, pr.budget),
        lines: lines.map((l) => ({
          ...l,
          margin: l.budget === null ? null : sub(l.contract, l.budget),
        })),
      });
    }
    const margin = t!.budgets ? sub(t!.contract, t!.budget) : null;
    return {
      contractValue: p.value,
      contract: t!.contract,
      budget: t!.budget,
      contracts: t!.contracts,
      budgets: t!.budgets,
      margin,
      marginPct: margin !== null && Number(t!.contract) !== 0 ? pct(margin, t!.contract) : null,
      boqs,
    };
  }

  /** The tender's live BOQs, each at its last submitted version (else its current one) and the bid's factor on it. */
  private async sources(db: Db, tenderId: string): Promise<Source[]> {
    const rows = await db<
      {
        id: string;
        name: string;
        currency: string;
        rate_date: string;
        version_no: number;
        status: string;
        total: string;
        estimate: string | null;
        sub_version: number | null;
        sub_factor: string | null;
        cur_factor: string | null;
      }[]
    >`
      SELECT b.id, b.name, b.currency, b.rate_date::text, b.version_no, b.status, b.total::text AS total,
        t.estimated_value::text AS estimate, v.version_no AS sub_version,
        v.scenario -> 'result' ->> 'factor' AS sub_factor,
        (SELECT cv.scenario -> 'result' ->> 'factor' FROM est.boq_version cv
          WHERE cv.boq_id = b.id AND cv.version_no = b.version_no) AS cur_factor
      FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id
      LEFT JOIN LATERAL (
        SELECT version_no, scenario FROM est.boq_version
        WHERE boq_id = b.id AND kind = 'submitted' ORDER BY version_no DESC LIMIT 1
      ) v ON true
      WHERE b.tender_id = ${tenderId} AND b.archived_at IS NULL
      ORDER BY b.created_at`;
    const out: Source[] = [];
    for (const r of rows) {
      const submitted = r.sub_version !== null;
      const version = submitted ? r.sub_version! : r.version_no;
      // A frozen version keeps the bid it carried; a draft is priced by its selected scenario now.
      const factor = submitted
        ? (r.sub_factor ?? '1')
        : r.status !== 'draft'
          ? (r.cur_factor ?? '1')
          : await liveFactor(db, r.id, r.total);
      const [q] = await db<{ normal: string; provisional: string; total: string }[]>`
        SELECT coalesce(sum(round(s.qty * round(s.rate * ${factor}::numeric, 2), 2))
            FILTER (WHERE s.item_kind = 'normal' AND s.qty IS NOT NULL AND s.rate IS NOT NULL), 0)::text AS normal,
          coalesce(sum(s.amount) FILTER (WHERE s.item_kind = 'provisional'), 0)::text AS provisional,
          coalesce(sum(s.amount), 0)::text AS total
        FROM (${stateAt(db, r.id, version, null, false)}) s WHERE s.node_type = 'item'`;
      out.push({
        id: r.id,
        name: r.name,
        currency: r.currency,
        rateDate: r.rate_date,
        version,
        submitted,
        factor,
        quotedNormal: q!.normal,
        provisional: q!.provisional,
        estimateTotal: q!.total,
      });
    }
    return out;
  }
}

interface ProjectRow {
  tender_id: string | null;
  value: string | null;
}

async function project(db: Db, projectId: string): Promise<ProjectRow> {
  const [p] = await db<ProjectRow[]>`
    SELECT tender_id, contract_value::text AS value FROM proj.project WHERE id = ${projectId}`;
  if (!p) throw new NotFoundException({ code: 'project_not_found' });
  return p;
}

/**
 * How the last copy went. A copy holds the project's copy lock while it runs; one still marked as copying whose lock
 * is free (and not just starting) died with its server, and is failed so it can be started again.
 */
async function copyState(db: Sql, projectId: string) {
  return db.begin(async (tx) => {
    const [c] = await tx<CopyState[]>`
      SELECT status, match_contract_value AS "matchContractValue", result, error, started_at AS "startedAt",
        finished_at AS "finishedAt", started_at < now() - interval '1 minute' AS settled
      FROM proj.boq_copy WHERE project_id = ${projectId}`;
    if (!c) return null;
    const { settled, ...state } = c;
    if (state.status !== 'copying' || !settled) return state;
    const [l] = await tx<{ free: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${COPY_LOCK}, hashtext(${projectId})) AS free`;
    if (!l!.free) return state;
    const error = 'The copy stopped when the server restarted. Start it again.';
    await tx`UPDATE proj.boq_copy SET status = 'failed', error = ${error}, finished_at = now()
      WHERE project_id = ${projectId} AND status = 'copying'`;
    return { ...state, status: 'failed' as const, error, finishedAt: new Date() };
  });
}

interface CopyState {
  status: 'copying' | 'done' | 'failed';
  matchContractValue: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  settled: boolean;
}

async function liveFactor(db: Db, boqId: string, total: string) {
  const [s] = await db<
    { markups: Markup[]; gstPct: string; gstMode: GstMode; provisional: string }[]
  >`
    SELECT s.markups, s.gst_pct::text AS "gstPct", s.gst_mode AS "gstMode",
      (SELECT coalesce(sum(n.amount), 0)::text FROM est.boq_node n
        WHERE n.boq_id = s.boq_id AND n.item_kind = 'provisional') AS provisional
    FROM est.pricing_scenario s WHERE s.boq_id = ${boqId} AND s.selected`;
  return s ? priceBid(total, s, null, s.provisional).factor : '1';
}

/**
 * The quoted total of every BOQ against the contract value, and the scale on normal items' quoted rates that meets
 * it (provisional sums stay as they are). Null without a contract value or anything to scale.
 */
function scaling(value: string | null, sources: Source[]) {
  const normal = sources.reduce((a, s) => a + cents(s.quotedNormal), 0n);
  const provisional = sources.reduce((a, s) => a + cents(s.provisional), 0n);
  const quoted = normal + provisional;
  const scale =
    value === null || normal === 0n || !sources.length
      ? null
      : ratio(cents(value) - provisional, normal);
  return {
    contractValue: value,
    quotedTotal: fromCents(quoted),
    estimateTotal: fromCents(sources.reduce((a, s) => a + cents(s.estimateTotal), 0n)),
    scale,
  };
}

/** One contract BOQ or budget from a source version, in one statement for the lines and one for their text. */
async function copy(
  tx: TransactionSql,
  actorId: string,
  projectId: string,
  src: Source,
  kind: ProjectBoqKind,
  basis: Record<string, unknown>,
) {
  const [b] = await tx<{ id: string }[]>`
    INSERT INTO est.boq (project_id, kind, name, currency, rate_date, source_boq_id, source_version_no, rate_basis,
      created_by, updated_by)
    VALUES (${projectId}, ${kind}, ${`${src.name} (${kind})`.slice(0, 200)}, ${src.currency}, ${src.rateDate},
      ${src.id}, ${src.version}, ${tx.json(JSON.parse(JSON.stringify(basis)))}, ${actorId}, ${actorId})
    RETURNING id`;
  const id = b!.id;
  // Quoted rate: the estimate rate × the bid's factor (× the scale to the contract value), rounded to paise as
  // submitted; provisional sums take no markups. A budget keeps the estimate rates.
  const rate =
    kind === 'contract'
      ? tx`CASE WHEN m.rate IS NULL OR m.item_kind = 'provisional' THEN m.rate
          ELSE round(m.rate * ${String(basis.factor)}::numeric * ${String(basis.scale)}::numeric, 2) END`
      : tx`m.rate`;
  const amount =
    kind === 'contract'
      ? tx`CASE WHEN q.item_kind = 'provisional' THEN q.amount
          WHEN q.node_type <> 'item' OR q.item_kind <> 'normal' OR q.qty IS NULL OR q.new_rate IS NULL THEN NULL
          ELSE round(q.qty * q.new_rate, 2) END`
      : tx`q.amount`;
  // Lines keep their line_key: a contract line, its budget line and the tender line it came from share one.
  await tx`
    WITH m AS MATERIALIZED (
      SELECT s.*, nextval('est.boq_node_id_seq') AS new_id
      FROM (${stateAt(tx, src.id, src.version, null, true)}) s
    ),
    q AS (SELECT m.*, ${rate} AS new_rate FROM m),
    kids AS (SELECT parent_id, count(*)::int AS n FROM m WHERE parent_id IS NOT NULL GROUP BY parent_id),
    lines AS (
      INSERT INTO est.boq_node (boq_id, id, line_key, parent_id, sort_key, depth, node_type, code, unit, qty, rate,
        amount, child_count, item_kind)
      SELECT ${id}, q.new_id, q.line_key, pm.new_id, q.sort_key, q.depth, q.node_type, q.code, q.unit, q.qty,
        q.new_rate, ${amount}, CASE WHEN q.node_type = 'section' THEN coalesce(k.n, 0) ELSE 0 END, q.item_kind
      FROM q LEFT JOIN m pm ON pm.id = q.parent_id LEFT JOIN kids k ON k.parent_id = q.id
    )
    INSERT INTO est.boq_node_text (boq_id, node_id, description, notes)
    SELECT ${id}, m.new_id, m.description, m.notes FROM m`;
  await tx`
    UPDATE est.boq b SET node_count = c.nodes, item_count = c.items
    FROM (SELECT count(*)::int AS nodes, count(*) FILTER (WHERE node_type = 'item')::int AS items
      FROM est.boq_node WHERE boq_id = ${id}) c
    WHERE b.id = ${id}`;
  await recomputeTotals(tx, id);
  return id;
}

async function projectEvent(
  tx: TransactionSql,
  projectId: string,
  kind: string,
  data: Record<string, unknown>,
  actorId: string,
) {
  await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
    VALUES (${projectId}, ${kind}, ${tx.json(JSON.parse(JSON.stringify(data)))}, ${actorId})`;
}
