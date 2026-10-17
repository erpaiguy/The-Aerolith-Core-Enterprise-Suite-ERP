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
import { CONSTRAINT_KINDS, MakeReadyService, MISS_REASONS } from './make-ready.service.js';

const date = z.iso.date();
const activityId = z.string().regex(/^\d{1,18}$/, 'An activity');

/** Look-ahead with constraints (docs/wave8-plan.md step 8d.2). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class MakeReadyController {
  constructor(private readonly ready: MakeReadyService) {}

  @Get('programmes/:id/constraints')
  constraints(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.ready.constraints(c, id);
  }

  @Post('programmes/:id/constraints')
  @HttpCode(200)
  @RequiresFeatures()
  addConstraint(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          activityId,
          kind: z.enum(CONSTRAINT_KINDS),
          description: z.string().trim().min(2).max(500),
          ownerId: z.uuid().nullable().default(null),
          dueOn: date,
        }),
      ),
    )
    b: {
      activityId: string;
      kind: string;
      description: string;
      ownerId: string | null;
      dueOn: string;
    },
  ) {
    return this.ready.addConstraint(c, id, b);
  }

  @Post('constraints/:id/clear')
  @HttpCode(200)
  @RequiresFeatures()
  clear(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: date }))) b: { on: string },
  ) {
    return this.ready.clear(c, id, b.on);
  }

  @Get('programmes/:id/readiness')
  readiness(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ weeks: z.coerce.number().int().min(1).max(12).default(6) })))
    q: { weeks: number },
  ) {
    return this.ready.readiness(c, id, q.weeks);
  }

  @Get('programmes/:id/weekly-plan')
  week(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ week: date }))) q: { week: string },
  ) {
    return this.ready.week(c, id, q.week);
  }

  @Post('programmes/:id/weekly-plan')
  @HttpCode(200)
  @RequiresFeatures()
  commit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          weekStart: date,
          items: z
            .array(
              z.object({
                activityId: activityId.nullable().default(null),
                what: z.string().trim().min(2).max(300),
              }),
            )
            .min(1)
            .max(200),
        }),
      ),
    )
    b: { weekStart: string; items: { activityId: string | null; what: string }[] },
  ) {
    return this.ready.commit(c, id, b);
  }

  @Post('programmes/:id/weekly-plan/close')
  @HttpCode(200)
  @RequiresFeatures()
  close(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          weekStart: date,
          results: z
            .array(
              z.object({
                id: z.uuid(),
                done: z.boolean(),
                missReason: z.enum(MISS_REASONS).nullable().default(null),
                note: z.string().trim().max(500).default(''),
              }),
            )
            .max(200),
        }),
      ),
    )
    b: {
      weekStart: string;
      results: { id: string; done: boolean; missReason: string | null; note: string }[];
    },
  ) {
    return this.ready.close(c, id, b);
  }

  @Get('programmes/:id/ppc')
  ppc(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.ready.ppcTrend(c, id);
  }
}
