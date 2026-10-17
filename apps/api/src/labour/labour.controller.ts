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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { Idempotent } from '../common/idempotency.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LabourService, type WorkerInput } from './labour.service.js';

const date = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month: YYYY-MM');
const amount = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v).replace(/,/g, ''))
  .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), { message: 'An amount' });
const maybe = <T extends z.ZodType<string>>(t: T) =>
  z.union([z.literal('').transform(() => null), t, z.null()]).default(null);
const skill = z.enum(['unskilled', 'semi_skilled', 'skilled', 'highly_skilled']);
const contractor = z.object({
  licenceNo: z.string().trim().max(60).default(''),
  licenceWorkers: z.number().int().positive().nullable().default(null),
  licenceValidTo: date.nullable().default(null),
  bocwRegistration: z.string().trim().max(60).default(''),
});
const worker = z.object({
  name: z.string().trim().min(2).max(200),
  relative: z.string().trim().max(200).default(''),
  gender: z.enum(['female', 'male', 'other']).nullable().default(null),
  birthDate: date.nullable().default(null),
  trade: z.string().trim().min(2).max(60),
  skill,
  dailyWage: amount,
  aadhaarLast4: maybe(
    z
      .string()
      .trim()
      .regex(/^\d{4}$/, "Only Aadhaar's last four digits"),
  ),
  aadhaarConsentOn: date.nullable().default(null),
  uan: maybe(
    z
      .string()
      .trim()
      .regex(/^\d{12}$/, 'A UAN: 12 digits'),
  ),
  esiNumber: maybe(
    z
      .string()
      .trim()
      .regex(/^\d{10,17}$/, 'An ESI number'),
  ),
  joinedOn: date,
});
const workerUpdate = z.object({
  dailyWage: amount.optional(),
  trade: z.string().trim().min(2).max(60).optional(),
  skill: skill.optional(),
  leftOn: date.nullable().optional(),
  rowVersion: z.number().int(),
});
const minWage = z.object({
  stateCode: z.string().regex(/^\d{2}$/),
  skill,
  zone: z.string().trim().max(60).default(''),
  effectiveFrom: date,
  daily: amount,
  note: z.string().trim().max(300).default(''),
});
const muster = z.object({
  date,
  partyId: z.uuid(),
  marks: z
    .array(
      z.object({
        workerId: z.uuid(),
        status: z.enum(['present', 'half_day', 'absent']).nullable(),
        overtimeHours: z
          .union([z.string().trim(), z.number()])
          .transform((v) => String(v || 0))
          .refine((v) => /^\d{1,2}(\.\d)?$/.test(v) && Number(v) <= 16, {
            message: 'Up to 16 hours',
          })
          .default('0'),
      }),
    )
    .max(2000),
  // From a phone (docs/wave8-plan.md step 8c.2): where it was, and a photo as a data URL.
  proof: z
    .object({
      latitude: z.number().min(-90).max(90).nullable().default(null),
      longitude: z.number().min(-180).max(180).nullable().default(null),
      photo: z.string().max(820_000).nullable().default(null),
    })
    .optional(),
});

/** Contract labour (docs/wave3-plan.md step 13). Who may do what is checked by the service. */
@Controller('tenant/labour')
@UseGuards(TenantAuthGuard)
export class LabourController {
  constructor(private readonly labour: LabourService) {}

  @Get('contractors')
  contractors(@Auth() c: TenantClaims) {
    return this.labour.contractors(c);
  }

  @Put('contractors/:partyId')
  @RequiresFeatures()
  saveContractor(
    @Auth() c: TenantClaims,
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Body(new ZodPipe(contractor)) b: z.infer<typeof contractor>,
  ) {
    return this.labour.saveContractor(c, partyId, b);
  }

  @Get('contractors/:partyId/workers')
  workers(@Auth() c: TenantClaims, @Param('partyId', ParseUUIDPipe) partyId: string) {
    return this.labour.workers(c, partyId);
  }

  @Post('contractors/:partyId/workers')
  @HttpCode(200)
  @RequiresFeatures()
  addWorker(
    @Auth() c: TenantClaims,
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Body(new ZodPipe(worker)) b: WorkerInput,
  ) {
    return this.labour.addWorker(c, partyId, b);
  }

