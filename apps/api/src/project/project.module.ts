import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ProjectAccess } from './project-access.interceptor.js';
import { CostCodeService } from './cost-code.service.js';
import { ProjectBoqController } from './project-boq.controller.js';
import { ProjectBoqService } from './project-boq.service.js';
import { ProjectController } from './project.controller.js';
import { ProgressController } from './progress.controller.js';
import { ProgressService } from './progress.service.js';
import { ProjectService } from './project.service.js';
import { WbsController } from './wbs.controller.js';
import { WbsService } from './wbs.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [ProjectController, ProjectBoqController, WbsController, ProgressController],
  providers: [
    ProjectService,
    ProjectBoqService,
    WbsService,
    CostCodeService,
    ProgressService,
    // Every BOQ and plan route, whichever module serves it, checks a project's team first.
    { provide: APP_INTERCEPTOR, useClass: ProjectAccess },
  ],
  exports: [ProjectService, ProjectBoqService, ProgressService],
})
export class ProjectModule {}
