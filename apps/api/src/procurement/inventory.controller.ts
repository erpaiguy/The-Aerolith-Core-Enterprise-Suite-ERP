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
import { Idempotent } from '../common/idempotency.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ReconciliationService } from './reconciliation.service.js';
import { InventoryService } from './inventory.service.js';

const date = z.iso.date();
const qty = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v), { message: 'A number with up to 4 decimals' });
const positive = qty.refine((v) => Number(v) > 0, { message: 'More than nothing' });
const store = z.object({ siteId: z.uuid(), name: z.string().trim().min(2).max(200) });
const issue = z.object({
  issuedOn: date,
  wbsCode: z.string().trim().min(1).max(40),
  issuedTo: z.string().trim().min(1).max(200),
  purpose: z.string().trim().max(1000).default(''),
  equipmentId: z.uuid().nullable().default(null),
  lines: z
    .array(
      z.object({
        resourceId: z.uuid(),
        qty: positive,
        boqCode: z
          .string()
          .trim()
          .max(40)
          .transform((v) => v || null)
          .nullable()
          .default(null),
      }),
    )
    .max(200),
});
const back = z.object({
  returnedOn: date,
  lines: z.array(z.object({ position: z.number().int().positive(), qty: positive })).max(200),
});
const transfer = z.object({
  toStoreId: z.uuid(),
  sentOn: date,
  note: z.string().trim().max(1000).default(''),
  lines: z.array(z.object({ resourceId: z.uuid(), qty: positive })).max(200),
});
const received = z.object({ receivedOn: date });
const count = z.object({
  countedOn: date,
  notes: z.string().trim().max(2000).default(''),
  lines: z
    .array(
      z.object({
        resourceId: z.uuid(),
        counted: qty,
        reason: z.string().trim().max(500).default(''),
      }),
    )
    .max(2000),
});
const countUpdate = count.extend({ rowVersion: z.number().int().positive() });
const rowVersion = z.object({ rowVersion: z.number().int().positive() });
const reorder = z.object({ resourceId: z.uuid(), level: positive.nullable() });
const method = z.object({ method: z.enum(['average', 'fifo']) });
const list = z.object({ projectId: z.uuid().optional() });

/** Inventory (docs/wave2b-plan.md step 6). Kept to each project's team by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class InventoryController {
  constructor(
    private readonly reconciliations: ReconciliationService,
    private readonly inventory: InventoryService,
  ) {}

  @Get('stock/valuation')
  getValuation(@Auth() c: TenantClaims) {
    return this.inventory.getValuation(c);
  }

  @Post('stock/valuation')
  @HttpCode(200)
  @RequiresFeatures()
  setValuation(@Auth() c: TenantClaims, @Body(new ZodPipe(method)) b: z.infer<typeof method>) {
    return this.inventory.setValuation(c, b.method);
  }

  @Get('stores')
  stores(@Auth() c: TenantClaims, @Query(new ZodPipe(list)) q: z.infer<typeof list>) {
    return this.inventory.listStores(c, q.projectId);
  }

  @Post('projects/:id/stores')
  @HttpCode(200)
  @RequiresFeatures()
  createStore(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(store)) b: z.infer<typeof store>,
  ) {
    return this.inventory.createStore(c, id, b);
  }

  /** Each item's estimated materials per unit against issues; labour against wage sheets (step 7c.3). */
  @Get('projects/:id/estimate-vs-actual')
  estimateVsActual(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() })))
    q: { from?: string; to?: string },
  ) {
    return this.reconciliations.estimateVsActual(c, id, q);
  }

  /** Measured work's materials against what was issued (docs/wave7-plan.md step 7c.2). */
  @Get('projects/:id/material-reconciliation')
  reconciliation(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() })))
    q: { from?: string; to?: string },
  ) {
    return this.reconciliations.reconcile(c, id, q);
  }

  @Get('projects/:id/consumption')
  consumption(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.consumption(c, id);
  }

  @Get('stores/:id')
  store(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getStore(c, id);
  }

  @Get('stores/:id/ledger/:resourceId')
  ledger(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
  ) {
    return this.inventory.ledger(c, id, resourceId);
  }

  @Post('stores/:id/reorder')
  @HttpCode(200)
  @RequiresFeatures()
  reorder(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reorder)) b: z.infer<typeof reorder>,
  ) {
    return this.inventory.setReorder(c, id, b.resourceId, b.level);
  }

  @Post('stores/:id/reorder-requisition')
  @HttpCode(200)
  @RequiresFeatures()
  reorderRequisition(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.reorderRequisition(c, id);
  }

  @Post('stores/:id/issues')
  @Idempotent()
  @HttpCode(200)
  @RequiresFeatures()
  issue(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(issue)) b: z.infer<typeof issue>,
  ) {
    return this.inventory.issue(c, id, b);
  }

  @Get('issues/:id')
  getIssue(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getIssue(c, id);
  }

  @Post('issues/:id/returns')
  @HttpCode(200)
  @RequiresFeatures()
  returnToStore(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(back)) b: z.infer<typeof back>,
  ) {
    return this.inventory.returnToStore(c, id, b);
  }

  @Post('stores/:id/transfers')
  @HttpCode(200)
  @RequiresFeatures()
  transfer(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(transfer)) b: z.infer<typeof transfer>,
  ) {
    return this.inventory.transfer(c, id, b);
  }

  @Get('transfers/:id')
  getTransfer(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getTransfer(c, id);
  }

  @Post('transfers/:id/receive')
  @HttpCode(200)
  @RequiresFeatures()
  receiveTransfer(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(received)) b: z.infer<typeof received>,
  ) {
    return this.inventory.receiveTransfer(c, id, b.receivedOn);
  }

  @Post('transfers/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancelTransfer(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.cancelTransfer(c, id);
  }

  @Post('stores/:id/counts')
  @HttpCode(200)
  @RequiresFeatures()
  startCount(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(count)) b: z.infer<typeof count>,
  ) {
    return this.inventory.startCount(c, id, b);
  }

  @Get('stock-counts/:id')
  getCount(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getCount(c, id);
  }

  @Post('stock-counts/:id')
  @HttpCode(200)
  @RequiresFeatures()
  updateCount(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(countUpdate)) b: z.infer<typeof countUpdate>,
  ) {
    const { rowVersion: v, ...input } = b;
    return this.inventory.updateCount(c, id, v, input);
  }

  @Post('stock-counts/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submitCount(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rowVersion)) b: z.infer<typeof rowVersion>,
  ) {
    return this.inventory.submitCount(c, id, b.rowVersion);
  }

  @Post('stock-counts/:id/discard')
  @HttpCode(200)
  @RequiresFeatures()
  discardCount(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.discardCount(c, id);
  }
}
