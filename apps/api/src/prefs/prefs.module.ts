import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { PrefsController } from './prefs.controller.js';

@Module({ imports: [ProvisioningModule, AuthModule], controllers: [PrefsController] })
export class PrefsModule {}
