// Dashboards (docs/wave1-plan.md step 12 part 2, docs/08-dashboard.md §2.3, §2.4, §2.6): the tender and bid dashboard
// and the estimation dashboard. Each answer carries its "as of" time, the filters it was made with, the headline
// tiles, the user's own tiles, the catalogue they can add from, and the figures behind the charts. Everything is read
// live with aggregate queries; nothing is cached, so a dashboard is never older than its "as of".
import { BadRequestException, Injectable } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import type { PendingQuery, Row, Sql } from 'postgres';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';
import { CycleError, TooDeepError, type Costing } from '../rates/engine.js';
import { RatesService } from '../rates/rates.service.js';
import { breakdown, type Breakdown } from '../reports/cost-breakdown.js';
import { financialYear, TENDER_STATUSES, type TenderStatus } from '../tender/tender-rules.js';
import {
  fyRange,
  tilesOf,
  type DashboardFilter,
  type DashboardName,
  type TileDef,
  type TileValue,
} from './tiles.js';

/** Filters as asked for; a missing year means the current one. */
export interface InputFilter {
  fy?: string | undefined;
  vertical?: string | undefined;
  ownerId?: string | undefined;
}

export interface Tile extends TileValue {
  key: string;
  label: string;
  hint: string;
}

interface Common {
  dashboard: DashboardName;
  asOf: string;
  filter: DashboardFilter;
  years: string[];
  owners: { id: string; name: string }[];
  fixed: Tile[];
  tiles: Tile[];
  catalogue: { key: string; label: string; hint: string }[];
  /** How long the figures took to read, for the 300 ms rule (docs/08-dashboard.md §1). */
  tookMs: number;
}

export interface TenderDashboard extends Common {
  dashboard: 'tender';
  charts: {
    stages: { status: TenderStatus; count: number; estimatedValue: string }[];
    quarters: { quarter: string; submitted: number; won: number; lost: number; wonValue: string }[];
    verticals: { vertical: string; open: number; won: number; lost: number }[];
    upcoming: {
      at: string;
      kind: 'submission' | 'prebid' | 'queries' | 'opening' | 'security';
      label: string;
      tender: { id: string; number: string; title: string };
    }[];
    rfqs: {
      id: string;
      number: string;
      title: string;
      dueOn: string | null;
      vendors: number;
      quoted: number;
      tender: { id: string; number: string };
    }[];
  };
}

export interface EstimationDashboard extends Common {
  dashboard: 'estimation';
  charts: {
    estimators: {
      id: string | null;
      name: string;
      boqs: number;
      value: string;
      unpriced: number;
    }[];
    topBoqs: {
      id: string;
      name: string;
      total: string;
      versionNo: number;
      tender: { id: string; number: string; title: string };
    }[];
    revisions: {
      id: string;
      name: string;
      tenderNumber: string;
      versions: number;
      first: string;
      latest: string;
      current: string;
      changePct: string | null;
    }[];
    breakdown: Breakdown;
    rateChanges: {
      code: string;
      name: string;
      unit: string;
      rate: string;
      previous: string | null;
      effectiveFrom: string;
      changePct: string | null;
    }[];
  };
}

const OPEN = ['lead', 'evaluating', 'bidding', 'submitted'];

