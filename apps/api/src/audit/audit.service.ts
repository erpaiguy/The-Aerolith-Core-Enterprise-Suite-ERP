// The audit trail (docs/wave7-plan.md step 7a.8): who did what to which record, newest first, from platform.audit_log
// (written by services and by the row trigger of migration 0072). Admin only; filtered by person, record and dates.
import { Injectable } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export interface AuditQuery {
  userId?: string | undefined;
  entity?: string | undefined;
  entityId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  before?: number | undefined;
}

const PAGE = 200;

@Injectable()
export class AuditService {
  constructor(private readonly tenants: TenantConnections) {}

  async list(claims: TenantClaims, q: AuditQuery) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      {
        id: number;
        at: string;
        actorId: string | null;
        actor: string | null;
        action: string;
        entity: string;
        entityId: string | null;
        data: Record<string, unknown>;
      }[]
    >`
      SELECT a.id::int AS id, a.created_at AS at, a.actor_id AS "actorId", u.display_name AS actor, a.action,
        a.entity, a.entity_id AS "entityId", a.data
      FROM platform.audit_log a LEFT JOIN platform."user" u ON u.id = a.actor_id
      WHERE true
        ${q.userId ? db`AND a.actor_id = ${q.userId}` : db``}
        ${q.entity ? db`AND a.entity = ${q.entity}` : db``}
        ${q.entityId ? db`AND a.entity_id = ${q.entityId}` : db``}
        ${q.from ? db`AND a.created_at >= (${q.from}::date AT TIME ZONE 'Asia/Kolkata')` : db``}
        ${q.to ? db`AND a.created_at < ((${q.to}::date + 1) AT TIME ZONE 'Asia/Kolkata')` : db``}
        ${q.before ? db`AND a.id < ${q.before}` : db``}
      ORDER BY a.id DESC LIMIT ${PAGE + 1}`;
    const kinds = await db<{ entity: string }[]>`
      SELECT DISTINCT entity FROM platform.audit_log ORDER BY entity`;
    return {
      rows: rows.slice(0, PAGE),
      more: rows.length > PAGE,
      entities: kinds.map((k) => k.entity),
    };
  }
}
