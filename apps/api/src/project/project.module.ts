import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ProjectAccess } from './project-access.interceptor.js';
import { CostCodeService } from './cost-code.service.js';
import { DailyReportController } from './daily-report.controller.js';
import { DailyReportService } from './daily-report.service.js';
import { DrawingController } from './drawing.controller.js';
import { DrawingService } from './drawing.service.js';
import { ProjectBoqController } from './project-boq.controller.js';
import { ProjectBoqService } from './project-boq.service.js';
import { ProjectController } from './project.controller.js';
import { ProgressController } from './progress.controller.js';
import { ProgressService } from './progress.service.js';
import { MbProposalService } from './mb-proposal.service.js';
import { ProjectService } from './project.service.js';
import { WbsController } from './wbs.controller.js';
import { WbsService } from './wbs.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule, DocumentsModule],
  controllers: [
    ProjectController,
    ProjectBoqController,
    WbsController,
    ProgressController,
    DailyReportController,
    DrawingController,
  ],
  providers: [
    ProjectService,
    ProjectBoqService,
    WbsService,
    CostCodeService,
    ProgressService,
    MbProposalService,
    DailyReportService,
    DrawingService,
    // Every BOQ and plan route, whichever module serves it, checks a project's team first.
    { provide: APP_INTERCEPTOR, useClass: ProjectAccess },
  ],
  exports: [ProjectService, ProjectBoqService, ProgressService],
})
export class ProjectModule {}
