// Read models for the owner console (docs/owner-console.md). Control-plane data only: tenant business data lives in
// each tenant's own database and is never read here.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql } from 'postgres';
import { CONTROL_DB } from '../db/db.module.js';
import { licenceState, type LicenceState, type LicenceStatus } from '../licensing/licence-rules.js';

const DAY_MS = 86_400_000;

interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
  owner_email: string;
  licence_id: string | null;
  licence_kind: string | null;
  tier_id: string | null;
  licence_status: LicenceStatus | null;
  ends_at: Date | null;
  grace_days: number | null;
  seat_cap: number | null;
  key_last4: string | null;
  active_devices: number;
  db_status: string | null;
  db_provider: string | null;
  schema_version: string | null;
}

export interface TenantSummary {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  ownerEmail: string;
  licence: {
    id: string;
    kind: string;
    tierId: string;
    state: LicenceState;
    endsAt: Date;
    seatCap: number;
    keyLast4: string;
    activeDevices: number;
  } | null;
  database: { status: string; provider: string; schemaVersion: string | null } | null;
}

const toSummary = (r: TenantRow, now: Date): TenantSummary => ({
  id: r.id,
  name: r.name,
  status: r.status,
  createdAt: r.created_at,
  ownerEmail: r.owner_email,
  licence:
    r.licence_id && r.licence_kind && r.tier_id && r.licence_status && r.ends_at
      ? {
          id: r.licence_id,
          kind: r.licence_kind,
          tierId: r.tier_id,
          state: licenceState(
            { status: r.licence_status, endsAt: r.ends_at, graceDays: r.grace_days ?? 0 },
            now,
          ),
          endsAt: r.ends_at,
          seatCap: r.seat_cap ?? 0,
          keyLast4: r.key_last4 ?? '',
          activeDevices: r.active_devices,
        }
      : null,
  database:
    r.db_status && r.db_provider
      ? { status: r.db_status, provider: r.db_provider, schemaVersion: r.schema_version }
      : null,
});

@Injectable()
export class OwnerConsoleService {
  constructor(@Inject(CONTROL_DB) private readonly sql: Sql) {}

  /** Tenants with their latest licence and database status, newest first. `q` matches name or owner email. */
  async tenants(
    opts: { q?: string | undefined; limit: number; id?: string },
    now = new Date(),
  ): Promise<TenantSummary[]> {
    const q = opts.q?.trim();
    const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await this.sql<TenantRow[]>`
      SELECT t.id, t.name, t.status, t.created_at, o.email AS owner_email,
             l.id AS licence_id, l.kind AS licence_kind, l.tier_id, l.status AS licence_status, l.ends_at,
             l.grace_days, l.seat_cap, l.key_last4,
             (SELECT count(*)::int FROM core.device_activation d
               WHERE d.licence_id = l.id AND d.revoked_at IS NULL) AS active_devices,
             db.status AS db_status, db.provider AS db_provider, db.schema_version
      FROM core.tenant t
      JOIN core.owner_account o ON o.id = t.owner_account_id
      LEFT JOIN LATERAL (
        SELECT * FROM core.licence WHERE tenant_id = t.id ORDER BY created_at DESC LIMIT 1
      ) l ON true
      LEFT JOIN core.tenant_db db ON db.tenant_id = t.id
      WHERE true
        ${opts.id ? this.sql`AND t.id = ${opts.id}` : this.sql``}
        ${pattern ? this.sql`AND (t.name ILIKE ${pattern} OR o.email ILIKE ${pattern})` : this.sql``}
      ORDER BY t.created_at DESC
      LIMIT ${opts.limit}`;
    return rows.map((r) => toSummary(r, now));
  }

  async tenant(id: string, now = new Date()) {
    const [summary] = await this.tenants({ id, limit: 1 }, now);
    if (!summary) throw new NotFoundException({ code: 'tenant_not_found' });
    const licences = await this.sql`
      SELECT id, kind, tier_id AS "tierId", status, key_last4 AS "keyLast4", starts_at AS "startsAt",
             ends_at AS "endsAt", created_at AS "createdAt"
      FROM core.licence WHERE tenant_id = ${id} ORDER BY created_at DESC`;
    return { ...summary, licences };
  }

  /** Numbers for the overview page. */
  async overview(now = new Date()) {
    const all = await this.tenants({ limit: 100_000 }, now);
    const byState: Record<string, number> = {};
    const byDb: Record<string, number> = {};
    for (const t of all) {
      const s = t.licence?.state ?? 'none';
      byState[s] = (byState[s] ?? 0) + 1;
      const d = t.database?.status ?? 'not_started';
      byDb[d] = (byDb[d] ?? 0) + 1;
    }
    const soon = now.getTime() + 14 * DAY_MS;
    const trialsEndingSoon = all
      .filter(
        (t) =>
          t.licence?.kind === 'trial' &&
          t.licence.state === 'active' &&
          t.licence.endsAt.getTime() <= soon,
      )
      .sort((a, b) => a.licence!.endsAt.getTime() - b.licence!.endsAt.getTime())
      .slice(0, 20)
      .map((t) => ({ id: t.id, name: t.name, endsAt: t.licence!.endsAt }));
    const [email] = await this.sql<{ failed: number; queued: number; sent_last_day: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS failed,
             count(*) FILTER (WHERE status IN ('queued', 'sending'))::int AS queued,
             count(*) FILTER (WHERE sent_at > now() - interval '1 day')::int AS sent_last_day
      FROM core.email_outbox`;
    return {
      tenants: all.length,
      licenceStates: byState,
      databases: byDb,
      trialsEndingSoon,
      email: {
        failedLast7Days: email?.failed ?? 0,
        queued: email?.queued ?? 0,
        sentLastDay: email?.sent_last_day ?? 0,
      },
    };
  }

  /** Owner audit trail, newest first. `before` is the id of the last row of the previous page. */
  audit(opts: { limit: number; before?: number | undefined }) {
    return this.sql`
      SELECT id::text, action, target, data, created_at AS "createdAt" FROM core.owner_audit
      ${opts.before ? this.sql`WHERE id < ${opts.before}` : this.sql``}
      ORDER BY id DESC LIMIT ${opts.limit}`;
  }

  /** Recent tenant-migration rollouts with per-result counts. */
  migrationRuns(limit: number) {
    return this.sql`
      SELECT r.id, r.target_version AS "targetVersion", r.status, r.started_at AS "startedAt",
             r.finished_at AS "finishedAt",
             coalesce(jsonb_object_agg(x.result, x.n) FILTER (WHERE x.result IS NOT NULL), '{}') AS results
      FROM core.migration_run r
      LEFT JOIN LATERAL (
        SELECT result, count(*)::int AS n FROM core.migration_run_tenant WHERE run_id = r.id GROUP BY result
      ) x ON true
      GROUP BY r.id ORDER BY r.started_at DESC LIMIT ${limit}`;
  }

  async operator(id: string) {
    const [op] = await this.sql`
      SELECT id, email, display_name AS "displayName", role, mfa_enabled_at IS NOT NULL AS "mfaEnabled",
             cardinality(recovery_codes)::int AS "recoveryCodesLeft"
      FROM core.operator WHERE id = ${id}`;
    if (!op) throw new NotFoundException({ code: 'operator_not_found' });
    return op;
  }
}
