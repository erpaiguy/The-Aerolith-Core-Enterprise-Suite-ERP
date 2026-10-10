// Progress measurement (docs/04-features.md J6, docs/wave2a-plan.md step 6): the measurement book of a project's
// contract BOQ (quantities done, item by item, from dimensions or as one figure; never changed, put right by reversing
// entries), the physical progress and value of the work done (to a day, and in a period) against the contract BOQ,
// by WBS element and by BOQ section, and the physical progress of schedule activities through the items they carry
// out.
//
// Value done is quantity done × the contract rate, as it will be billed (more than the BOQ quantity counts). Physical
// progress counts no item beyond its BOQ quantity, so an excess on one item does not make up for work not done on
// another.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { SUBTREE_END } from '@aerolith/shared';
import type { TenantClaims } from '../auth/auth.service.js';
import { measuredQty, sumQty, type MeasurementInput } from '../pricing/pricing.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { treeOrder } from './cost-code.service.js';
import { cents, fromCents, ratio } from './money.js';
import { ProjectService } from './project.service.js';

type Db = Sql | TransactionSql;

export interface MeasurementEntry {
  measuredOn: string;
  /** One figure, or the dimensions it comes from. */
  qty?: string | undefined;
  dims?: MeasurementInput[] | undefined;
  description: string;
}

const pctOf = (done: bigint, of: bigint) =>
  of === 0n ? null : Math.round(Number(ratio(done * 1000n, of))) / 10;
/** Today in India: work is measured on Indian days, whatever the server's clock. */
const indiaToday = (now = new Date()) =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

