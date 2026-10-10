import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ProjectBoqAccess } from './boq-access.interceptor.js';
import { CostCodeService } from './cost-code.service.js';
import { ProjectBoqController } from './project-boq.controller.js';
import { ProjectBoqService } from './project-boq.service.js';
import { ProjectController } from './project.controller.js';
import { ProjectService } from './project.service.js';
import { WbsController } from './wbs.controller.js';
import { WbsService } from './wbs.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [ProjectController, ProjectBoqController, WbsController],
  providers: [
    ProjectService,
    ProjectBoqService,
    WbsService,
    CostCodeService,
    // Every BOQ route, whichever module serves it, checks a project BOQ's team first.
    { provide: APP_INTERCEPTOR, useClass: ProjectBoqAccess },
  ],
  exports: [ProjectService],
})
export class ProjectModule {}
