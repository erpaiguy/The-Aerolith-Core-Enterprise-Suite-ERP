import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SafetyService } from './safety.service.js';
import type { PermitKind } from './safety-rules.js';

const date = z.iso.date();
const moment = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().max(max);
const incident = z.object({
  siteId: z.uuid().nullable().default(null),
  occurredAt: moment,
  kind: z.enum(['near_miss', 'first_aid', 'medical', 'lost_time', 'fatal', 'property_damage']),
  location: text(300).default(''),
  description: z.string().trim().min(3).max(3000),
  employeeId: z.uuid().nullable().default(null),
  workerId: z.uuid().nullable().default(null),
  injuredName: text(200).default(''),
  daysLost: z.number().int().min(0).max(100000).default(0),
});
const permit = z.object({
  siteId: z.uuid().nullable().default(null),
  kind: z.enum(['height', 'hot_work', 'confined_space', 'excavation', 'electrical']),
  location: z.string().trim().min(2).max(300),
  work: z.string().trim().min(3).max(1000),
  validFrom: moment,
  validTo: moment,
});

/** Safety (docs/wave3-plan.md step 15). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Get('projects/:id/safety')
  register(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.safety.register(c, id);
  }

  @Get('projects/:id/safety/statistics')
  statistics(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ from: date, to: date }))) q: { from: string; to: string },
  ) {
    return this.safety.statistics(c, id, q.from, q.to);
  }

  @Post('projects/:id/incidents')
  @HttpCode(200)
  @RequiresFeatures()
  report(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(incident)) b: z.infer<typeof incident>,
  ) {
    return this.safety.report(c, id, b);
  }

  @Get('incidents/:id')
  incident(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.safety.incident(c, id);
  }

  @Post('incidents/:id/investigation')
  @HttpCode(200)
  @RequiresFeatures()
  investigate(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          rootCause: z.string().trim().min(3).max(3000),
          daysLost: z.number().int().min(0).max(100000).nullable().default(null),
          actions: z
            .array(
              z.object({
                action: z.string().trim().min(3).max(1000),
                owner: text(120).default(''),
                dueOn: date.nullable().default(null),
              }),
            )
            .max(50)
            .default([]),
        }),
      ),
    )
    b: {
      rootCause: string;
      daysLost: number | null;
      actions: { action: string; owner: string; dueOn: string | null }[];
    },
  ) {
    return this.safety.investigate(c, id, b);
  }

  @Post('incident-actions/:id/done')
  @HttpCode(200)
  @RequiresFeatures()
  actionDone(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ doneOn: date }))) b: { doneOn: string },
  ) {
    return this.safety.actionDone(c, id, b.doneOn);
  }

  @Post('incidents/:id/close')
  @HttpCode(200)
  @RequiresFeatures()
  close(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.safety.close(c, id);
  }

  @Post('projects/:id/permits')
  @HttpCode(200)
  @RequiresFeatures()
  requestPermit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(permit)) b: z.infer<typeof permit>,
  ) {
    return this.safety.requestPermit(c, id, b as typeof b & { kind: PermitKind });
  }

  @Get('permits/:id')
  permitOne(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.safety.permit(c, id);
  }

  @Post('permits/:id/issue')
  @HttpCode(200)
  @RequiresFeatures()
  issue(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ confirmed: z.array(z.boolean()).max(20) })))
    b: { confirmed: boolean[] },
  ) {
    return this.safety.issue(c, id, b.confirmed);
  }

  @Post('permits/:id/close')
  @HttpCode(200)
  @RequiresFeatures()
  closePermit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(z.object({ note: text(1000).default(''), cancel: z.boolean().default(false) })),
    )
    b: { note: string; cancel: boolean },
  ) {
    return this.safety.closePermit(c, id, b);
  }

  @Post('projects/:id/toolbox-talks')
  @HttpCode(200)
  @RequiresFeatures()
  talk(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          siteId: z.uuid().nullable().default(null),
          heldOn: date,
          topic: z.string().trim().min(3).max(200),
          speaker: text(120).default(''),
          employeeIds: z.array(z.uuid()).max(2000).default([]),
          workerIds: z.array(z.uuid()).max(2000).default([]),
          others: z.number().int().min(0).max(10000).default(0),
        }),
      ),
    )
    b: {
      siteId: string | null;
      heldOn: string;
      topic: string;
      speaker: string;
      employeeIds: string[];
      workerIds: string[];
      others: number;
    },
  ) {
    return this.safety.talk(c, id, b);
  }
}
