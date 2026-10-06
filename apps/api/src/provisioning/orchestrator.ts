// Migration orchestrator (docs/03-architecture.md §5, docs/05-database.md §10): applies pending tenant migrations
// to every ready tenant database with bounded concurrency, records each result, and pauses the rollout once the
// number of failures reaches the threshold, leaving the remaining tenants untouched on the previous version.
import { Inject, Injectable } from '@nestjs/common';
import postgres, { type Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { open } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';
import { migrate, migrationFiles, TENANT_MIGRATIONS } from '../db/migrate.js';
import { OWNER_GROUP } from './bootstrap.js';

export type TenantResult = 'applied' | 'up_to_date' | 'failed' | 'unreachable' | 'not_attempted';

export interface RolloutSummary {
  runId: string;
  targetVersion: string;
  status: 'completed' | 'paused';
  counts: Record<TenantResult, number>;
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  'CONNECT_TIMEOUT',
]);

export function classifyError(err: unknown): 'unreachable' | 'failed' {
  const code = (err as { code?: string } | null)?.code;
  return code !== undefined && UNREACHABLE_CODES.has(code) ? 'unreachable' : 'failed';
}

/**
 * Runs `work` over `items` with at most `concurrency` in flight. Stops starting new items once `shouldStop()` is
 * true; items never started are reported via `onSkipped`.
 */
export async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
  shouldStop: () => boolean,
  onSkipped: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        if (shouldStop()) await onSkipped(item);
        else await work(item);
      }
    },
  );
  await Promise.all(workers);
}

@Injectable()
export class MigrationOrchestrator {
  constructor(
    @Inject(CONTROL_DB) private readonly sql: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async rollout(
    opts: { concurrency?: number; failureThreshold?: number; dir?: string } = {},
  ): Promise<RolloutSummary> {
    const dir = opts.dir ?? TENANT_MIGRATIONS;
    const concurrency = opts.concurrency ?? 4;
    const failureThreshold = opts.failureThreshold ?? 3;
    const targetVersion = migrationFiles(dir).at(-1) ?? 'none';
    const [run] = await this.sql<{ id: string }[]>`
      INSERT INTO core.migration_run (target_version, concurrency, failure_threshold)
      VALUES (${targetVersion}, ${concurrency}, ${failureThreshold}) RETURNING id`;
    const runId = run!.id;

    const tenants = await this.sql<{ tenant_id: string; migrator_url_secret: string }[]>`
      SELECT tenant_id, migrator_url_secret FROM core.tenant_db
      WHERE status = 'ready' AND migrator_url_secret IS NOT NULL ORDER BY created_at`;

    const counts: Record<TenantResult, number> = {
      applied: 0,
      up_to_date: 0,
      failed: 0,
      unreachable: 0,
      not_attempted: 0,
    };
    const record = async (
      tenantId: string,
      result: TenantResult,
      applied: string[] = [],
      error: string | null = null,
    ) => {
      counts[result]++;
      await this
        .sql`INSERT INTO core.migration_run_tenant (run_id, tenant_id, result, applied, error)
        VALUES (${runId}, ${tenantId}, ${result}, ${applied}, ${error})`;
    };

    await runBounded(
      tenants,
      concurrency,
      async (t) => {
        const db = postgres(open(t.migrator_url_secret, this.config.controlPlaneEncKey), {
          max: 1,
          onnotice: () => {},
          connect_timeout: 10,
          prepare: false,
        });
        try {
          const { applied } = await migrate(db, dir, { asRole: OWNER_GROUP });
          await this
            .sql`UPDATE core.tenant_db SET schema_version = ${targetVersion}, updated_at = now()
            WHERE tenant_id = ${t.tenant_id}`;
          await record(t.tenant_id, applied.length > 0 ? 'applied' : 'up_to_date', applied);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await record(t.tenant_id, classifyError(err), [], message.slice(0, 1000));
          await this
            .sql`UPDATE core.tenant_db SET last_error = ${message.slice(0, 1000)}, updated_at = now()
            WHERE tenant_id = ${t.tenant_id}`;
        } finally {
          await db.end({ timeout: 5 });
        }
      },
      () => counts.failed + counts.unreachable >= failureThreshold,
      (t) => record(t.tenant_id, 'not_attempted'),
    );

    const status =
      counts.failed + counts.unreachable >= failureThreshold && counts.not_attempted > 0
        ? 'paused'
        : 'completed';
    await this
      .sql`UPDATE core.migration_run SET status = ${status}, finished_at = now() WHERE id = ${runId}`;
    return { runId, targetVersion, status, counts };
  }
}
