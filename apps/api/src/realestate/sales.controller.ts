import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { reportXlsx } from '../procurement/procurement-report-excel.js';
import { SalesService } from './sales.service.js';

const amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, 'An amount in rupees');
const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'A percentage');
const date = z.iso.date();
const setup = z.object({
  reraNumber: z.string().trim().max(60).default(''),
  registeredOn: date.nullable().default(null),
  completionOn: date.nullable().default(null),
  collectionAccountId: z.uuid().nullable().default(null),
  designatedAccountId: z.uuid().nullable().default(null),
  sharePct: pct.default('70'),
  interestPct: pct.default('10.75'),
  payDays: z.number().int().min(1).max(90).default(15),
});
const unit = z.object({
  floor: z.number().int().min(-5).max(200),
  number: z.string().trim().min(1).max(20),
  kind: z.enum(['flat', 'shop', 'office']).default('flat'),
  carpetSqm: z.string().regex(/^\d{1,6}(\.\d{1,2})?$/, 'Carpet area in m²'),
  ratePerSqm: amount,
  parking: amount.default('0'),
  charges: amount.default('0'),
  gstPct: z.enum(['0', '1', '5', '12']).default('5'),
});
const stage = z.object({
  name: z.string().trim().min(2).max(120),
  pct,
  trigger: z.enum(['booking', 'agreement', 'milestone']),
  towerId: z.uuid().nullable().default(null),
});
const book = z.object({
  buyer: z.object({
    name: z.string().trim().min(2).max(120),
    coApplicant: z.string().trim().max(120).default(''),
    phone: z.string().trim().max(40).default(''),
    email: z.union([z.email().max(254), z.literal('')]).default(''),
    pan: z
      .string()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN')
      .nullable()
      .default(null),
    address: z.string().trim().max(500).default(''),
  }),
  bookedOn: date,
});
const receipt = z.object({
  on: date,
  amount,
  mode: z.enum(['bank', 'cheque', 'upi', 'neft', 'rtgs', 'loan']).default('neft'),
  reference: z.string().trim().max(100).default(''),
  // Section 194-IA (docs/wave8-plan.md step 8b.5).
  tds: amount.optional(),
  tdsAck: z.string().trim().max(40).optional(),
});
const reraEntry = z.object({
  kind: z.enum(['deposit', 'withdrawal']),
  on: date,
  amount,
  toAccountId: z.uuid().nullable().default(null),
  completionPct: pct.nullable().default(null),
  engineerRef: z.string().trim().max(100).default(''),
  architectRef: z.string().trim().max(100).default(''),
  caRef: z.string().trim().max(100).default(''),
});

