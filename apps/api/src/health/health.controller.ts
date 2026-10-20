// Health and readiness (docs/wave9-plan.md step 9b.5). /api/health says the process is up (for a restart policy);
// /api/health/ready says it can do its work: the control database answers, and the most connections this server could
// open fit within what Postgres allows. A load balancer or compose health check sends traffic only when ready.
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  type OnApplicationBootstrap,
  Res,
} from '@nestjs/common';
import { buildHealthReport, type HealthReport } from '@aerolith/shared';
import type { FastifyReply } from 'fastify';
import type { Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CONTROL_DB } from '../db/db.module.js';
import { API_VERSION } from '../version.js';

/** The control pool's size (src/db/db.module.ts) and a margin for migrations and maintenance. */
const CONTROL_POOL = 10;
const MARGIN = 5;

export interface ConnectionBudget {
  needed: number;
  allowed: number;
  ok: boolean;
}

export const connectionBudget = (
  config: Pick<AppConfig, 'maxTenantPools' | 'tenantPoolMax'>,
  allowed: number,
): ConnectionBudget => {
  const needed = config.maxTenantPools * config.tenantPoolMax + CONTROL_POOL + MARGIN;
  return { needed, allowed, ok: needed <= allowed };
};

@Controller('health')
export class HealthController implements OnApplicationBootstrap {
  private readonly log = new Logger('Health');

  constructor(
    @Inject(CONTROL_DB) private readonly control: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Says at start-up, once, if this server could ask Postgres for more connections than it allows. */
  async onApplicationBootstrap() {
    const b = await this.budget().catch(() => null);
    if (b && !b.ok)
      this.log.warn(
        `Up to ${b.needed} database connections could be opened but Postgres allows ${b.allowed}: lower MAX_TENANT_POOLS or TENANT_POOL_MAX, or raise max_connections.`,
      );
  }

  private async budget() {
    const [r] = await this.control<{ max_connections: string }[]>`SHOW max_connections`;
    return connectionBudget(this.config, Number(r!.max_connections));
  }

  @Get()
  check(): HealthReport {
    return buildHealthReport('api', API_VERSION);
  }

  @Get('ready')
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    try {
      const timeout = new Promise<never>((_, fail) =>
        setTimeout(() => fail(new Error('timeout')), 3_000).unref(),
      );
      const b = await Promise.race([this.budget(), timeout]);
      return { status: 'ready', version: API_VERSION, database: 'ok', connections: b };
    } catch {
      void reply.status(503);
      return { status: 'not_ready', version: API_VERSION, database: 'unreachable' };
    }
  }
}
