import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Roles, TenantAuthGuard } from '../auth/guards.js';
import { UpdatesService } from './updates.service.js';

/** What the installation knows about new releases (docs/wave9-plan.md step 9b.4). */
@Controller('updates')
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  /** Open to anyone: the sign-in screen shows a new release before anyone signs in. */
  @Get()
  status() {
    return this.updates.status();
  }

  /** An admin's "Check now". */
  @Post('check')
  @HttpCode(200)
  @UseGuards(TenantAuthGuard)
  @Roles('admin')
  check() {
    return this.updates.check();
  }
}