@Injectable()
export class ProgressService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  /** The team records and links; viewers read. */
  private async mayRecord(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) records progress.",
      });
  }

  /** The item of a project's contract BOQ that is measured. */
  private async item(db: Db, boqId: string, lineId: string) {
    const [n] = await db<
      {
        project_id: string | null;
        kind: string;
        archived: boolean;
        line_key: string;
        node_type: string;
        code: string | null;
        unit: string | null;
        qty: string | null;
        rate: string | null;
      }[]
    >`
      SELECT b.project_id, b.kind, b.archived_at IS NOT NULL AS archived, n.line_key, n.node_type, n.code, n.unit,
        n.qty::text AS qty, n.rate::text AS rate
      FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id
      WHERE b.id = ${boqId} AND n.id = ${lineId}`;
    if (!n) throw new NotFoundException({ code: 'line_not_found' });
    if (!n.project_id || n.kind !== 'contract')
      throw new ConflictException({
        code: 'not_a_contract_boq',
        message: "Progress is measured against a project's contract BOQ.",
      });
    if (n.node_type !== 'item')
      throw new BadRequestException({
        code: 'not_an_item',
        message: 'Measure an item, not a section or a note.',
      });
    return { ...n, project_id: n.project_id };
  }

  // --- the measurement book ---

  /** An item's entries, newest first, with what is done in all against its BOQ quantity. */
  async book(claims: TenantClaims, boqId: string, lineId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const n = await this.item(db, boqId, lineId);
    await this.projects.access(db, claims, n.project_id);
    return this.bookOf(db, n);
  }

  private async bookOf(db: Db, n: Awaited<ReturnType<ProgressService['item']>>) {
    const entries = await db<
      {
        id: string;
        measuredOn: string;
        qty: string;
        dims: MeasurementInput[] | null;
        description: string;
        reverses: string | null;
        reversedBy: string | null;
        createdAt: string;
        createdBy: string | null;
      }[]
    >`
      SELECT m.id, to_char(m.measured_on, 'YYYY-MM-DD') AS "measuredOn", m.qty::text AS qty, m.dims, m.description,
        m.reverses, (SELECT r.id FROM proj.measurement r WHERE r.reverses = m.id) AS "reversedBy",
        m.created_at AS "createdAt", u.display_name AS "createdBy"
      FROM proj.measurement m LEFT JOIN platform."user" u ON u.id = m.created_by
      WHERE m.project_id = ${n.project_id} AND m.line_key = ${n.line_key}
      ORDER BY m.measured_on DESC, m.created_at DESC`;
    const done = sumQty(entries.map((e) => e.qty));
    return {
      code: n.code,
      unit: n.unit,
      qty: n.qty,
      rate: n.rate,
      done,
      pct:
        n.qty && Number(n.qty) !== 0
          ? Math.round((Number(done) / Number(n.qty)) * 1000) / 10
          : null,
      entries,
    };
  }

  /** Records a quantity done on an item, from dimensions or as one figure. */
  async record(claims: TenantClaims, boqId: string, lineId: string, input: MeasurementEntry) {
    const db = await this.tenants.forTenant(claims.ten);
    const n = await this.item(db, boqId, lineId);
    if (n.archived)
      throw new ConflictException({ code: 'boq_archived', message: 'This BOQ is archived.' });
    await this.mayRecord(db, claims, n.project_id);
    if (input.measuredOn > indiaToday())
      throw new BadRequestException({
        code: 'measured_in_future',
        message: 'Work is measured when it is done, not before.',
      });
    let qty: string;
    if (input.dims?.length) {
      try {
        qty = sumQty(input.dims.map(measuredQty));
      } catch (err) {
        throw new BadRequestException({ code: 'bad_dimensions', message: (err as Error).message });
      }
    } else if (input.qty) qty = input.qty;
    else
      throw new BadRequestException({
        code: 'no_quantity',
        message: 'Give a quantity or its dimensions.',
      });
    if (Number(qty) === 0)
      throw new BadRequestException({
        code: 'no_quantity',
        message: 'The quantity comes to nothing.',
      });
    await db.begin(async (tx) => {
      const [m] = await tx<{ id: string }[]>`
        INSERT INTO proj.measurement (project_id, boq_id, line_key, measured_on, qty, dims, description, created_by)
        VALUES (${n.project_id}, ${boqId}, ${n.line_key}, ${input.measuredOn}, ${qty},
          ${input.dims?.length ? tx.json(JSON.parse(JSON.stringify(input.dims))) : null}, ${input.description},
          ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'progress.record', 'measurement', m!.id, {
        boqId,
        code: n.code,
        qty,
        measuredOn: input.measuredOn,
      });
    });
    return this.bookOf(db, n);
  }

  /** Puts a wrong entry right: an entry of the opposite quantity, on the day it is reversed. */
  async reverse(claims: TenantClaims, boqId: string, entryId: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db<
      {
        project_id: string;
        line_key: string;
        boq_id: string;
        qty: string;
        reverses: string | null;
        reversed: boolean;
      }[]
    >`
      SELECT m.project_id, m.line_key, m.boq_id, m.qty::text AS qty, m.reverses,
        EXISTS (SELECT 1 FROM proj.measurement r WHERE r.reverses = m.id) AS reversed
      FROM proj.measurement m WHERE m.id = ${entryId}`;
    if (!e) throw new NotFoundException({ code: 'entry_not_found' });
    await this.mayRecord(db, claims, e.project_id);
    if (e.reverses || e.reversed)
      throw new ConflictException({
        code: 'already_reversed',
        message: e.reverses
          ? 'This entry is itself a reversal.'
          : 'This entry is already reversed.',
      });
    const [line] = await db<{ id: string }[]>`
      SELECT n.id::text FROM est.boq_node n WHERE n.boq_id = ${boqId} AND n.line_key = ${e.line_key}`;
    if (!line) throw new NotFoundException({ code: 'line_not_found' });
    await db.begin(async (tx) => {
      try {
        const [m] = await tx<{ id: string }[]>`
          INSERT INTO proj.measurement (project_id, boq_id, line_key, measured_on, qty, description, reverses,
            created_by)
          VALUES (${e.project_id}, ${e.boq_id}, ${e.line_key}, ${indiaToday()}, -(${e.qty}::numeric),
            ${`Reversal: ${reason}`.slice(0, 500)}, ${entryId}, ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'progress.reverse', 'measurement', m!.id, {
          reverses: entryId,
          reason,
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'already_reversed',
            message: 'This entry is already reversed.',
          });
        throw err;
      }
    });
    return this.book(claims, boqId, line.id);
  }

  // --- the progress of the project ---

  /**
   * Work done to `to` (and in `from`..`to`) against the project's live contract BOQs: value at contract rates,
   * physical progress, the budget value of the same work; by contract BOQ and its top-level sections, and by WBS
   * element (rolled up the tree).
   */
  async report(claims: TenantClaims, projectId: string, from: string, to: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    interface Sum {
      value: string;
      done: string;
      physical: string;
      period: string;
      budget: string;
      started: number;
      over: number;
      items: number;
    }
    // Each item of the live contract BOQs with what is done on it, its budget rate and WBS element; added up by
    // contract BOQ, by its top-level sections and by WBS element in one pass.
    const groups = await db<
      (Sum & {
        by: 'boq' | 'section' | 'wbs';
        boq_id: string | null;
        top: string | null;
        wbs_id: string | null;
      })[]
    >`
      WITH done AS (
        SELECT line_key, sum(qty) FILTER (WHERE measured_on <= ${to}) AS qty,
          sum(qty) FILTER (WHERE measured_on BETWEEN ${from} AND ${to}) AS period
        FROM proj.measurement WHERE project_id = ${projectId} GROUP BY line_key
      ),
      budget AS (
        SELECT DISTINCT ON (bn.line_key) bn.line_key, bn.rate
        FROM est.boq bb JOIN est.boq_node bn ON bn.boq_id = bb.id AND bn.node_type = 'item'
        WHERE bb.project_id = ${projectId} AND bb.kind = 'budget' AND bb.archived_at IS NULL
        ORDER BY bn.line_key, bb.created_at
      ),
      l AS (
        SELECT b.id AS boq_id, split_part(n.sort_key, '!', 1) AS top, n.qty, n.rate, n.amount,
          coalesce(d.qty, 0) AS done, coalesce(d.period, 0) AS period, m.wbs_id, bu.rate AS budget_rate
        FROM est.boq b
        JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
        LEFT JOIN done d ON d.line_key = n.line_key
        LEFT JOIN budget bu ON bu.line_key = n.line_key
        LEFT JOIN proj.boq_line_map m ON m.project_id = b.project_id AND m.line_key = n.line_key
        WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
      )
      SELECT CASE WHEN GROUPING(wbs_id) = 0 THEN 'wbs' WHEN GROUPING(top) = 0 THEN 'section' ELSE 'boq' END AS by,
        boq_id, top, wbs_id,
        coalesce(sum(amount), 0)::text AS value,
        coalesce(sum(CASE WHEN amount IS NULL THEN 0 ELSE round(done * rate, 2) END), 0)::text AS done,
        coalesce(sum(CASE WHEN amount IS NULL THEN 0
          ELSE round(least(done, greatest(qty, 0)) * rate, 2) END), 0)::text AS physical,
        coalesce(sum(CASE WHEN amount IS NULL THEN 0 ELSE round(period * rate, 2) END), 0)::text AS period,
        coalesce(sum(round(done * coalesce(budget_rate, 0), 2)), 0)::text AS budget,
        count(*) FILTER (WHERE done <> 0)::int AS started,
        count(*) FILTER (WHERE qty IS NOT NULL AND done > qty)::int AS over,
        count(*)::int AS items
      FROM l GROUP BY GROUPING SETS ((boq_id), (boq_id, top), (wbs_id))`;
    const byBoq = groups.filter((g) => g.by === 'boq');
    const bySection = groups.filter((g) => g.by === 'section');
    const byWbs = groups.filter((g) => g.by === 'wbs');
    const view = (s: Sum) => ({
      value: s.value,
      done: s.done,
      period: s.period,
      budgetDone: s.budget,
      /** Physical progress: work done within the BOQ quantities, by contract value. */
      pct: pctOf(cents(s.physical), cents(s.value)),
      items: s.items,
      itemsStarted: s.started,
      itemsOver: s.over,
    });
    const add = (a: Sum, b: Sum): Sum => ({
      value: fromCents(cents(a.value) + cents(b.value)),
      done: fromCents(cents(a.done) + cents(b.done)),
      physical: fromCents(cents(a.physical) + cents(b.physical)),
      period: fromCents(cents(a.period) + cents(b.period)),
      budget: fromCents(cents(a.budget) + cents(b.budget)),
      started: a.started + b.started,
      over: a.over + b.over,
      items: a.items + b.items,
    });
    const ZERO: Sum = {
      value: '0.00',
      done: '0.00',
      physical: '0.00',
      period: '0.00',
      budget: '0.00',
      started: 0,
      over: 0,
      items: 0,
    };
    const boqs = await db<{ id: string; name: string }[]>`
      SELECT id, name FROM est.boq WHERE project_id = ${projectId} AND kind = 'contract' AND archived_at IS NULL
      ORDER BY created_at`;
    const tops = await db<
      { boq_id: string; sort_key: string; code: string | null; description: string }[]
    >`
      SELECT n.boq_id, n.sort_key, n.code, t.description
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ANY(${boqs.map((b) => b.id)}::uuid[]) AND n.depth = 0 AND n.node_type = 'section'`;
    const topName = new Map(tops.map((t) => [`${t.boq_id}/${t.sort_key}`, t]));
    const total = byBoq.reduce(add, ZERO);

    // WBS: each element with what is mapped to it, then everything under it added in.
    const nodes = treeOrder(
      await db<
        { id: string; parentId: string | null; code: string; name: string; position: number }[]
      >`
        SELECT id, parent_id AS "parentId", code, name, position FROM proj.wbs WHERE project_id = ${projectId}`,
      (a, b) => a.position - b.position || a.code.localeCompare(b.code, 'en', { numeric: true }),
    );
    const own = new Map(nodes.map((n) => [n.id, { ...ZERO }]));
    for (const w of byWbs)
      if (w.wbs_id && own.has(w.wbs_id)) own.set(w.wbs_id, add(own.get(w.wbs_id)!, w));
    const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
    for (const n of [...nodes].reverse()) {
      const p = parentOf.get(n.id);
      if (p && own.has(p)) own.set(p, add(own.get(p)!, own.get(n.id)!));
    }
    const unmapped = byWbs.find((w) => w.wbs_id === null);
    return {
      from,
      to,
      total: view(total),
      boqs: boqs.map((b) => ({
        id: b.id,
        name: b.name,
        ...view(byBoq.find((x) => x.boq_id === b.id) ?? ZERO),
        sections: bySection
          .filter((s) => s.boq_id === b.id)
          .sort((x, y) => ((x.top ?? '') < (y.top ?? '') ? -1 : 1))
          .map((s) => {
            const t = topName.get(`${b.id}/${s.top}`);
            return {
              code: t?.code ?? null,
              description: t ? t.description : 'Items outside sections',
              ...view(s),
            };
          }),
      })),
      wbs: nodes.map((n) => ({
        id: n.id,
        code: n.code,
        name: n.name,
        depth: n.depth,
        ...view(own.get(n.id)!),
      })),
      unmapped: unmapped ? view(unmapped) : null,
    };
  }

  // --- schedule activities and the items they carry out ---

  private async activity(db: Db, planId: string, activityId: string) {
    const [a] = await db<{ project_id: string | null; kind: string; code: string }[]>`
      SELECT p.project_id, a.kind, a.code FROM sched.plan p
      JOIN sched.activity a ON a.plan_id = p.id AND a.id = ${activityId}
      WHERE p.id = ${planId}`;
    if (!a) throw new NotFoundException({ code: 'activity_not_found' });
    if (!a.project_id)
      throw new ConflictException({
        code: 'not_for_tender_programme',
        message: "A tender's programme has no progress.",
      });
    return { ...a, project_id: a.project_id };
  }

  /** The contract BOQ items an activity carries out, what is done on each, and its physical progress. */
  async activityLines(claims: TenantClaims, planId: string, activityId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.activity(db, planId, activityId);
    await this.projects.access(db, claims, a.project_id);
    return this.linesOf(db, planId, activityId, a.project_id);
  }

  private async linesOf(db: Db, planId: string, activityId: string, projectId: string) {
    const lines = await db<
      {
        lineKey: string;
        boqId: string;
        code: string | null;
        description: string;
        unit: string | null;
        qty: string | null;
        amount: string | null;
        done: string;
        physical: string;
      }[]
    >`
      SELECT al.line_key AS "lineKey", n.boq_id AS "boqId", n.code, t.description, n.unit, n.qty::text AS qty,
        n.amount::text AS amount, coalesce(d.qty, 0)::text AS done,
        CASE WHEN n.amount IS NULL THEN 0 ELSE round(least(coalesce(d.qty, 0), greatest(n.qty, 0)) * n.rate, 2)
          END::text AS physical
      FROM sched.activity_line al
      JOIN est.boq b ON b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
      JOIN est.boq_node n ON n.boq_id = b.id AND n.line_key = al.line_key
      JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      LEFT JOIN (SELECT line_key, sum(qty) AS qty FROM proj.measurement WHERE project_id = ${projectId}
        GROUP BY line_key) d ON d.line_key = al.line_key
      WHERE al.plan_id = ${planId} AND al.activity_id = ${activityId}
      ORDER BY n.boq_id, n.sort_key LIMIT 2000`;
    const value = lines.reduce((s, l) => s + cents(l.amount ?? '0'), 0n);
    const physical = lines.reduce((s, l) => s + cents(l.physical), 0n);
    return {
      lines: lines.map(({ physical: _, ...l }) => l),
      value: fromCents(value),
      physicalPct: pctOf(physical, value),
    };
  }

  /**
   * Links the items of a contract BOQ line to an activity: an item by its code, or a section by its code with every
   * item under it.
   */
  async link(
    claims: TenantClaims,
    planId: string,
    activityId: string,
    input: { boqId: string; code: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.activity(db, planId, activityId);
    await this.mayRecord(db, claims, a.project_id);
    if (a.kind === 'summary')
      throw new BadRequestException({
        code: 'not_a_task',
        message: `${a.code} is a summary: link items to the activities under it.`,
      });
    const found = await db<{ sort_key: string; node_type: string }[]>`
      SELECT n.sort_key, n.node_type FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id
      WHERE b.id = ${input.boqId} AND b.project_id = ${a.project_id} AND b.kind = 'contract'
        AND lower(n.code) = lower(${input.code}) AND n.node_type <> 'note'
      LIMIT 2`;
    if (!found.length)
      throw new BadRequestException({
        code: 'code_not_found',
        message: `No item or section ${input.code} in that contract BOQ.`,
      });
    if (found.length > 1)
      throw new BadRequestException({
        code: 'code_ambiguous',
        message: `More than one line is coded ${input.code}; recode one first.`,
      });
    const k = found[0]!.sort_key;
    const linked = await db`
      INSERT INTO sched.activity_line (plan_id, activity_id, line_key)
      SELECT ${planId}, ${activityId}, n.line_key FROM est.boq_node n
      WHERE n.boq_id = ${input.boqId} AND n.node_type = 'item' AND n.sort_key >= ${k}
        AND n.sort_key < ${k + SUBTREE_END}
      ON CONFLICT DO NOTHING`;
    return { added: linked.count, ...(await this.linesOf(db, planId, activityId, a.project_id)) };
  }

  async unlink(claims: TenantClaims, planId: string, activityId: string, lineKey: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.activity(db, planId, activityId);
    await this.mayRecord(db, claims, a.project_id);
    await db`DELETE FROM sched.activity_line WHERE plan_id = ${planId} AND activity_id = ${activityId}
      AND line_key = ${lineKey}`;
    return this.linesOf(db, planId, activityId, a.project_id);
  }
}
