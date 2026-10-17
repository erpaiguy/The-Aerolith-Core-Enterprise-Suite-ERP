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
import { DeliveryService } from './delivery.service.js';

const date = z.iso.date();
const qty = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v) && Number(v) > 0, {
    message: 'A quantity, more than nothing',
  });

/** Delivery follow-up (docs/wave8-plan.md step 8e.2). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get('orders/:id/follow-up')
  followUp(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.followUp(c, id);
  }

  @Post('orders/:id/schedule')
  @HttpCode(200)
  @RequiresFeatures()
  schedule(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          lineKey: z.uuid(),
          slots: z
            .array(
              z.object({
                dueOn: date,
                qty,
                note: z.string().trim().max(300).default(''),
              }),
            )
            .max(60),
        }),
      ),
    )
    b: { lineKey: string; slots: { dueOn: string; qty: string; note: string }[] },
  ) {
    return this.delivery.setSchedule(c, id, b.lineKey, b.slots);
  }

  @Post('orders/:id/expedite')
  @HttpCode(200)
  @RequiresFeatures()
  expedite(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          note: z.string().trim().min(3).max(2000),
          promisedOn: date.nullable().default(null),
        }),
      ),
    )
    b: { note: string; promisedOn: string | null },
  ) {
    return this.delivery.addNote(c, id, b);
  }

  @Post('orders/:id/receipt-tolerance')
  @HttpCode(200)
  @RequiresFeatures()
  tolerance(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          pct: z
            .union([z.string().trim(), z.number()])
            .transform((v) => String(v))
            .refine((v) => /^\d{1,2}(\.\d{1,2})?$/.test(v) && Number(v) <= 25, {
              message: 'At most 25%',
            }),
        }),
      ),
    )
    b: { pct: string },
  ) {
    return this.delivery.setTolerance(c, id, b.pct);
  }

  @Get('procurement/overdue-deliveries')
  overdue(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ projectId: z.uuid().optional() }))) q: { projectId?: string },
  ) {
    return this.delivery.overdue(c, q);
  }

  @Get('procurement/lead-times')
  leadTimes(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ from: date, to: date, projectId: z.uuid().optional() })))
    q: { from: string; to: string; projectId?: string },
  ) {
    return this.delivery.leadTimes(c, q);
  }
}
