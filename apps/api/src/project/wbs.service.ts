// A project's WBS and the mapping of its BOQ lines (docs/04-features.md J3, docs/wave2a-plan.md step 3): the WBS tree
// (made by hand or from a BOQ's sections), each BOQ line mapped to a WBS element and a company cost code (one by one or
// a range of lines at once), and the contract and budget broken down by both.
//
// Mappings are kept by line key per project: a contract BOQ line and its budget line share their key (step 2), so one
// mapping covers both, and it survives revisions of either.
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { SUBTREE_END } from '@aerolith/shared';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import type { Patch } from '../tender/tender.service.js';
import { audit } from '../tender/tender-records.js';
import { treeOrder, type CostKind } from './cost-code.service.js';
import { add, cents, fromCents } from './money.js';
import { ProjectService } from './project.service.js';

type Db = Sql | TransactionSql;

/** A WBS deeper than this is not a breakdown anyone can read. */
const MAX_DEPTH = 10;
/** Made from a BOQ: more elements than this means too many section levels were asked for. */
const MAX_FROM_BOQ = 5000;

export interface WbsInput {
  parentId: string | null;
  code: string;
  name: string;
}

export interface WbsRow {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  position: number;
  rowVersion: number;
}

const taken = (err: unknown): never => {
  const e = err as { code?: string; constraint_name?: string };
  if (e.code === '23505')
    throw new ConflictException({
      code: 'code_taken',
      message: 'Another WBS element of this project has that code.',
    });
  throw err;
};

