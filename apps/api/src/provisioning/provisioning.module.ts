import { Module } from '@nestjs/common';
import { OnboardingController } from '../onboarding/onboarding.controller.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { MigrationOrchestrator } from './orchestrator.js';
import { ProvisioningService } from './provisioning.service.js';
import { TenantConnections } from './tenant-connections.js';

@Module({
  controllers: [OnboardingController],
  providers: [ProvisioningService, MigrationOrchestrator, TenantConnections, OnboardingService],
  exports: [ProvisioningService, MigrationOrchestrator, TenantConnections, OnboardingService],
})
export class ProvisioningModule {}
