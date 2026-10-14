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
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { type MeetingInput, MeetingService } from './meeting.service.js';

const text = (max: number) => z.string().trim().max(max).default('');

/** A project's meetings and the actions agreed (docs/wave7-plan.md step 7d.1). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class MeetingController {
  constructor(private readonly meetings: MeetingService) {}

  @Get('projects/:id/meetings')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.meetings.list(c, id);
  }

  @Post('projects/:id/meetings')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          title: z.string().trim().min(3).max(300),
          heldOn: z.iso.date(),
          place: text(200),
          attendees: text(4000),
          minutes: text(20000),
          decisions: text(10000),
          actions: z
            .array(
              z.object({
                description: z.string().trim().min(2).max(1000),
                ownerId: z.uuid(),
                dueOn: z.iso.date(),
              }),
            )
            .max(200)
            .default([]),
        }),
      ),
    )
    b: MeetingInput,
  ) {
    return this.meetings.create(c, id, b);
  }

  @Get('meetings/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.meetings.get(c, id);
  }

  @Post('meeting-actions/:id/done')
  @HttpCode(200)
  @RequiresFeatures()
  done(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ note: text(1000) }))) b: { note: string },
  ) {
    return this.meetings.done(c, id, b.note);
  }
}
