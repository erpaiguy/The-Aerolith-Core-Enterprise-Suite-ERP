import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { LicensingModule } from './licensing/licensing.module.js';
import { ProvisioningModule } from './provisioning/provisioning.module.js';

@Module({
  imports: [ConfigModule, DbModule, ProvisioningModule, LicensingModule],
  controllers: [HealthController],
})
export class AppModule {}
