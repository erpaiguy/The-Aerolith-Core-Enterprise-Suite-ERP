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
import { PurchaseOrderService } from './purchase-order.service.js';

const date = z.iso.date();
const decimal = (max: number) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => new RegExp(`^\\d{1,14}(\\.\\d{1,${max}})?$`).test(v), {
      message: `A number with up to ${max} decimals`,
    });
const revision = z.object({
  siteId: z.uuid().nullable().default(null),
  deliverBy: date.nullable().default(null),
  paymentTerms: z.string().trim().max(2000).default(''),
  deliveryTerms: z.string().trim().max(2000).default(''),
  otherTerms: z.string().trim().max(8000).default(''),
  reason: z.string().trim().max(2000).default(''),
  lines: z
    .array(
      z.object({
        lineKey: z.uuid().nullable().default(null),
        resourceId: z.uuid().nullable().default(null),
        rfqLineId: z.uuid().nullable().default(null),
        description: z.string().trim().min(1).max(1000),
        hsn: z
          .string()
          .trim()
          .regex(/^(\d{4,8})?$/, { message: 'HSN or SAC: 4 to 8 digits' })
          .transform((v) => v || null)
          .nullable()
          .default(null),
        unit: z.string().trim().min(1).max(20),
        qty: decimal(4).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
        rate: decimal(4),
        gstPct: decimal(2).refine((v) => Number(v) <= 28, { message: 'At most 28%' }),
      }),
    )
    .max(500),
});
const create = revision.extend({
  kind: z.enum(['purchase', 'work']),
  partyId: z.uuid(),
});
const update = revision.extend({ rowVersion: z.number().int().positive() });
const rowVersion = z.object({ rowVersion: z.number().int().positive() });
const reason = z.object({ reason: z.string().trim().min(3).max(2000) });
const acknowledge = z.object({
  on: date,
  reference: z.string().trim().max(200).default(''),
});
const list = z.object({
  projectId: z.uuid().optional(),
  status: z.enum(['open', 'draft', 'issued', 'acknowledged', 'closed', 'cancelled']).optional(),
});

/**
 * Purchase and work orders (docs/wave2b-plan.md step 4). Kept to each project's team, and changed by its members with
 * `purchase.edit`, by the service.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class PurchaseOrderController {
  constructor(private readonly orders: PurchaseOrderService) {}

  @Get('orders')
  list(@Auth() c: TenantClaims, @Query(new ZodPipe(list)) q: z.infer<typeof list>) {
    return this.orders.list(c, q);
  }

  @Post('projects/:id/orders')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(create)) b: z.infer<typeof create>,
  ) {
    const { kind, partyId, ...input } = b;
    return this.orders.create(c, id, { kind, partyId }, input);
  }

  @Post('rfqs/:id/orders')
  @HttpCode(200)
  @RequiresFeatures()
  fromRfq(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.fromRfq(c, id);
  }

  @Get('orders/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(c, id);
  }

  @Get('order-revisions/:id')
  ofRevision(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.orderOfRevision(c, id);
  }

  @Post('order-revisions/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(update)) b: z.infer<typeof update>,
  ) {
    const { rowVersion: v, ...input } = b;
    return this.orders.update(c, id, v, input);
  }

  @Post('order-revisions/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rowVersion)) b: z.infer<typeof rowVersion>,
  ) {
    return this.orders.submit(c, id, b.rowVersion);
  }

  @Post('order-revisions/:id/discard')
  @HttpCode(200)
  @RequiresFeatures()
  discard(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.discard(c, id);
  }

  @Post('orders/:id/amend')
  @HttpCode(200)
  @RequiresFeatures()
  amend(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reason)) b: z.infer<typeof reason>,
  ) {
    return this.orders.amend(c, id, b.reason);
  }

  @Post('orders/:id/acknowledge')
  @HttpCode(200)
  @RequiresFeatures()
  acknowledge(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(acknowledge)) b: z.infer<typeof acknowledge>,
  ) {
    return this.orders.acknowledge(c, id, b);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reason)) b: z.infer<typeof reason>,
  ) {
    return this.orders.cancel(c, id, b.reason);
  }

  @Post('orders/:id/close')
  @HttpCode(200)
  @RequiresFeatures()
  close(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reason)) b: z.infer<typeof reason>,
  ) {
    return this.orders.close(c, id, b.reason);
  }
}
