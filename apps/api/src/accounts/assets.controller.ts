import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AssetService, type AssetClassInput } from './assets.service.js';

const date = z.iso.date();
const amount = (places: number) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v).replace(/,/g, ''))
    .refine((v) => new RegExp(`^\\d{1,16}(\\.\\d{1,${places}})?$`).test(v), {
      message: 'A number',
    });
const cls = z.object({
  name: z.string().trim().min(2).max(120),
  lifeYears: amount(2).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
  method: z.enum(['slm', 'wdv']),
  residualPct: amount(2)
    .refine((v) => Number(v) <= 100, { message: 'At most 100%' })
    .default('5'),
  itRate: amount(2).refine((v) => Number(v) <= 100, { message: 'At most 100%' }),
  accountId: z.uuid(),
  rowVersion: z.number().int().positive().optional(),
});
const asset = z.object({
  entityId: z.uuid(),
  name: z.string().trim().min(2).max(200),
  classId: z.uuid(),
  source: z.enum(['bill', 'opening']),
  vendorBillId: z.uuid().nullable().default(null),
  purchasedOn: date,
  putToUseOn: date,
  cost: amount(2).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
  openingDepreciation: amount(2).default('0'),
  itOpeningWdv: amount(2).nullable().default(null),
  serialNo: z.string().trim().max(100).default(''),
  projectId: z.uuid().nullable().default(null),
  siteId: z.uuid().nullable().default(null),
  custodianId: z.uuid().nullable().default(null),
});

/** Fixed assets (docs/wave3-plan.md step 9). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class AssetController {
  constructor(private readonly assets: AssetService) {}

  @Get('accounts/asset-classes')
  classes(@Auth() c: TenantClaims) {
    return this.assets.classes(c);
  }

  @Post('accounts/asset-classes')
  @HttpCode(200)
  @RequiresFeatures()
  addClass(@Auth() c: TenantClaims, @Body(new ZodPipe(cls)) b: AssetClassInput) {
    return this.assets.saveClass(c, null, b);
  }

  @Put('accounts/asset-classes/:id')
  @RequiresFeatures()
  saveClass(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(cls)) b: AssetClassInput & { rowVersion?: number },
  ) {
    return this.assets.saveClass(c, id, b);
  }

  @Get('accounts/assets')
  list(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.assets.assets(c, q.entityId);
  }

  @Post('accounts/assets')
  @HttpCode(200)
  @RequiresFeatures()
  register(@Auth() c: TenantClaims, @Body(new ZodPipe(asset)) b: z.infer<typeof asset>) {
    return this.assets.register(c, b);
  }

  @Get('accounts/assets/tax-depreciation')
  tax(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), fy: z.string().regex(/^\d{4}-\d{2}$/) })))
    q: { entityId: string; fy: string },
  ) {
    return this.assets.taxDepreciation(c, q);
  }

  @Get('accounts/assets/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.asset(c, id);
  }

  @Post('accounts/assets/:id/transfer')
  @HttpCode(200)
  @RequiresFeatures()
  transfer(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          date,
          projectId: z.uuid().nullable().default(null),
          siteId: z.uuid().nullable().default(null),
        }),
      ),
    )
    b: { date: string; projectId: string | null; siteId: string | null },
  ) {
    return this.assets.transfer(c, id, b);
  }

  @Post('accounts/assets/:id/dispose')
  @HttpCode(200)
  @RequiresFeatures()
  dispose(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          date,
          proceeds: amount(2).default('0'),
          bankAccountId: z.uuid().nullable().default(null),
          partyId: z.uuid().nullable().default(null),
          narration: z.string().trim().max(500).default(''),
        }),
      ),
    )
    b: {
      date: string;
      proceeds: string;
      bankAccountId: string | null;
      partyId: string | null;
      narration: string;
    },
  ) {
    return this.assets.dispose(c, id, b);
  }

  @Get('accounts/depreciation-runs')
  runs(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.assets.runs(c, q.entityId);
  }

  @Post('accounts/depreciation-runs')
  @HttpCode(200)
  @RequiresFeatures()
  run(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ entityId: z.uuid(), upto: date })))
    b: { entityId: string; upto: string },
  ) {
    return this.assets.run(c, b);
  }

  @Post('accounts/depreciation-runs/:id/reverse')
  @HttpCode(200)
  @RequiresFeatures()
  reverse(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ date, reason: z.string().trim().min(3).max(500) })))
    b: { date: string; reason: string },
  ) {
    return this.assets.reverseRun(c, id, b);
  }
}
