import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { RateLimitGuard } from './auth/rate-limit.js';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { LicensingModule } from './licensing/licensing.module.js';
import { ProvisioningModule } from './provisioning/provisioning.module.js';

@Module({
  imports: [ConfigModule, DbModule, ProvisioningModule, LicensingModule, AuthModule],
  controllers: [HealthController],
  // Runs before route guards; only acts on routes marked with @RateLimit.
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
