import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { InboxService } from './inbox.service.js';

const reminderSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(2000).default(''),
  dueAt: z.coerce.date(),
  link: z.string().max(500).nullable().default(null),
});

@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get('inbox')
  get(@Auth() claims: TenantClaims) {
    return this.inbox.inbox(claims);
  }

  @Get('my-work')
  myWork(@Auth() claims: TenantClaims) {
    return this.inbox.myWork(claims);
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  readAll(@Auth() claims: TenantClaims) {
    return this.inbox.markAllRead(claims);
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  read(@Auth() claims: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inbox.markRead(claims, id);
  }

  @Post('reminders')
  addReminder(
    @Auth() claims: TenantClaims,
    @Body(new ZodPipe(reminderSchema)) body: z.infer<typeof reminderSchema>,
  ) {
    return this.inbox.addReminder(claims, body);
  }

  @Post('reminders/:id/delete')
  @HttpCode(200)
  deleteReminder(@Auth() claims: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inbox.deleteReminder(claims, id);
  }
}