/** Real estate sales and RERA (docs/wave6-plan.md step 2). Rights are checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get('projects/:id/sales')
  overview(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.overview(c, id);
  }

  @Post('projects/:id/sales/setup')
  @HttpCode(200)
  @RequiresFeatures()
  saveSetup(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setup)) b: z.infer<typeof setup>,
  ) {
    return this.sales.saveSetup(c, id, b);
  }

  @Post('projects/:id/sales/towers')
  @HttpCode(200)
  @RequiresFeatures()
  addTower(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          name: z.string().trim().min(1).max(60),
          floors: z.number().int().min(1).max(200),
        }),
      ),
    )
    b: { name: string; floors: number },
  ) {
    return this.sales.addTower(c, id, b);
  }

  @Post('sales/towers/:id/units')
  @HttpCode(200)
  @RequiresFeatures()
  addUnits(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ units: z.array(unit).min(1).max(500) })))
    b: { units: z.infer<typeof unit>[] },
  ) {
    return this.sales.addUnits(c, id, b.units);
  }

  @Post('projects/:id/sales/plan')
  @HttpCode(200)
  @RequiresFeatures()
  savePlan(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ stages: z.array(stage).min(1).max(30) })))
    b: { stages: z.infer<typeof stage>[] },
  ) {
    return this.sales.savePlan(c, id, b.stages);
  }

  @Post('sales/stages/:id/reached')
  @HttpCode(200)
  @RequiresFeatures()
  reached(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: date }))) b: { on: string },
  ) {
    return this.sales.reachMilestone(c, id, b.on);
  }

  @Post('sales/units/:id/book')
  @RequiresFeatures()
  book(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(book)) b: z.infer<typeof book>,
  ) {
    return this.sales.book(c, id, b);
  }

  @Get('projects/:id/sales/bookings')
  bookings(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.bookings(c, id);
  }

  @Get('sales/bookings/:id')
  booking(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.booking(c, id);
  }

  @Post('sales/bookings/:id/agreement')
  @HttpCode(200)
  @RequiresFeatures()
  agreement(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: date, number: z.string().trim().min(1).max(60) })))
    b: { on: string; number: string },
  ) {
    return this.sales.registerAgreement(c, id, b);
  }

  @Post('sales/bookings/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          on: date,
          reason: z.string().trim().max(1000).default(''),
          forfeit: amount.default('0'),
          refundFromAccountId: z.uuid().nullable().default(null),
        }),
      ),
    )
    b: { on: string; reason: string; forfeit: string; refundFromAccountId: string | null },
  ) {
    return this.sales.cancel(c, id, b);
  }

  @Post('sales/bookings/:id/refund')
  @HttpCode(200)
  @RequiresFeatures()
  refund(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: date, fromAccountId: z.uuid() })))
    b: { on: string; fromAccountId: string },
  ) {
    return this.sales.refund(c, id, b);
  }

  @Post('sales/bookings/:id/transfer')
  @HttpCode(200)
  @RequiresFeatures()
  transfer(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          on: date,
          buyer: book.shape.buyer,
          fee: amount.default('0'),
          note: z.string().trim().max(500).default(''),
        }),
      ),
    )
    b: {
      on: string;
      buyer: z.infer<typeof book>['buyer'];
      fee: string;
      note: string;
    },
  ) {
    return this.sales.transfer(c, id, b);
  }

  @Post('sales/bookings/:id/registration')
  @HttpCode(200)
  @RequiresFeatures()
  registration(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          stampDuty: amount,
          registrationFee: amount,
          registrationNo: z.string().trim().min(1).max(60),
          registeredOn: date,
          subRegistrar: z.string().trim().max(120).default(''),
        }),
      ),
    )
    b: {
      stampDuty: string;
      registrationFee: string;
      registrationNo: string;
      registeredOn: string;
      subRegistrar: string;
    },
  ) {
    return this.sales.registration(c, id, b);
  }

  @Post('sales/bookings/:id/offer-possession')
  @HttpCode(200)
  @RequiresFeatures()
  offerPossession(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: date }))) b: { on: string },
  ) {
    return this.sales.offerPossession(c, id, b.on);
  }

  @Post('sales/bookings/:id/hand-over')
  @HttpCode(200)
  @RequiresFeatures()
  handOver(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          on: date,
          checklist: z
            .array(
              z.object({
                item: z.string().trim().min(2).max(200),
                ok: z.boolean(),
                note: z.string().trim().max(300).default(''),
              }),
            )
            .min(1)
            .max(60),
        }),
      ),
    )
    b: { on: string; checklist: { item: string; ok: boolean; note: string }[] },
  ) {
    return this.sales.handOver(c, id, b);
  }

  @Post('sales/bookings/:id/receipts')
  @HttpCode(200)
  @RequiresFeatures()
  receive(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(receipt)) b: z.infer<typeof receipt>,
  ) {
    return this.sales.receive(c, id, b);
  }

  @Post('sales/bookings/:id/interest')
  @HttpCode(200)
  @RequiresFeatures()
  interest(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: date }))) b: { on: string },
  ) {
    return this.sales.raiseInterest(c, id, b.on);
  }

  @Get('projects/:id/sales/rera')
  rera(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.rera(c, id);
  }

  @Post('projects/:id/sales/rera')
  @HttpCode(200)
  @RequiresFeatures()
  reraEntry(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reraEntry)) b: z.infer<typeof reraEntry>,
  ) {
    return this.sales.reraEntry(c, id, b);
  }

  /** MahaRERA's quarterly update: JSON, or Excel with ?format=xlsx. */
  @Get('projects/:id/sales/quarter')
  async quarter(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ upto: date, format: z.enum(['json', 'xlsx']).default('json') })))
    q: { upto: string; format: 'json' | 'xlsx' },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.sales.quarter(c, id, q.upto);
    if (q.format === 'json') return r;
    type T = (typeof r.towers)[number];
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(
      await reportXlsx<T>(
        'Quarterly update',
        [
          `MahaRERA quarterly update: ${r.project}`,
          `Registration ${r.reraNumber || '(not set)'} · ${r.from} to ${r.upto}`,
          `Collected in the quarter ₹${r.collectedInQuarter}, to date ₹${r.collectedToDate} · designated account: deposited ₹${r.depositedInQuarter}, withdrawn ₹${r.withdrawnInQuarter} in the quarter`,
        ],
        [
          { header: 'Tower', value: (t) => t.tower, width: 14 },
          { header: 'Units', value: (t) => t.units, width: 8 },
          { header: 'Booked in quarter', value: (t) => t.bookedInQuarter, width: 16 },
          { header: 'Booked to date', value: (t) => t.bookedToDate, width: 14 },
          { header: 'Milestones reached', value: (t) => t.milestonesReached.join(', '), width: 50 },
        ],
        r.towers,
      ),
      {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        disposition: attachment(`MahaRERA quarterly update ${r.upto}.xlsx`),
      },
    );
  }
}
