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
import { ScrapToolsService, type ScrapSaleInput } from './scrap-tools.service.js';

const date = z.iso.date();
const num = (places: number) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => new RegExp(`^\\d{1,14}(\\.\\d{1,${places}})?$`).test(v) && Number(v) > 0, {
      message: 'More than nothing',
    });
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Scrap and returnable tools (docs/wave8-plan.md step 8e.5). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ScrapToolsController {
  constructor(private readonly svc: ScrapToolsService) {}

  @Get('projects/:id/scrap')
  scrap(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.scrap(c, id);
  }

  @Post('projects/:id/scrap')
  @HttpCode(200)
  @RequiresFeatures()
  note(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          material: text(2, 200),
          unit: text(1, 20),
          qty: num(4),
          source: z.enum(['cut_ends', 'packing', 'demolition', 'damaged', 'other']),
          notedOn: date,
          note: z.string().trim().max(500).default(''),
        }),
      ),
    )
    b: {
      material: string;
      unit: string;
      qty: string;
      source: string;
      notedOn: string;
      note: string;
    },
  ) {
    return this.svc.noteScrap(c, id, b);
  }

  @Post('projects/:id/scrap-sales')
  @HttpCode(200)
  @RequiresFeatures()
  sell(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          partyId: z.uuid(),
          siteId: z.uuid(),
          soldOn: date,
          lines: z
            .array(
              z.object({
                material: text(2, 200),
                unit: text(1, 20),
                qty: num(4),
                rate: num(4),
                gstPct: z
                  .union([z.string().trim(), z.number()])
                  .transform((v) => String(v))
                  .refine((v) => /^\d{1,2}(\.\d{1,2})?$/.test(v) && Number(v) <= 28, {
                    message: 'At most 28%',
                  }),
              }),
            )
            .min(1)
            .max(50),
        }),
      ),
    )
    b: ScrapSaleInput,
  ) {
    return this.svc.sell(c, id, b);
  }

  @Get('projects/:id/tools')
  tools(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.tools(c, id);
  }

  @Post('projects/:id/tools')
  @HttpCode(200)
  @RequiresFeatures()
  issue(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          tool: text(2, 200),
          qty: z.number().int().min(1).max(100000),
          issuedTo: text(2, 200),
          issuedOn: date,
          dueOn: date,
          note: z.string().trim().max(500).default(''),
        }),
      ),
    )
    b: {
      tool: string;
      qty: number;
      issuedTo: string;
      issuedOn: string;
      dueOn: string;
      note: string;
    },
  ) {
    return this.svc.issueTool(c, id, b);
  }

  @Post('tool-issues/:id/return')
  @HttpCode(200)
  @RequiresFeatures()
  back(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          returned: z.number().int().min(0).default(0),
          lost: z.number().int().min(0).default(0),
          on: date,
          note: z.string().trim().max(500).default(''),
        }),
      ),
    )
    b: { returned: number; lost: number; on: string; note: string },
  ) {
    return this.svc.returnTool(c, id, b);
  }

  @Get('procurement/overdue-tools')
  overdue(@Auth() c: TenantClaims) {
    return this.svc.overdueTools(c);
  }
}
