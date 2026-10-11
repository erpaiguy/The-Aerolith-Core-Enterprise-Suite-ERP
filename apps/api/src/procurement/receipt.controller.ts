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
import { ReceiptService } from './receipt.service.js';

const date = z.iso.date();
const qty = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v), { message: 'A number with up to 4 decimals' });
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable()
    .default(null);
const receive = z.object({
  receivedOn: date,
  siteId: z.uuid().nullable().default(null),
  challanNo: z.string().trim().min(1).max(100),
  challanDate: date.nullable().default(null),
  invoiceNo: text(100),
  vehicleNo: text(30),
  notes: z.string().trim().max(4000).default(''),
  lines: z
    .array(
      z.object({
        lineKey: z.uuid(),
        qty: qty.refine((v) => Number(v) > 0, { message: 'More than nothing' }),
        rejected: qty.default('0'),
        reason: text(1000),
        hold: z.boolean().default(false),
      }),
    )
    .max(500),
});
const inspect = z.object({
  lines: z
    .array(
      z.object({
        position: z.number().int().positive(),
        accepted: qty,
        rejected: qty.default('0'),
        reason: text(1000),
      }),
    )
    .min(1)
    .max(500),
});
const goodsReturn = z.object({
  returnedOn: date,
  reference: text(200),
  reason: z.string().trim().min(3).max(2000),
  lines: z
    .array(
      z.object({
        position: z.number().int().positive(),
        qty: qty.refine((v) => Number(v) > 0, { message: 'More than nothing' }),
      }),
    )
    .max(500),
});
const cancel = z.object({ reason: z.string().trim().min(3).max(2000) });
const list = z.object({
  projectId: z.uuid().optional(),
  held: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/**
 * Goods receipts (docs/wave2b-plan.md step 5). Kept to each project's team, and made by its members with
 * `stores.receive`, by the service.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ReceiptController {
  constructor(private readonly receipts: ReceiptService) {}

  @Get('receipts')
  list(@Auth() c: TenantClaims, @Query(new ZodPipe(list)) q: z.infer<typeof list>) {
    return this.receipts.list(c, q);
  }

  @Post('orders/:id/receipts')
  @HttpCode(200)
  @RequiresFeatures()
  receive(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(receive)) b: z.infer<typeof receive>,
  ) {
    return this.receipts.receive(c, id, b);
  }

  @Get('receipts/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.get(c, id);
  }

  @Post('receipts/:id/inspect')
  @HttpCode(200)
  @RequiresFeatures()
  inspect(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(inspect)) b: z.infer<typeof inspect>,
  ) {
    return this.receipts.inspect(c, id, b);
  }

  @Post('receipts/:id/returns')
  @HttpCode(200)
  @RequiresFeatures()
  returnGoods(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(goodsReturn)) b: z.infer<typeof goodsReturn>,
  ) {
    return this.receipts.returnGoods(c, id, b);
  }

  @Post('receipts/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(cancel)) b: z.infer<typeof cancel>,
  ) {
    return this.receipts.cancel(c, id, b.reason);
  }
}
