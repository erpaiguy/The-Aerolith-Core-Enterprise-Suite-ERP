import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import postgres, { type Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

export const CONTROL_DB = Symbol('CONTROL_DB');

export function connectControlDb(url: string): Sql {
  // prepare: false keeps the driver compatible with Supabase's transaction-mode pooler (docs/05-database.md §9).
  return postgres(url, { max: 10, prepare: false, onnotice: () => {} });
}

@Global()
@Module({
  providers: [
    {
      provide: CONTROL_DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => connectControlDb(config.controlDatabaseUrl),
    },
  ],
  exports: [CONTROL_DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(CONTROL_DB) private readonly sql: Sql) {}

  async onApplicationShutdown(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
