// Buying with history (docs/wave8-plan.md step 8e.4): what a material was last bought at, from whom and when, and its
// price over the past year, shown wherever it is bought (requisitions, comparatives, orders); and how old the stock in
// the stores is, with what has not moved.
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const SLOW_DAYS = 90;

/** Days old into the report's buckets. */
export function bucketOf(days: number): '0-30' | '31-90' | '91-180' | 'over 180' {
  return days <= 30 ? '0-30' : days <= 90 ? '31-90' : days <= 180 ? '91-180' : 'over 180';
}

@Injectable()
export class BuyingHistoryService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  private async buyer(claims: TenantClaims) {
    for (const p of ['purchase.edit', 'rfq.edit', 'stores.manage'] as const)
      if (await this.permissions.can(claims, p)) return;
    throw new ForbiddenException({
      code: 'forbidden',
      message: 'Purchase rates are for those who buy.',
    });
  }

  /**
   * For each material: its last purchases (from orders in force, newest first), the last rate and the one before,
   * the change between them, and the average rate month by month over the past twelve.
   */
  async history(claims: TenantClaims, resourceIds: string[]) {
    await this.buyer(claims);
    if (!resourceIds.length) return [];
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      {
        resourceId: string;
        on: string;
        rate: string;
        qty: string;
        unit: string;
        party: string;
        order: string;
        project: string;
      }[]
    >`
      SELECT l.resource_id AS "resourceId", to_char(v.approved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS on,
        l.rate::text AS rate, l.qty::text AS qty, l.unit, pa.name AS party, o.number AS order, p.number AS project
      FROM proc.po_line l
      JOIN proc.po_revision v ON v.id = l.revision_id AND v.status = 'approved'
      JOIN proc.purchase_order o ON o.id = v.po_id AND o.status <> 'cancelled'
      JOIN platform.party pa ON pa.id = o.party_id
      JOIN proj.project p ON p.id = o.project_id
      WHERE l.resource_id IN ${db(resourceIds)}
      ORDER BY v.approved_at DESC, o.number DESC`;
    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    return resourceIds.map((id) => {
      const mine = rows.filter((r) => r.resourceId === id);
      const [last, before] = mine;
      const months = new Map<string, { sum: number; qty: number }>();
      for (const r of mine.filter((x) => x.on >= yearAgo)) {
        const m = months.get(r.on.slice(0, 7)) ?? { sum: 0, qty: 0 };
        m.sum += Number(r.rate) * Number(r.qty);
        m.qty += Number(r.qty);
        months.set(r.on.slice(0, 7), m);
      }
      return {
        resourceId: id,
        last: last ?? null,
        previousRate: before?.rate ?? null,
        changePct:
          last && before && Number(before.rate) > 0
            ? Math.round(((Number(last.rate) - Number(before.rate)) / Number(before.rate)) * 1000) /
              10
            : null,
        recent: mine.slice(0, 5),
        trend: [...months.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, m]) => ({ month, rate: (m.sum / m.qty).toFixed(2) })),
      };
    });
  }

  /**
   * The stock in the stores a person works, by how long it has lain, and what has not been issued for 90 days. What is
   * on hand is taken to be the latest that came in (first in, first out, whatever the valuation method), each lot at
   * the balance's average value.
   */
  async ageing(claims: TenantClaims, q: { storeId?: string | undefined }) {
    const db = await this.tenants.forTenant(claims.ten);
    const all = claims.role === 'admin' || (await this.permissions.can(claims, 'projects.all'));
    const today = indiaToday();
    const seen = all
      ? db`true`
      : db`(p.is_central OR EXISTS (SELECT 1 FROM proj.member x WHERE x.project_id = p.id
          AND x.user_id = ${claims.sub}))`;
    const balances = await db<
      {
        storeId: string;
        store: string;
        project: string;
        resourceId: string;
        code: string;
        name: string;
        unit: string;
        qty: string;
        value: string;
        lastIssue: string | null;
      }[]
    >`
      SELECT s.id AS "storeId", s.name AS store, p.number AS project, r.id AS "resourceId", r.code, r.name, r.unit,
        b.qty::text AS qty, b.value::text AS value,
        (SELECT to_char(max(i.moved_on), 'YYYY-MM-DD') FROM proc.stock_move i
          WHERE i.store_id = b.store_id AND i.resource_id = b.resource_id AND i.kind = 'issue') AS "lastIssue"
      FROM proc.stock_balance b
      JOIN proc.store s ON s.id = b.store_id
      JOIN proj.project p ON p.id = s.project_id
      JOIN est.resource r ON r.id = b.resource_id
      WHERE b.qty > 0 ${q.storeId ? db`AND s.id = ${q.storeId}` : db``} AND ${seen}
      ORDER BY p.number, s.name, r.code`;
    const ins = balances.length
      ? await db<{ storeId: string; resourceId: string; days: number; qty: string }[]>`
          SELECT m.store_id AS "storeId", m.resource_id AS "resourceId", (${today}::date - m.moved_on) AS days,
            m.qty::text AS qty
          FROM proc.stock_move m
          WHERE m.qty > 0 AND m.store_id IN ${db([...new Set(balances.map((b) => b.storeId))])}
          ORDER BY m.moved_on DESC, m.id DESC`
      : [];
    const lots: ((typeof balances)[number] & { days: number })[] = [];
    for (const b of balances) {
      let left = Number(b.qty);
      const unit = Number(b.value) / Number(b.qty);
      for (const m of ins) {
        if (left <= 0) break;
        if (m.storeId !== b.storeId || m.resourceId !== b.resourceId) continue;
        const take = Math.min(left, Number(m.qty));
        left -= take;
        lots.push({ ...b, days: m.days, qty: String(take), value: String(take * unit) });
      }
      // Stock with no move behind it (an opening balance): as old as it can be shown.
      if (left > 1e-9)
        lots.push({ ...b, days: 9999, qty: String(left), value: String(left * unit) });
    }
    const key = (l: (typeof lots)[number]) => `${l.storeId}|${l.resourceId}`;
    const items = new Map<
      string,
      {
        storeId: string;
        store: string;
        project: string;
        code: string;
        name: string;
        unit: string;
        qty: number;
        value: number;
        oldestDays: number;
        lastIssue: string | null;
        buckets: Record<string, number>;
      }
    >();
    for (const l of lots) {
      const it = items.get(key(l)) ?? {
        storeId: l.storeId,
        store: l.store,
        project: l.project,
        code: l.code,
        name: l.name,
        unit: l.unit,
        qty: 0,
        value: 0,
        oldestDays: 0,
        lastIssue: l.lastIssue,
        buckets: { '0-30': 0, '31-90': 0, '91-180': 0, 'over 180': 0 },
      };
      it.qty += Number(l.qty);
      it.value += Number(l.value);
      it.oldestDays = Math.max(it.oldestDays, l.days);
      it.buckets[bucketOf(l.days)]! += Number(l.value);
      items.set(key(l), it);
    }
    const rows = [...items.values()].map((it) => {
      const idle =
        it.lastIssue === null
          ? it.oldestDays
          : Math.round((Date.parse(today) - Date.parse(it.lastIssue)) / 86_400_000);
      return {
        ...it,
        qty: it.qty.toFixed(4),
        value: it.value.toFixed(2),
        buckets: Object.fromEntries(Object.entries(it.buckets).map(([k, v]) => [k, v.toFixed(2)])),
        slow: idle > SLOW_DAYS,
        idleDays: idle,
      };
    });
    const totals = { '0-30': 0, '31-90': 0, '91-180': 0, 'over 180': 0 } as Record<string, number>;
    for (const r of rows) for (const [k, v] of Object.entries(r.buckets)) totals[k]! += Number(v);
    return {
      asOn: today,
      slowAfterDays: SLOW_DAYS,
      rows,
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toFixed(2)])),
      slowValue: rows
        .filter((r) => r.slow)
        .reduce((s, r) => s + Number(r.value), 0)
        .toFixed(2),
    };
  }
}
