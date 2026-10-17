// Index series for price escalation (docs/wave8-plan.md step 8d.1): the WPI, CPI-IW, steel and cement series with a
// value for each month, and their average over a bill's period.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { fromDb } from './accounts-rules.js';
import { seriesOf, type EscalationTerms } from './client-bill-math.js';

type Db = Sql | TransactionSql;

/** The months a period covers: the first of each from its start's month to its end's. */
export const monthsOf = (from: string, to: string) => {
  const out: string[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return out;
};

@Injectable()
export class PriceIndexService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Only accounts may keep the index series.',
      });
  }

  async series(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT i.key, i.name, i.source,
        coalesce((SELECT json_agg(json_build_object('month', to_char(v.month, 'YYYY-MM'), 'value', v.value::text)
          ORDER BY v.month DESC) FROM (SELECT * FROM acc.price_index_value WHERE series_key = i.key
          ORDER BY month DESC LIMIT 24) v), '[]') AS values
      FROM acc.price_index i ORDER BY i.name`;
  }

  async addSeries(claims: TenantClaims, input: { key: string; name: string; source: string }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db`
      INSERT INTO acc.price_index (key, name, source, created_by)
      VALUES (${input.key}, ${input.name}, ${input.source}, ${claims.sub})`.catch(
      (err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'series_exists',
            message: 'That series is already kept.',
          });
        return fromDb(err);
      },
    );
    return this.series(claims);
  }

  /** Months' values for a series, each replacing what was there. */
  async setValues(claims: TenantClaims, key: string, values: { month: string; value: string }[]) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [s] = await tx`SELECT 1 FROM acc.price_index WHERE key = ${key}`;
      if (!s)
        throw new BadRequestException({ code: 'no_series', message: `No index series ${key}.` });
      for (const v of values)
        await tx`
          INSERT INTO acc.price_index_value (series_key, month, value, updated_by)
          VALUES (${key}, ${`${v.month}-01`}, ${v.value}, ${claims.sub})
          ON CONFLICT (series_key, month) DO UPDATE SET value = EXCLUDED.value, updated_at = now(),
            updated_by = EXCLUDED.updated_by`;
    });
    return this.series(claims);
  }

  /**
   * Each named series' average over the months of a period, to four places: the indices a bill takes where none is
   * typed. A series missing a month of the period gives nothing, so a bill is never escalated on part of its period.
   */
  static async averages(db: Db, terms: EscalationTerms | null, from: string, to: string) {
    const out: Record<string, string> = {};
    const months = monthsOf(from, to);
    for (const { key, seriesKey } of seriesOf(terms)) {
      const [r] = await db<{ n: number; avg: string | null }[]>`
        SELECT count(*)::int AS n, round(avg(value), 4)::text AS avg FROM acc.price_index_value
        WHERE series_key = ${seriesKey} AND month = ANY(${months}::date[])`;
      if (r && r.n === months.length && r.avg) out[key] = r.avg;
    }
    return out;
  }
}
