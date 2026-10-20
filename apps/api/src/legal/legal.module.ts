import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { LegalController } from './legal.controller.js';

@Module({ imports: [ProvisioningModule, AuthModule], controllers: [LegalController] })
export class LegalModule {}
