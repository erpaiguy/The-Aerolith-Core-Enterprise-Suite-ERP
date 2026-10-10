import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { DocumentLifecycle } from './lifecycle.service.js';
import { DocumentText } from './text.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentLifecycle, DocumentText],
  exports: [DocumentsService, DocumentLifecycle, DocumentText],
})
export class DocumentsModule {}
