// Rate contracts (docs/wave7-plan.md step 7c.5): rates agreed with a supplier for resources over a period, perhaps up
// to a quantity. Orders to the supplier for those resources while it runs take the agreed rate (rateFor); each line
// shows what has been ordered against it, from live orders dated in the period.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

type Db = Sql | TransactionSql;

export interface RateContractInput {
  partyId: string;
  reference: string;
  validFrom: string;
  validTo: string;
  notes: string;
  lines: { resourceId: string; rate: string; gstPct: string; maxQty: string | null }[];
}

/** The agreed rate for a resource from a supplier on a day, if a contract in force has one. */
export async function contractRate(db: Db, partyId: string, resourceId: string, on: string) {
  const [r] = await db<{ rate: string; gstPct: string; contractId: string; reference: string }[]>`
    SELECT l.rate::text AS rate, l.gst_pct::text AS "gstPct", c.id AS "contractId", c.reference
    FROM proc.rate_contract c JOIN proc.rate_contract_line l ON l.contract_id = c.id
    WHERE c.party_id = ${partyId} AND l.resource_id = ${resourceId} AND c.status = 'active'
      AND ${on}::date BETWEEN c.valid_from AND c.valid_to
    ORDER BY c.valid_from DESC LIMIT 1`;
  return r ?? null;
}

@Injectable()
export class RateContractService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  private async mayEdit(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'purchase.edit')))
      throw new ForbiddenException({ code: 'permission_denied', permission: 'purchase.edit' });
  }

  async list(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db`
      SELECT c.id, c.reference, to_char(c.valid_from, 'YYYY-MM-DD') AS "validFrom",
        to_char(c.valid_to, 'YYYY-MM-DD') AS "validTo", c.status, c.notes,
        json_build_object('id', p.id, 'name', p.name) AS party,
        coalesce((SELECT json_agg(x ORDER BY x.code) FROM (
          SELECT r.id AS "resourceId", r.code, r.name, r.unit, l.rate::text AS rate, l.gst_pct::text AS "gstPct",
            l.max_qty::text AS "maxQty",
            coalesce((SELECT sum(pl.qty) FROM proc.purchase_order o
              JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
              JOIN proc.po_line pl ON pl.revision_id = v.id AND pl.resource_id = l.resource_id
              WHERE o.party_id = c.party_id AND o.status NOT IN ('cancelled', 'draft')
                AND o.created_at::date BETWEEN c.valid_from AND c.valid_to), 0)::text AS ordered
          FROM proc.rate_contract_line l JOIN est.resource r ON r.id = l.resource_id
          WHERE l.contract_id = c.id) x), '[]') AS lines
      FROM proc.rate_contract c JOIN platform.party p ON p.id = c.party_id
      ORDER BY c.status, c.valid_to DESC, p.name`;
    return { contracts: rows, mayEdit: await this.permissions.can(claims, 'purchase.edit') };
  }

  async create(claims: TenantClaims, b: RateContractInput) {
    await this.mayEdit(claims);
    if (new Set(b.lines.map((l) => l.resourceId)).size !== b.lines.length)
      throw new BadRequestException({
        code: 'duplicate_resource',
        message: 'Each resource once a contract.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [party] =
      await db`SELECT 1 FROM platform.party WHERE id = ${b.partyId} AND deleted_at IS NULL`;
    if (!party) throw new BadRequestException({ code: 'vendor_not_found' });
    // One rate at a time: a contract in force for the same supplier and resource over overlapping days is refused.
    const [clash] = await db<{ reference: string; code: string }[]>`
      SELECT c.reference, r.code FROM proc.rate_contract c JOIN proc.rate_contract_line l ON l.contract_id = c.id
      JOIN est.resource r ON r.id = l.resource_id
      WHERE c.party_id = ${b.partyId} AND c.status = 'active' AND c.valid_from <= ${b.validTo}
        AND c.valid_to >= ${b.validFrom} AND l.resource_id IN ${db(b.lines.map((l) => l.resourceId))} LIMIT 1`;
    if (clash)
      throw new BadRequestException({
        code: 'overlapping_contract',
        message: `${clash.code} already has an agreed rate from this supplier in that period${clash.reference ? ` (${clash.reference})` : ''}.`,
      });
    await db.begin(async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO proc.rate_contract (party_id, reference, valid_from, valid_to, notes, created_by, updated_by)
        VALUES (${b.partyId}, ${b.reference}, ${b.validFrom}, ${b.validTo}, ${b.notes}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      for (const l of b.lines)
        await tx`INSERT INTO proc.rate_contract_line (contract_id, resource_id, rate, gst_pct, max_qty)
          VALUES (${c!.id}, ${l.resourceId}, ${l.rate}, ${l.gstPct}, ${l.maxQty})`;
    });
    return this.list(claims);
  }

  async close(claims: TenantClaims, id: string) {
    await this.mayEdit(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [c] = await db`
      UPDATE proc.rate_contract SET status = 'closed', updated_at = now(), updated_by = ${claims.sub}
      WHERE id = ${id} AND status = 'active' RETURNING id`;
    if (!c) throw new NotFoundException({ code: 'not_found' });
    return this.list(claims);
  }

  async rate(claims: TenantClaims, partyId: string, resourceId: string, on: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return { rate: await contractRate(db, partyId, resourceId, on) };
  }
}
