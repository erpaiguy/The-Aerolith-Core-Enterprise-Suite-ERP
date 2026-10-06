// Per-tenant connection pools for the app role (docs/03-architecture.md §4-5). Pools are opened lazily, kept in
// least-recently-used order, and closed when the cap is exceeded. One tenant's database being down affects only
// that tenant's requests.
import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import postgres, { type Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { open } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';

@Injectable()
export class TenantConnections implements OnApplicationShutdown {
  private readonly pools = new Map<string, Sql>();

  constructor(
    @Inject(CONTROL_DB) private readonly control: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Connection pool for a tenant whose database is ready. Never accepts a tenant id from client input directly. */
  async forTenant(tenantId: string): Promise<Sql> {
    const cached = this.pools.get(tenantId);
    if (cached) {
      this.pools.delete(tenantId);
      this.pools.set(tenantId, cached); // mark most recently used
      return cached;
    }
    const [row] = await this.control<{ status: string; app_url_secret: string | null }[]>`
      SELECT status, app_url_secret FROM core.tenant_db WHERE tenant_id = ${tenantId}`;
    if (!row) throw new NotFoundException({ code: 'tenant_db_not_found' });
    if (row.status !== 'ready' || !row.app_url_secret) {
      throw new ServiceUnavailableException({ code: 'tenant_db_not_ready', status: row.status });
    }
    const pool = postgres(open(row.app_url_secret, this.config.controlPlaneEncKey), {
      max: 5,
      idle_timeout: 60,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {},
    });
    this.pools.set(tenantId, pool);
    while (this.pools.size > this.config.maxTenantPools) {
      const [oldestId, oldest] = this.pools.entries().next().value as [string, Sql];
      this.pools.delete(oldestId);
      void oldest.end({ timeout: 5 });
    }
    return pool;
  }

  get openPools(): number {
    return this.pools.size;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end({ timeout: 5 })));
    this.pools.clear();
  }
}
