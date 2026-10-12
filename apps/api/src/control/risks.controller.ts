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
import { RisksService } from './risks.service.js';

const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'An amount in rupees');
const level = z.number().int().min(1).max(5);
const risk = z.object({
  category: z.enum(['commercial', 'design', 'site', 'safety', 'regulatory', 'schedule', 'other']),
  cause: z.string().trim().max(2000).default(''),
  event: z.string().trim().min(3).max(1000),
  effect: z.string().trim().max(2000).default(''),
  probability: level,
  impact: level,
  costImpact: money.default('0'),
  timeImpact: z.number().int().min(0).max(3650).default(0),
  ownerId: z.uuid().nullable().default(null),
  wbsId: z.uuid().nullable().default(null),
  costCodeId: z.uuid().nullable().default(null),
  status: z.enum(['open', 'closed', 'occurred']).default('open'),
});
const riskUpdate = risk.extend({ rowVersion: z.number().int().positive() });
const action = z.object({
  action: z.string().trim().min(3).max(1000),
  dueOn: z.iso.date().nullable().default(null),
});
const scales = z.object({
  probability: z
    .array(
      z.object({ level, label: z.string().trim().min(1).max(40), pct: z.number().min(0).max(100) }),
    )
    .length(5),
  impact: z.array(z.object({ level, label: z.string().trim().min(1).max(40) })).length(5),
});

/** The risk register (docs/wave4-plan.md step 6). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class RisksController {
  constructor(private readonly risks: RisksService) {}

  @Get('projects/:id/risks')
  project(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.risks.register(c, id);
  }

  @Post('projects/:id/risks')
  @RequiresFeatures()
  createForProject(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(risk)) b: z.infer<typeof risk>,
  ) {
    return this.risks.create(c, id, b);
  }

  @Get('risks')
  company(@Auth() c: TenantClaims) {
    return this.risks.register(c, null);
  }

  @Post('risks')
  @RequiresFeatures()
  createForCompany(@Auth() c: TenantClaims, @Body(new ZodPipe(risk)) b: z.infer<typeof risk>) {
    return this.risks.create(c, null, b);
  }

  @Post('risk-scales')
  @HttpCode(200)
  @RequiresFeatures()
  setScales(@Auth() c: TenantClaims, @Body(new ZodPipe(scales)) b: z.infer<typeof scales>) {
    return this.risks.setScales(c, b);
  }

  @Post('risks/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(riskUpdate)) b: z.infer<typeof riskUpdate>,
  ) {
    return this.risks.update(c, id, b);
  }

  @Post('risks/:id/actions')
  @HttpCode(200)
  @RequiresFeatures()
  addAction(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(action)) b: z.infer<typeof action>,
  ) {
    return this.risks.addAction(c, id, b);
  }

  @Post('risk-actions/:id/done')
  @HttpCode(200)
  @RequiresFeatures()
  done(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: z.iso.date().nullable() }))) b: { on: string | null },
  ) {
    return this.risks.actionDone(c, id, b.on);
  }

  @Post('projects/:id/contingency')
  @HttpCode(200)
  @RequiresFeatures()
  contingency(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ held: money }))) b: { held: string },
  ) {
    return this.risks.setContingency(c, id, b.held);
  }

  @Post('risks/:id/draws')
  @HttpCode(200)
  @RequiresFeatures()
  draw(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          amount: money,
          date: z.iso.date(),
          note: z.string().trim().max(1000).default(''),
        }),
      ),
    )
    b: { amount: string; date: string; note: string },
  ) {
    return this.risks.draw(c, id, b);
  }
}
