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
import { HandoverService } from './handover.service.js';

const date = z.iso.date();

/** Handover and defect liability (docs/wave8-plan.md step 8d.3). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class HandoverController {
  constructor(private readonly handover: HandoverService) {}

  @Get('projects/:id/handovers')
  handovers(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.handovers(c, id);
  }

  @Post('projects/:id/handovers')
  @HttpCode(200)
  @RequiresFeatures()
  add(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          area: z.string().trim().min(1).max(120),
          handedTo: z.string().trim().min(2).max(200),
          checklist: z
            .array(
              z.object({
                item: z.string().trim().min(2).max(200),
                ok: z.boolean().default(false),
                note: z.string().trim().max(300).default(''),
              }),
            )
            .min(1)
            .max(100),
        }),
      ),
    )
    b: { area: string; handedTo: string; checklist: { item: string; ok: boolean; note: string }[] },
  ) {
    return this.handover.addHandover(c, id, b);
  }

  @Post('handovers/:id/check')
  @HttpCode(200)
  @RequiresFeatures()
  check(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ index: z.number().int().min(0).max(99), ok: z.boolean() })))
    b: { index: number; ok: boolean },
  ) {
    return this.handover.check(c, id, b.index, b.ok);
  }

  @Post('handovers/:id/hand-over')
  @HttpCode(200)
  @RequiresFeatures()
  handOver(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: date }))) b: { on: string },
  ) {
    return this.handover.handOver(c, id, b.on);
  }

  @Get('handovers/:id/certificate')
  certificate(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.certificate(c, id);
  }

  @Get('projects/:id/dlp')
  dlp(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.dlp(c, id);
  }

  @Post('projects/:id/defects')
  @HttpCode(200)
  @RequiresFeatures()
  report(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          contractId: z.uuid().nullable().default(null),
          area: z.string().trim().min(1).max(120),
          description: z.string().trim().min(3).max(1000),
          reportedOn: date,
          reportedBy: z.string().trim().max(200).default(''),
          responsiblePartyId: z.uuid().nullable().default(null),
        }),
      ),
    )
    b: {
      contractId: string | null;
      area: string;
      description: string;
      reportedOn: string;
      reportedBy: string;
      responsiblePartyId: string | null;
    },
  ) {
    return this.handover.reportDefect(c, id, b);
  }

  @Post('defects/:id/fixed')
  @HttpCode(200)
  @RequiresFeatures()
  fixed(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: date }))) b: { on: string },
  ) {
    return this.handover.fixDefect(c, id, b.on);
  }

  @Post('subcontract-bills/:id/snag-backcharges')
  @HttpCode(200)
  @RequiresFeatures()
  charge(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.chargeSnags(c, id);
  }
}