  @Put('workers/:id')
  @RequiresFeatures()
  updateWorker(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(workerUpdate)) b: z.infer<typeof workerUpdate>,
  ) {
    return this.labour.updateWorker(c, id, b);
  }

  /** Compliance as principal employer (docs/wave8-plan.md step 8c.1): PF and ESI due and paid, and what holds bills. */
  @Get('contractors/:partyId/compliance')
  compliance(
    @Auth() c: TenantClaims,
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Query(new ZodPipe(z.object({ on: date }))) q: { on: string },
  ) {
    return this.labour.compliance(c, partyId, q.on);
  }

  @Post('contractors/:partyId/challans')
  @HttpCode(200)
  @RequiresFeatures()
  addChallan(
    @Auth() c: TenantClaims,
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Body(
      new ZodPipe(
        z.object({
          month,
          kind: z.enum(['pf', 'esi']),
          reference: z.string().trim().min(3).max(40),
          amount: amount.refine((v) => Number(v) > 0, { message: 'More than zero' }),
          paidOn: date,
        }),
      ),
    )
    b: { month: string; kind: 'pf' | 'esi'; reference: string; amount: string; paidOn: string },
  ) {
    return this.labour.addChallan(c, partyId, b);
  }

  @Get('contractors/:partyId/wage-sheets')
  sheets(@Auth() c: TenantClaims, @Param('partyId', ParseUUIDPipe) partyId: string) {
    return this.labour.sheets(c, partyId);
  }

  @Get('min-wages')
  minWages(@Auth() c: TenantClaims) {
    return this.labour.minWages(c);
  }

  @Post('min-wages')
  @HttpCode(200)
  @RequiresFeatures()
  addMinWage(@Auth() c: TenantClaims, @Body(new ZodPipe(minWage)) b: z.infer<typeof minWage>) {
    return this.labour.addMinWage(c, b);
  }

  @Get('sites/:id/muster')
  muster(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ date, partyId: z.uuid() }))) q: { date: string; partyId: string },
  ) {
    return this.labour.muster(c, id, q.date, q.partyId);
  }

  @Post('sites/:id/muster')
  @HttpCode(200)
  @RequiresFeatures()
  @Idempotent()
  mark(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(muster)) b: z.infer<typeof muster>,
  ) {
    return this.labour.mark(c, id, b);
  }

  @Get('muster-proofs/:id/photo')
  async proofPhoto(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.labour.proofPhoto(c, id);
    reply.header('Cache-Control', 'private, max-age=86400');
    return new StreamableFile(p.bytes, { type: p.type });
  }

  @Post('wage-sheets')
  @HttpCode(200)
  @RequiresFeatures()
  createSheet(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ partyId: z.uuid(), siteId: z.uuid(), month })))
    b: { partyId: string; siteId: string; month: string },
  ) {
    return this.labour.createSheet(c, b);
  }

  @Get('wage-sheets/:id')
  sheet(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.labour.sheet(c, id);
  }

  @Post('wage-sheets/:id/work')
  @HttpCode(200)
  @RequiresFeatures()
  work(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.labour.workSheet(c, id);
  }

  @Post('wage-sheets/:id/pass')
  @HttpCode(200)
  @RequiresFeatures()
  pass(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.labour.pass(c, id);
  }

  @Post('wage-sheets/:id/verify')
  @HttpCode(200)
  @RequiresFeatures()
  verify(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          paidOn: date,
          reference: z.string().trim().min(2).max(60),
          mode: z.enum(['bank', 'cash', 'upi']),
        }),
      ),
    )
    b: { paidOn: string; reference: string; mode: string },
  ) {
    return this.labour.verify(c, id, b);
  }

  @Get('wage-sheets/:id/registers')
  async registers(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.labour.registers(c, id);
    return new StreamableFile(r.buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(r.fileName),
    });
  }

  @Get('projects/:id/cess')
  cess(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.labour.cess(c, id);
  }

  @Post('projects/:id/cess')
  @HttpCode(200)
  @RequiresFeatures()
  payCess(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          paidOn: date,
          amount,
          reference: z.string().trim().min(2).max(60),
          bankAccountId: z.uuid(),
        }),
      ),
    )
    b: { paidOn: string; amount: string; reference: string; bankAccountId: string },
  ) {
    return this.labour.payCess(c, id, b);
  }
}