@Injectable()
export class DashboardService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly rates: RatesService,
  ) {}

  /** The tiles this user may see on a dashboard: all of them, less the pricing ones without the permission. */
  private async allowed(claims: TenantClaims, d: DashboardName): Promise<TileDef[]> {
    const canPrice = await this.permissions.can(claims, 'pricing.edit');
    return tilesOf(d).filter((t) => canPrice || !t.pricing);
  }

  async layout(claims: TenantClaims, d: DashboardName): Promise<string[]> {
    const db = await this.tenants.forTenant(claims.ten);
    const [row] = await db<{ tiles: string[] }[]>`
      SELECT tiles FROM platform.dashboard_layout WHERE user_id = ${claims.sub} AND dashboard = ${d}`;
    return row?.tiles ?? [];
  }

  /** Saves the user's own tiles, in order. Keys must be catalogue tiles of this dashboard the user may see. */
  async saveLayout(claims: TenantClaims, d: DashboardName, tiles: string[]) {
    const allowed = new Map((await this.allowed(claims, d)).map((t) => [t.key, t]));
    for (const k of tiles) {
      const t = allowed.get(k);
      if (!t || t.fixed)
        throw new BadRequestException({
          code: 'unknown_tile',
          message: `"${k}" is not a tile you can add to this dashboard.`,
        });
    }
    if (new Set(tiles).size !== tiles.length)
      throw new BadRequestException({ code: 'duplicate_tile', message: 'A tile is listed twice.' });
    const db = await this.tenants.forTenant(claims.ten);
    await db`INSERT INTO platform.dashboard_layout (user_id, dashboard, tiles)
      VALUES (${claims.sub}, ${d}, ${tiles}) ON CONFLICT (user_id, dashboard)
      DO UPDATE SET tiles = EXCLUDED.tiles, updated_at = now()`;
    return { tiles };
  }

  private async common(claims: TenantClaims, d: DashboardName, input: InputFilter, now: Date) {
    const db = await this.tenants.forTenant(claims.ten);
    const filter: DashboardFilter = {
      fy: input.fy ?? financialYear(now),
      vertical: input.vertical,
      ownerId: input.ownerId,
    };
    const { from, to } = fyRange(filter.fy);
    const scope = db`${filter.vertical ? db`AND t.vertical = ${filter.vertical}` : db``}
      ${filter.ownerId ? db`AND t.owner_id = ${filter.ownerId}` : db``}`;
    const allowed = await this.allowed(claims, d);
    const saved = (await this.layout(claims, d))
      .map((k) => allowed.find((t) => t.key === k))
      .filter((t): t is TileDef => t !== undefined && !t.fixed);
    const fixed = allowed.filter((t) => t.fixed);
    const ctx = { db, f: filter, now, from, to, scope };
    const compute = (ts: TileDef[]) =>
      Promise.all(
        ts.map(async (t) => ({
          key: t.key,
          label: t.label,
          hint: t.hint,
          ...(await t.compute(ctx)),
        })),
      );
    const [fixedTiles, ownTiles, years, owners] = await Promise.all([
      compute(fixed),
      compute(saved),
      db<{ m: string }[]>`
        SELECT DISTINCT to_char(coalesce(submission_due_at, created_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS m
        FROM tender.tender`,
      db<{ id: string; name: string }[]>`
        SELECT DISTINCT u.id, u.display_name AS name FROM tender.tender t
        JOIN platform."user" u ON u.id = t.owner_id ORDER BY 2`,
    ]);
    // An IST month "2026-03" is in the year starting 2025.
    const fyOfMonth = (m: string) => {
      const y = Number(m.slice(0, 4)) - (Number(m.slice(5)) < 4 ? 1 : 0);
      return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
    };
    const yearList = [
      ...new Set([filter.fy, financialYear(now), ...years.map((y) => fyOfMonth(y.m))]),
    ]
      .sort()
      .reverse();
    return {
      db,
      filter,
      scope,
      from,
      to,
      base: {
        asOf: now.toISOString(),
        filter,
        years: yearList,
        owners: [...owners],
        fixed: fixedTiles,
        tiles: ownTiles,
        catalogue: allowed
          .filter((t) => !t.fixed)
          .map((t) => ({ key: t.key, label: t.label, hint: t.hint })),
      },
    };
  }

  async tender(
    claims: TenantClaims,
    input: InputFilter,
    now = new Date(),
  ): Promise<TenderDashboard> {
    const started = performance.now();
    const { db, scope, from, to, base } = await this.common(claims, 'tender', input, now);
    const [stages, results, verticals, upcoming, rfqs] = await Promise.all([
      db<{ status: TenderStatus; count: number; estimatedValue: string }[]>`
        SELECT t.status, count(*)::int AS count, round(coalesce(sum(t.estimated_value), 0), 2)::text AS "estimatedValue"
        FROM tender.tender t WHERE true ${scope} GROUP BY t.status`,
      db<{ kind: 'submitted' | 'won' | 'lost'; at: Date; value: string | null }[]>`
        SELECT 'submitted' AS kind, min(s.submitted_at) AS at, NULL AS value
        FROM tender.tender t JOIN tender.submission s ON s.tender_id = t.id WHERE true ${scope}
        GROUP BY t.id HAVING min(s.submitted_at) >= ${from} AND min(s.submitted_at) < ${to}
        UNION ALL
        SELECT t.status, coalesce(t.result_on::timestamptz, t.updated_at), t.awarded_value::text
        FROM tender.tender t WHERE t.status IN ('won', 'lost')
          AND coalesce(t.result_on::timestamptz, t.updated_at) >= ${from}
          AND coalesce(t.result_on::timestamptz, t.updated_at) < ${to} ${scope}`,
      db<{ vertical: string; open: number; won: number; lost: number }[]>`
        SELECT t.vertical, count(*) FILTER (WHERE t.status IN ${db(OPEN)})::int AS open,
          count(*) FILTER (WHERE t.status = 'won' AND coalesce(t.result_on::timestamptz, t.updated_at) >= ${from}
            AND coalesce(t.result_on::timestamptz, t.updated_at) < ${to})::int AS won,
          count(*) FILTER (WHERE t.status = 'lost' AND coalesce(t.result_on::timestamptz, t.updated_at) >= ${from}
            AND coalesce(t.result_on::timestamptz, t.updated_at) < ${to})::int AS lost
        FROM tender.tender t WHERE true ${scope} GROUP BY t.vertical ORDER BY t.vertical`,
      db<TenderDashboard['charts']['upcoming']>`
        WITH t AS (SELECT * FROM tender.tender t WHERE t.status IN ${db(OPEN)} ${scope}),
        d AS (
          SELECT id AS tender_id, submission_due_at AS at, 'submission' AS kind, 'Submission due' AS label
            FROM t WHERE status <> 'submitted'
          UNION ALL SELECT id, prebid_at, 'prebid', 'Pre-bid meeting' FROM t WHERE status <> 'submitted'
          UNION ALL SELECT id, queries_due_at, 'queries', 'Last day for queries' FROM t WHERE status <> 'submitted'
          UNION ALL SELECT id, opening_at, 'opening', 'Bid opening' FROM t
          UNION ALL SELECT s.tender_id, (s.valid_until::text || 'T03:30:00Z')::timestamptz, 'security',
              CASE s.form WHEN 'bank_guarantee' THEN 'Bank guarantee expires' WHEN 'fdr' THEN 'FDR matures'
                ELSE 'Bond expires' END
            FROM tender.security_instrument s JOIN tender.tender t ON t.id = s.tender_id
            WHERE s.status IN ('issued', 'submitted') AND s.form IN ('bank_guarantee', 'fdr', 'insurance_bond')
              ${scope}
        )
        SELECT d.at, d.kind, d.label, json_build_object('id', x.id, 'number', x.number, 'title', x.title) AS tender
        FROM d JOIN tender.tender x ON x.id = d.tender_id
        WHERE d.at IS NOT NULL AND d.at <= ${new Date(now.getTime() + 30 * 86_400_000)}
          AND (d.at >= ${now} OR d.kind = 'security')
        ORDER BY d.at LIMIT 40`,
      db<TenderDashboard['charts']['rfqs']>`
        SELECT r.id, r.number, r.title, to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn",
          (SELECT count(*)::int FROM tender.rfq_vendor v WHERE v.rfq_id = r.id) AS vendors,
          (SELECT count(*)::int FROM tender.rfq_quote q WHERE q.rfq_id = r.id) AS quoted,
          json_build_object('id', t.id, 'number', t.number) AS tender
        FROM tender.rfq r JOIN tender.tender t ON t.id = r.tender_id
        WHERE r.status = 'sent' ${scope} ORDER BY r.due_on NULLS LAST, r.number LIMIT 20`,
    ]);
    const byStatus = new Map(stages.map((s) => [s.status, s]));
    const charts = {
      stages: TENDER_STATUSES.map(
        (status) => byStatus.get(status) ?? { status, count: 0, estimatedValue: '0.00' },
      ),
      quarters: quarters(results),
      verticals: [...verticals],
      upcoming: upcoming.map((u) => ({ ...u, at: new Date(u.at).toISOString() })),
      rfqs: [...rfqs],
    };
    return {
      dashboard: 'tender',
      ...base,
      tookMs: Math.round(performance.now() - started),
      charts,
    };
  }

  async estimation(
    claims: TenantClaims,
    input: InputFilter,
    now = new Date(),
  ): Promise<EstimationDashboard> {
    const started = performance.now();
    const { db, scope, base } = await this.common(claims, 'estimation', input, now);
    const progress = db`
      SELECT b.* FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id
      WHERE b.status = 'draft' AND b.archived_at IS NULL AND t.status IN ${db(OPEN)} ${scope}`;
    const [estimators, topBoqs, revisions, groups, rateChanges] = await Promise.all([
      db<EstimationDashboard['charts']['estimators']>`
        SELECT u.id, coalesce(u.display_name, 'No owner') AS name, count(b.id)::int AS boqs,
          round(coalesce(sum(b.total), 0), 2)::text AS value,
          coalesce(sum((SELECT count(*) FROM est.boq_node n WHERE n.boq_id = b.id AND n.node_type = 'item'
            AND n.rate IS NULL AND coalesce(n.qty, 0) <> 0)), 0)::int AS unpriced
        FROM (${progress}) b JOIN tender.tender t ON t.id = b.tender_id
        LEFT JOIN platform."user" u ON u.id = t.owner_id
        GROUP BY u.id, u.display_name ORDER BY count(b.id) DESC, 2`,
      db<EstimationDashboard['charts']['topBoqs']>`
        SELECT b.id, b.name, b.total::text AS total, b.version_no AS "versionNo",
          json_build_object('id', t.id, 'number', t.number, 'title', t.title) AS tender
        FROM (${progress}) b JOIN tender.tender t ON t.id = b.tender_id
        ORDER BY b.total DESC, b.name LIMIT 10`,
      db<
        {
          id: string;
          name: string;
          tenderNumber: string;
          versions: number;
          first: string;
          latest: string;
          current: string;
        }[]
      >`
        SELECT b.id, b.name, t.number AS "tenderNumber", count(v.*)::int AS versions,
          (array_agg(v.total ORDER BY v.version_no))[1]::text AS first,
          (array_agg(v.total ORDER BY v.version_no DESC))[1]::text AS latest, b.total::text AS current
        FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id JOIN est.boq_version v ON v.boq_id = b.id
        WHERE b.archived_at IS NULL ${scope}
        GROUP BY b.id, b.name, t.number, b.total ORDER BY max(v.frozen_at) DESC LIMIT 10`,
      this.costMix(db, progress),
      db<EstimationDashboard['charts']['rateChanges']>`
        SELECT r.code, r.name, r.unit, rr.rate::text AS rate, to_char(rr.effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
          (SELECT p.rate::text FROM est.resource_rate p WHERE p.resource_id = rr.resource_id
            AND p.effective_from < rr.effective_from ORDER BY p.effective_from DESC LIMIT 1) AS previous
        FROM est.resource_rate rr JOIN est.resource r ON r.id = rr.resource_id
        WHERE rr.created_at >= ${new Date(now.getTime() - 30 * 86_400_000)}
        ORDER BY rr.created_at DESC LIMIT 15`,
    ]);

    // One costing engine per rate date: the same analysis costs differently on different dates.
    const costs = new Map<string, Costing | null>();
    const byDate = new Map<string, Set<string>>();
    for (const g of groups) {
      if (!g.analysisId) continue;
      if (!byDate.has(g.rateDate)) byDate.set(g.rateDate, new Set());
      byDate.get(g.rateDate)!.add(g.analysisId);
    }
    for (const [date, idSet] of byDate) {
      const ids = [...idSet];
      const engine = await this.rates.engineFor(db, ids, date);
      for (const id of ids) {
        try {
          costs.set(`${date}|${id}`, engine.hasAnalysis(id) ? engine.cost(id) : null);
        } catch (err) {
          if (!(err instanceof CycleError || err instanceof TooDeepError)) throw err;
          costs.set(`${date}|${id}`, null);
        }
      }
    }
    const pct = (a: string, b: string) =>
      Number(b) > 0 ? (((Number(a) - Number(b)) / Number(b)) * 100).toFixed(2) : null;
    const mix = breakdown(
      groups.map((g) => ({
        analysisId: g.analysisId ? `${g.rateDate}|${g.analysisId}` : null,
        amount: g.amount,
      })),
      (key) => costs.get(key) ?? null,
    );
    const charts = {
      estimators: [...estimators],
      topBoqs: [...topBoqs],
      revisions: revisions.map((r) => ({ ...r, changePct: pct(r.current, r.first) })),
      breakdown: mix,
      rateChanges: rateChanges.map((r) => ({
        ...r,
        changePct: r.previous ? pct(r.rate, r.previous) : null,
      })),
    };
    return {
      dashboard: 'estimation',
      ...base,
      // Measured last: everything above is part of what the user waits for.
      tookMs: Math.round(performance.now() - started),
      charts,
    };
  }

  /**
   * Item amounts by (rate date, analysis) across the BOQs in progress, from est.boq_cost_mix. BOQs changed since
   * their row was made are recomputed from their lines; the stamps and the lines are read in one snapshot, so a
   * stored mix always belongs to its stamp.
   */
  private async costMix(db: Sql, progress: PendingQuery<Row[]>) {
    type Mix = { a: string | null; v: string }[];
    type Group = { rateDate: string; analysisId: string | null; amount: string };
    const { stale, cachedGroups, fresh } = await db.begin(
      'isolation level repeatable read read only',
      async (tx) => {
        const boqs = await tx<{ id: string; rateDate: string; stamp: string; current: boolean }[]>`
          SELECT b.id, b.rate_date::text AS "rateDate", s.stamp, m.stamp IS NOT DISTINCT FROM s.stamp AS current
          FROM (${progress}) b
          CROSS JOIN LATERAL (SELECT b.updated_at::text || '|' || b.total::text || '|' || b.rate_date::text || '|'
            || b.version_no AS stamp) s
          LEFT JOIN est.boq_cost_mix m ON m.boq_id = b.id`;
        const stale = boqs.filter((b) => !b.current);
        const current = boqs.filter((b) => b.current).map((b) => b.id);
        // The current rows are summed where they are; only BOQs changed since are read line by line.
        const cachedGroups = current.length
          ? await tx<Group[]>`
              SELECT b.rate_date::text AS "rateDate", x.a AS "analysisId", sum(x.v)::text AS amount
              FROM est.boq_cost_mix m JOIN est.boq b ON b.id = m.boq_id
              CROSS JOIN LATERAL jsonb_to_recordset(m.mix) AS x(a uuid, v numeric)
              WHERE m.boq_id = ANY(${current}::uuid[]) GROUP BY b.rate_date, x.a`
          : [];
        const fresh = stale.length
          ? await tx<{ boqId: string; mix: Mix }[]>`
              SELECT g.boq_id AS "boqId", json_agg(json_build_object('a', g.a, 'v', g.v)) AS mix FROM (
                SELECT n.boq_id, n.rate_analysis_id AS a, coalesce(sum(n.amount), 0)::text AS v FROM est.boq_node n
                WHERE n.boq_id = ANY(${stale.map((b) => b.id)}::uuid[]) AND n.node_type = 'item'
                GROUP BY n.boq_id, n.rate_analysis_id
              ) g GROUP BY g.boq_id`
          : [];
        return { stale, cachedGroups, fresh };
      },
    );
    const computed = new Map(fresh.map((f) => [f.boqId, f.mix]));
    if (stale.length)
      await db`
        INSERT INTO est.boq_cost_mix (boq_id, stamp, mix)
        SELECT x.id, x.stamp, x.mix FROM jsonb_to_recordset(${db.json(
          stale.map((b) => ({ id: b.id, stamp: b.stamp, mix: computed.get(b.id) ?? [] })),
        )}) AS x(id uuid, stamp text, mix jsonb)
        ON CONFLICT (boq_id) DO UPDATE SET stamp = EXCLUDED.stamp, mix = EXCLUDED.mix, computed_at = now()
        WHERE est.boq_cost_mix.stamp IS DISTINCT FROM EXCLUDED.stamp`;
    // One group per (rate date, analysis) across all the BOQs: the split is the same for each.
    const sums = new Map<string, { rateDate: string; analysisId: string | null; amount: bigint }>();
    const add = (rateDate: string, analysisId: string | null, v: string) => {
      const key = `${rateDate}|${analysisId ?? ''}`;
      const g = sums.get(key) ?? { rateDate, analysisId, amount: 0n };
      g.amount += dec(v);
      sums.set(key, g);
    };
    for (const g of cachedGroups) add(g.rateDate, g.analysisId, g.amount);
    for (const b of stale) for (const m of computed.get(b.id) ?? []) add(b.rateDate, m.a, m.v);
    return [...sums.values()].map((g) => ({ ...g, amount: fmt(g.amount, 2) }));
  }

  /** The dashboard as of now, for the Excel export. */
  get(claims: TenantClaims, d: DashboardName, f: InputFilter) {
    return d === 'tender' ? this.tender(claims, f) : this.estimation(claims, f);
  }
}

/** Submissions and results of the year by quarter of the Indian financial year (Q1 = April to June, IST). */
export function quarters(
  rows: { kind: 'submitted' | 'won' | 'lost'; at: Date; value: string | null }[],
) {
  const qs = [1, 2, 3, 4].map((q) => ({
    quarter: `Q${q}`,
    submitted: 0,
    won: 0,
    lost: 0,
    wonValue: 0,
  }));
  for (const r of rows) {
    const ist = new Date(new Date(r.at).getTime() + 330 * 60_000);
    const q = qs[Math.floor(((ist.getUTCMonth() + 9) % 12) / 3)]!;
    q[r.kind]++;
    if (r.kind === 'won') q.wonValue += Number(r.value ?? 0);
  }
  return qs.map((q) => ({ ...q, wonValue: q.wonValue.toFixed(2) }));
}

export type AnyDashboard = TenderDashboard | EstimationDashboard;
