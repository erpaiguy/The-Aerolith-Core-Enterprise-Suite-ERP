// The company's cost codes (docs/04-features.md J3 and P10, docs/wave2a-plan.md step 3): a short tree of groups and
// codes, each of a kind of cost. Projects map their BOQ lines to them; procurement and accounts will book to them.
// Codes are never deleted: a retired code is made inactive, and lines mapped to it keep it.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import type { Patch } from '../tender/tender.service.js';
import { audit } from '../tender/tender-records.js';

export const COST_KINDS = [
  'material',
  'labour',
  'equipment',
  'subcontract',
  'overhead',
  'other',
] as const;
export type CostKind = (typeof COST_KINDS)[number];

export interface CostCodeInput {
  parentId: string | null;
  code: string;
  name: string;
  kind: CostKind;
  active: boolean;
}

/** A starting list for an Indian contractor; edit or extend it. */
const STANDARD: { code: string; name: string; kind: CostKind; parent?: string }[] = [
  { code: 'MAT', name: 'Materials', kind: 'material' },
  { code: 'MAT.CEM', name: 'Cement', kind: 'material', parent: 'MAT' },
  { code: 'MAT.STL', name: 'Reinforcement and structural steel', kind: 'material', parent: 'MAT' },
  { code: 'MAT.AGG', name: 'Sand and aggregates', kind: 'material', parent: 'MAT' },
  { code: 'MAT.RMC', name: 'Ready-mix concrete', kind: 'material', parent: 'MAT' },
  { code: 'MAT.MAS', name: 'Bricks and blocks', kind: 'material', parent: 'MAT' },
  { code: 'MAT.FIN', name: 'Finishing materials', kind: 'material', parent: 'MAT' },
  { code: 'MAT.MEP', name: 'Electrical and plumbing materials', kind: 'material', parent: 'MAT' },
  { code: 'LAB', name: 'Labour', kind: 'labour' },
  { code: 'LAB.CIV', name: 'Civil labour', kind: 'labour', parent: 'LAB' },
  { code: 'LAB.FIN', name: 'Finishing labour', kind: 'labour', parent: 'LAB' },
  { code: 'PLT', name: 'Plant and equipment', kind: 'equipment' },
  { code: 'PLT.HIR', name: 'Hired equipment', kind: 'equipment', parent: 'PLT' },
  { code: 'PLT.OWN', name: 'Own equipment and fuel', kind: 'equipment', parent: 'PLT' },
  { code: 'SUB', name: 'Subcontracts', kind: 'subcontract' },
  { code: 'SUB.CIV', name: 'Civil subcontracts', kind: 'subcontract', parent: 'SUB' },
  { code: 'SUB.MEP', name: 'MEP subcontracts', kind: 'subcontract', parent: 'SUB' },
  { code: 'SUB.FIN', name: 'Finishing subcontracts', kind: 'subcontract', parent: 'SUB' },
  { code: 'OVH', name: 'Site overheads', kind: 'overhead' },
  { code: 'OVH.STF', name: 'Site staff', kind: 'overhead', parent: 'OVH' },
  { code: 'OVH.CMP', name: 'Site camp and facilities', kind: 'overhead', parent: 'OVH' },
  { code: 'OVH.UTL', name: 'Power and water', kind: 'overhead', parent: 'OVH' },
  { code: 'OVH.INS', name: 'Insurance and bonds', kind: 'overhead', parent: 'OVH' },
];

const COLUMNS = `c.id, c.parent_id AS "parentId", c.code, c.name, c.kind, c.active, c.row_version AS "rowVersion",
  (SELECT count(*)::int FROM proj.boq_line_map m WHERE m.cost_code_id = c.id) AS lines`;

const taken = (err: unknown): never => {
  if ((err as { code?: string }).code === '23505')
    throw new ConflictException({ code: 'code_taken', message: 'That cost code is already used.' });
  throw err;
};

@Injectable()
export class CostCodeService {
  constructor(private readonly tenants: TenantConnections) {}

  /** Every code, in tree order (groups before their codes, each level by code). */
  async list(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      {
        id: string;
        parentId: string | null;
        code: string;
        name: string;
        kind: CostKind;
        active: boolean;
        rowVersion: number;
        lines: number;
      }[]
    >`SELECT ${db.unsafe(COLUMNS)} FROM platform.cost_code c`;
    return treeOrder(rows);
  }