@Injectable()
export class WbsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  /** The project's team works with the WBS; its lead (or someone who edits projects) shapes it. */
  private async may(db: Db, claims: TenantClaims, projectId: string, what: 'shape' | 'map') {
    const a = await this.projects.access(db, claims, projectId);
    if (a.canEdit || (what === 'map' && a.role === 'member')) return;
    throw new ForbiddenException({
      code: 'forbidden',
      message:
        what === 'shape'
          ? "Only the project's lead or someone allowed to edit projects changes its WBS."
          : "Only the project's team (not its viewers) maps BOQ lines.",
    });
  }

  private async projectOf(db: Db, wbsId: string) {
    const [w] = await db<
      { project_id: string }[]
    >`SELECT project_id FROM proj.wbs WHERE id = ${wbsId}`;
    if (!w) throw new NotFoundException({ code: 'wbs_not_found' });
    return w.project_id;
  }

  // --- the tree ---

  /** The WBS in tree order, each element with its depth and the BOQ lines mapped to it directly. */
  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return this.nodes(db, projectId);
  }

  private async nodes(db: Db, projectId: string) {
    const rows = await db<(WbsRow & { lines: number })[]>`
      SELECT w.id, w.parent_id AS "parentId", w.code, w.name, w.position, w.row_version AS "rowVersion",
        (SELECT count(*)::int FROM proj.boq_line_map m WHERE m.project_id = w.project_id AND m.wbs_id = w.id)
          AS lines
      FROM proj.wbs w WHERE w.project_id = ${projectId}`;
    return treeOrder(
      rows,
      (a, b) => a.position - b.position || a.code.localeCompare(b.code, 'en', { numeric: true }),
    );
  }

  async add(claims: TenantClaims, projectId: string, input: WbsInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.may(db, claims, projectId, 'shape');
    await db
      .begin(async (tx) => {
        if (input.parentId) await this.checkParent(tx, projectId, input.parentId, null);
        const [w] = await tx<{ id: string }[]>`
          INSERT INTO proj.wbs (project_id, parent_id, code, name, position, created_by, updated_by)
          SELECT ${projectId}, ${input.parentId}, ${input.code}, ${input.name},
            coalesce(max(position) + 1, 0), ${claims.sub}, ${claims.sub}
          FROM proj.wbs WHERE project_id = ${projectId} AND parent_id IS NOT DISTINCT FROM ${input.parentId}
          RETURNING id`;
        await audit(tx, claims.sub, 'wbs.create', 'wbs', w!.id, { projectId, ...input });
      })
      .catch(taken);
    return this.nodes(db, projectId);
  }

  async update(claims: TenantClaims, id: string, rowVersion: number, input: Patch<WbsInput>) {
    const db = await this.tenants.forTenant(claims.ten);
    const projectId = await this.projectOf(db, id);
    await this.may(db, claims, projectId, 'shape');
    await db
      .begin(async (tx) => {
        const [w] = await tx<{ row_version: number; parent_id: string | null }[]>`
          SELECT row_version, parent_id FROM proj.wbs WHERE id = ${id} FOR UPDATE`;
        if (!w) throw new NotFoundException({ code: 'wbs_not_found' });
        if (w.row_version !== rowVersion)
          throw new ConflictException({
            code: 'stale_row',
            message: 'Someone else changed this WBS element. Reload.',
          });
        const moving = input.parentId !== undefined && input.parentId !== w.parent_id;
        if (moving && input.parentId) await this.checkParent(tx, projectId, input.parentId, id);
        const set: Record<string, unknown> = Object.fromEntries(
          Object.entries({ code: input.code, name: input.name }).filter(([, v]) => v !== undefined),
        );
        if (moving) {
          // Last among its new siblings.
          const [p] = await tx<{ pos: number }[]>`
            SELECT coalesce(max(position) + 1, 0)::int AS pos FROM proj.wbs
            WHERE project_id = ${projectId} AND parent_id IS NOT DISTINCT FROM ${input.parentId ?? null}`;
          Object.assign(set, { parent_id: input.parentId ?? null, position: p!.pos });
        }
        Object.assign(set, { updated_at: new Date(), updated_by: claims.sub });
        await tx`UPDATE proj.wbs SET ${tx(set)}, row_version = row_version + 1 WHERE id = ${id}`;
        await audit(tx, claims.sub, 'wbs.update', 'wbs', id, { projectId, ...input });
      })
      .catch(taken);
    return this.nodes(db, projectId);
  }

  /** Swaps an element with its sibling above or below. */
  async move(claims: TenantClaims, id: string, direction: 'up' | 'down') {
    const db = await this.tenants.forTenant(claims.ten);
    const projectId = await this.projectOf(db, id);
    await this.may(db, claims, projectId, 'shape');
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const siblings = (await this.nodes(tx, projectId)).filter(
        (n, _, all) => n.parentId === all.find((x) => x.id === id)?.parentId,
      );
      const i = siblings.findIndex((n) => n.id === id);
      const j = direction === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= siblings.length) return;
      // Positions may tie (codes break ties): renumber the siblings in their new order.
      const order = siblings.map((n) => n.id);
      [order[i], order[j]] = [order[j]!, order[i]!];
      await tx`
        UPDATE proj.wbs w SET position = o.pos, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1
        FROM unnest(${order}::uuid[]) WITH ORDINALITY AS o(id, pos)
        WHERE w.id = o.id AND w.position IS DISTINCT FROM o.pos`;
    });
    return this.nodes(db, projectId);
  }

  /** Removes an element with nothing under it: no elements, no BOQ lines. */
  async remove(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const projectId = await this.projectOf(db, id);
    await this.may(db, claims, projectId, 'shape');
    await db.begin(async (tx) => {
      const [u] = await tx<{ kids: number; lines: number; activities: number; code: string }[]>`
        SELECT w.code,
          (SELECT count(*)::int FROM proj.wbs c WHERE c.project_id = w.project_id AND c.parent_id = w.id) AS kids,
          (SELECT count(*)::int FROM proj.boq_line_map m WHERE m.project_id = w.project_id AND m.wbs_id = w.id)
            AS lines,
          (SELECT count(*)::int FROM sched.plan p JOIN sched.activity a ON a.plan_id = p.id
            WHERE p.project_id = w.project_id AND a.wbs_id = w.id) AS activities
        FROM proj.wbs w WHERE w.id = ${id} FOR UPDATE`;
      if (!u) throw new NotFoundException({ code: 'wbs_not_found' });
      if (u.kids || u.lines || u.activities)
        throw new ConflictException({
          code: 'wbs_in_use',
          message: u.kids
            ? 'It has elements under it. Move or remove them first.'
            : u.lines
              ? `${u.lines} BOQ lines are mapped to it. Map them elsewhere first.`
              : `${u.activities} schedule activities are on it. Move them to another element first.`,
        });
      await tx`DELETE FROM proj.wbs WHERE id = ${id}`;
      await audit(tx, claims.sub, 'wbs.delete', 'wbs', id, { projectId, code: u.code });
    });
    return this.nodes(db, projectId);
  }

  /**
   * A WBS from a BOQ's sections: each section down to `depth` levels becomes an element (numbered 1, 1.1, 1.1.2...,
   * named after the section), and every item is mapped to the element of its section at that depth. Only into an
   * empty WBS.
   */
  async fromBoq(claims: TenantClaims, projectId: string, boqId: string, depth: number) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.may(db, claims, projectId, 'shape');
    const made = await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const [any] = await tx`SELECT 1 FROM proj.wbs WHERE project_id = ${projectId} LIMIT 1`;
      if (any)
        throw new ConflictException({
          code: 'wbs_not_empty',
          message: 'The project already has a WBS. Add to it by hand.',
        });
      await projectBoq(tx, projectId, boqId);
      const sections = await tx<
        { sort_key: string; depth: number; code: string | null; name: string }[]
      >`
        SELECT n.sort_key, n.depth, n.code, t.description AS name
        FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
        WHERE n.boq_id = ${boqId} AND n.node_type = 'section' AND n.depth < ${depth}
        ORDER BY n.sort_key LIMIT ${MAX_FROM_BOQ + 1}`;
      if (!sections.length)
        throw new BadRequestException({
          code: 'no_sections',
          message: 'The BOQ has no sections to make a WBS from.',
        });
      if (sections.length > MAX_FROM_BOQ)
        throw new BadRequestException({
          code: 'too_many_sections',
          message: `More than ${MAX_FROM_BOQ} sections at these levels. Use fewer levels.`,
        });
      // Numbered by position, from the sort keys: a section's parent key is its own less the last segment.
      const byKey = new Map<string, { id: string; code: string; next: number }>();
      let top = 0;
      const ids: string[] = [];
      const parents: (string | null)[] = [];
      const codes: string[] = [];
      const names: string[] = [];
      const positions: number[] = [];
      const keys: string[] = [];
      for (const s of sections) {
        const parentKey = s.depth === 0 ? null : s.sort_key.slice(0, s.sort_key.lastIndexOf('!'));
        const parent = parentKey === null ? null : byKey.get(parentKey);
        const n = parent ? ++parent.next : ++top;
        const code = parent ? `${parent.code}.${n}` : String(n);
        const id = randomUUID();
        byKey.set(s.sort_key, { id, code, next: 0 });
        ids.push(id);
        parents.push(parent?.id ?? null);
        codes.push(code);
        names.push((s.name.trim() || s.code?.trim() || `Section ${code}`).slice(0, 300));
        positions.push(n);
        keys.push(s.sort_key);
      }
      await tx`
        INSERT INTO proj.wbs (id, project_id, parent_id, code, name, position, created_by, updated_by)
        SELECT u.id, ${projectId}, u.parent_id, u.code, u.name, u.position, ${claims.sub}, ${claims.sub}
        FROM unnest(${ids}::uuid[], ${parents}::uuid[], ${codes}::text[], ${names}::text[], ${positions}::int[])
          AS u(id, parent_id, code, name, position)`;
      // Each item to the element of its ancestor section at the deepest level made (or its own section above it).
      const mapped = await tx`
        INSERT INTO proj.boq_line_map (project_id, line_key, wbs_id, updated_by)
        SELECT ${projectId}, n.line_key, s.id, ${claims.sub}
        FROM est.boq_node n
        JOIN unnest(${keys}::text[], ${ids}::uuid[]) AS s(sort_key, id)
          ON s.sort_key = array_to_string((string_to_array(n.sort_key, '!'))[1:least(n.depth, ${depth})], '!')
        WHERE n.boq_id = ${boqId} AND n.node_type = 'item' AND n.depth > 0
        ON CONFLICT (project_id, line_key) DO UPDATE SET wbs_id = EXCLUDED.wbs_id, updated_at = now(),
          updated_by = EXCLUDED.updated_by`;
      const data = { boqId, depth, elements: ids.length, lines: mapped.count };
      await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
        VALUES (${projectId}, 'wbs_from_boq', ${tx.json(data)}, ${claims.sub})`;
      await audit(tx, claims.sub, 'wbs.from_boq', 'project', projectId, data);
      return data;
    });
    return { ...made, nodes: await this.nodes(db, projectId) };
  }

  private async checkParent(
    tx: TransactionSql,
    projectId: string,
    parentId: string,
    id: string | null,
  ) {
    const [p] = await tx<{ cycle: boolean; depth: number | null; project: boolean }[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, project_id, 1 AS depth FROM proj.wbs WHERE id = ${parentId}
        UNION ALL
        SELECT w.id, w.parent_id, w.project_id, up.depth + 1 FROM proj.wbs w JOIN up ON w.id = up.parent_id
        WHERE up.depth <= ${MAX_DEPTH}
      )
      SELECT coalesce(bool_or(id = ${id}), false) AS cycle, max(depth)::int AS depth,
        coalesce(bool_and(project_id = ${projectId}), false) AS project
      FROM up`;
    if (!p?.depth || !p.project) throw new BadRequestException({ code: 'parent_not_found' });
    if (p.cycle)
      throw new BadRequestException({
        code: 'parent_cycle',
        message: 'A WBS element cannot be under itself.',
      });
    if (p.depth >= MAX_DEPTH)
      throw new BadRequestException({
        code: 'too_deep',
        message: `The WBS goes ${MAX_DEPTH} levels deep at most.`,
      });
  }

  // --- mapping BOQ lines ---

  /**
   * Maps the items among the lines `from`..`to` (a section brings everything under it) of a project BOQ to a WBS
   * element and/or a cost code. `undefined` leaves that side as it is; `null` clears it.
   */
  async map(
    claims: TenantClaims,
    boqId: string,
    input: {
      from: string;
      to: string;
      wbsId?: string | null | undefined;
      costCodeId?: string | null | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db<{ project_id: string | null; archived: boolean }[]>`
      SELECT project_id, archived_at IS NOT NULL AS archived FROM est.boq WHERE id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    if (!b.project_id)
      throw new ConflictException({
        code: 'not_a_project_boq',
        message: "WBS and cost codes are for a project's BOQs.",
      });
    if (b.archived)
      throw new ConflictException({ code: 'boq_archived', message: 'This BOQ is archived.' });
    const projectId = b.project_id;
    await this.may(db, claims, projectId, 'map');
    const setWbs = input.wbsId !== undefined;
    const setCost = input.costCodeId !== undefined;
    if (!setWbs && !setCost)
      throw new BadRequestException({
        code: 'nothing_to_map',
        message: 'Choose a WBS element or a cost code.',
      });
    const [from, to] = input.from <= input.to ? [input.from, input.to] : [input.to, input.from];
    const changed = await db.begin(async (tx) => {
      if (input.wbsId) {
        const [w] =
          await tx`SELECT 1 FROM proj.wbs WHERE id = ${input.wbsId} AND project_id = ${projectId}`;
        if (!w) throw new BadRequestException({ code: 'wbs_not_found' });
      }
      if (input.costCodeId) {
        const [c] = await tx<{ active: boolean }[]>`
          SELECT active FROM platform.cost_code WHERE id = ${input.costCodeId}`;
        if (!c) throw new BadRequestException({ code: 'cost_code_not_found' });
        if (!c.active)
          throw new BadRequestException({
            code: 'cost_code_inactive',
            message: 'That cost code is no longer in use.',
          });
      }
      const inRange = tx`n.boq_id = ${boqId} AND n.node_type = 'item' AND n.sort_key >= ${from}
        AND n.sort_key < ${to + SUBTREE_END}`;
      const wbs = input.wbsId ?? null;
      const cost = input.costCodeId ?? null;
      // New rows only where something is being set; existing rows take the change (a clear included).
      const done = await tx`
        INSERT INTO proj.boq_line_map AS m (project_id, line_key, wbs_id, cost_code_id, updated_by)
        SELECT ${projectId}, n.line_key, ${wbs}::uuid, ${cost}::uuid, ${claims.sub}
        FROM est.boq_node n
        WHERE ${inRange} AND (${wbs !== null || cost !== null} OR EXISTS (
          SELECT 1 FROM proj.boq_line_map e WHERE e.project_id = ${projectId} AND e.line_key = n.line_key))
        ON CONFLICT (project_id, line_key) DO UPDATE SET
          wbs_id = ${setWbs ? tx`EXCLUDED.wbs_id` : tx`m.wbs_id`},
          cost_code_id = ${setCost ? tx`EXCLUDED.cost_code_id` : tx`m.cost_code_id`},
          updated_at = now(), updated_by = EXCLUDED.updated_by`;
      if (wbs === null || cost === null)
        await tx`
          DELETE FROM proj.boq_line_map m USING est.boq_node n
          WHERE m.project_id = ${projectId} AND m.line_key = n.line_key AND ${inRange}
            AND m.wbs_id IS NULL AND m.cost_code_id IS NULL`;
      return done.count;
    });
    return { changed };
  }

  // --- the breakdown ---

  /**
   * The project's live contract BOQs and budgets broken down by WBS (each element with what is under it) and by cost
   * code (groups with their codes), and how much of each is still unmapped.
   */
  async breakdown(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const sums = await db<
      {
        by: 'wbs' | 'cost';
        key: string | null;
        kind: 'contract' | 'budget';
        lines: number;
        amount: string;
      }[]
    >`
      SELECT CASE WHEN GROUPING(m.wbs_id) = 0 THEN 'wbs' ELSE 'cost' END AS by,
        coalesce(m.wbs_id, m.cost_code_id)::text AS key, b.kind, count(*)::int AS lines,
        coalesce(sum(n.amount), 0)::text AS amount
      FROM est.boq b
      JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
      LEFT JOIN proj.boq_line_map m ON m.project_id = b.project_id AND m.line_key = n.line_key
      WHERE b.project_id = ${projectId} AND b.archived_at IS NULL
      GROUP BY GROUPING SETS ((b.kind, m.wbs_id), (b.kind, m.cost_code_id))`;
    const wbs = await this.nodes(db, projectId);
    const codes = treeOrder(
      await db<
        {
          id: string;
          parentId: string | null;
          code: string;
          name: string;
          kind: CostKind;
          active: boolean;
        }[]
      >`
        SELECT c.id, c.parent_id AS "parentId", c.code, c.name, c.kind, c.active FROM platform.cost_code c
        WHERE c.active OR EXISTS (SELECT 1 FROM proj.boq_line_map m
          WHERE m.project_id = ${projectId} AND m.cost_code_id = c.id)`,
    );
    const roll = <T extends { id: string; parentId: string | null }>(
      nodes: T[],
      by: 'wbs' | 'cost',
    ) => {
      const own = new Map<string, { contract: bigint; budget: bigint; lines: number }>();
      for (const s of sums) {
        if (s.by !== by || !s.key) continue;
        const o = own.get(s.key) ?? { contract: 0n, budget: 0n, lines: 0 };
        o[s.kind] += cents(s.amount);
        if (s.kind === 'contract') o.lines += s.lines;
        own.set(s.key, o);
      }
      // Children follow their parent in tree order: add each node into its ancestors, deepest first.
      const total = new Map(
        nodes.map((n) => [n.id, { ...(own.get(n.id) ?? { contract: 0n, budget: 0n, lines: 0 }) }]),
      );
      const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
      for (const n of [...nodes].reverse()) {
        const t = total.get(n.id)!;
        const p = parentOf.get(n.id);
        const pt = p ? total.get(p) : undefined;
        if (pt) {
          pt.contract += t.contract;
          pt.budget += t.budget;
          pt.lines += t.lines;
        }
      }
      return nodes.map((n) => {
        const t = total.get(n.id)!;
        return {
          ...n,
          contract: fromCents(t.contract),
          budget: fromCents(t.budget),
          margin: fromCents(t.contract - t.budget),
          contractLines: t.lines,
        };
      });
    };
    const unmapped = (by: 'wbs' | 'cost', kind: 'contract' | 'budget') => {
      const s = sums.find((x) => x.by === by && x.key === null && x.kind === kind);
      return { lines: s?.lines ?? 0, amount: s?.amount ?? '0.00' };
    };
    const total = (kind: 'contract' | 'budget') =>
      sums
        .filter((s) => s.by === 'wbs' && s.kind === kind)
        .reduce((a, s) => ({ lines: a.lines + s.lines, amount: add(a.amount, s.amount) }), {
          lines: 0,
          amount: '0.00',
        });
    return {
      totals: { contract: total('contract'), budget: total('budget') },
      unmapped: {
        wbs: { contract: unmapped('wbs', 'contract'), budget: unmapped('wbs', 'budget') },
        costCode: { contract: unmapped('cost', 'contract'), budget: unmapped('cost', 'budget') },
      },
      wbs: roll(wbs, 'wbs'),
      costCodes: roll(codes, 'cost'),
    };
  }
}

/** The BOQ is a live BOQ of this project. */
async function projectBoq(db: Db, projectId: string, boqId: string) {
  const [b] = await db<{ archived: boolean }[]>`
    SELECT archived_at IS NOT NULL AS archived FROM est.boq WHERE id = ${boqId} AND project_id = ${projectId}`;
  if (!b)
    throw new BadRequestException({ code: 'boq_not_found', message: 'Not a BOQ of this project.' });
  if (b.archived)
    throw new ConflictException({ code: 'boq_archived', message: 'This BOQ is archived.' });
}