  async create(claims: TenantClaims, input: CostCodeInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        await this.checkParent(tx, input.parentId, null);
        const [c] = await tx<{ id: string }[]>`
          INSERT INTO platform.cost_code (parent_id, code, name, kind, active, created_by, updated_by)
          VALUES (${input.parentId}, ${input.code}, ${input.name}, ${input.kind}, ${input.active}, ${claims.sub},
            ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'cost_code.create', 'cost_code', c!.id, { ...input });
        return c!.id;
      })
      .catch(taken);
    return this.one(claims, id);
  }

  async update(claims: TenantClaims, id: string, rowVersion: number, input: Patch<CostCodeInput>) {
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [c] = await tx<{ row_version: number }[]>`
          SELECT row_version FROM platform.cost_code WHERE id = ${id} FOR UPDATE`;
        if (!c) throw new NotFoundException({ code: 'cost_code_not_found' });
        if (c.row_version !== rowVersion)
          throw new ConflictException({
            code: 'stale_row',
            message: 'Someone else changed this cost code. Reload.',
          });
        if (input.parentId !== undefined) await this.checkParent(tx, input.parentId, id);
        const set = Object.fromEntries(
          Object.entries({
            parent_id: input.parentId,
            code: input.code,
            name: input.name,
            kind: input.kind,
            active: input.active,
          }).filter(([, v]) => v !== undefined),
        );
        await tx`UPDATE platform.cost_code SET ${tx(set)}, updated_at = now(), updated_by = ${claims.sub},
            row_version = row_version + 1
          WHERE id = ${id}`;
        await audit(tx, claims.sub, 'cost_code.update', 'cost_code', id, { ...input });
      })
      .catch(taken);
    return this.one(claims, id);
  }

  /** Loads the standard list into a company that has no cost codes yet. */
  async loadStandard(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`LOCK TABLE platform.cost_code IN SHARE ROW EXCLUSIVE MODE`;
      const [any] = await tx`SELECT 1 FROM platform.cost_code LIMIT 1`;
      if (any)
        throw new ConflictException({
          code: 'cost_codes_exist',
          message: 'The company already has cost codes.',
        });
      const ids = new Map<string, string>();
      for (const c of STANDARD) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO platform.cost_code (parent_id, code, name, kind, created_by, updated_by)
          VALUES (${c.parent ? ids.get(c.parent)! : null}, ${c.code}, ${c.name}, ${c.kind}, ${claims.sub},
            ${claims.sub})
          RETURNING id`;
        ids.set(c.code, row!.id);
      }
      await audit(tx, claims.sub, 'cost_code.load_standard', 'cost_code', ids.get('MAT')!, {
        codes: STANDARD.length,
      });
    });
    return this.list(claims);
  }

  private async one(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [c] = await db`SELECT ${db.unsafe(COLUMNS)} FROM platform.cost_code c WHERE c.id = ${id}`;
    if (!c) throw new NotFoundException({ code: 'cost_code_not_found' });
    return c;
  }

  /** The parent exists and is not the code itself or one of its descendants. Codes are two or three levels deep. */
  private async checkParent(tx: TransactionSql, parentId: string | null, id: string | null) {
    if (!parentId) return;
    const [p] = await tx<{ cycle: boolean; depth: number }[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, 1 AS depth FROM platform.cost_code WHERE id = ${parentId}
        UNION ALL
        SELECT c.id, c.parent_id, up.depth + 1 FROM platform.cost_code c JOIN up ON c.id = up.parent_id
        WHERE up.depth < 20
      )
      SELECT bool_or(id = ${id}) AS cycle, max(depth)::int AS depth FROM up`;
    if (!p || p.depth === null) throw new BadRequestException({ code: 'parent_not_found' });
    if (p.cycle)
      throw new BadRequestException({
        code: 'parent_cycle',
        message: 'A cost code cannot be under itself.',
      });
    if (p.depth >= 4)
      throw new BadRequestException({
        code: 'too_deep',
        message: 'Cost codes go four levels deep at most.',
      });
  }
}

const byCode = (a: { code: string }, b: { code: string }) =>
  a.code.localeCompare(b.code, 'en', { numeric: true });

/** Rows in tree order with their depth: each parent before its children, siblings by `compare` (by code). */
export function treeOrder<T extends { id: string; parentId: string | null; code: string }>(
  rows: T[],
  compare: (a: T, b: T) => number = byCode,
): (T & { depth: number })[] {
  const kids = new Map<string | null, T[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const p = r.parentId && ids.has(r.parentId) ? r.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), r]);
  }
  const out: (T & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    const list = (kids.get(parent) ?? []).sort(compare);
    for (const r of list) {
      out.push({ ...r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
