import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { PayrollService, type RuleKind, type SalaryInput } from './payroll.service.js';

const date = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month: YYYY-MM');
const amount = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v).replace(/,/g, ''))
  .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), { message: 'An amount' });
const pct = z.number().min(0).max(100);
const money = z.number().min(0).max(1e9);
const taxRegime = z.object({
  slabs: z
    .array(z.object({ upTo: money.nullable(), rate: pct }))
    .min(1)
    .refine((s) => s[s.length - 1]!.upTo === null, { message: 'The top slab has no upper end' }),
  standardDeduction: money,
  rebateUpTo: money,
  marginalRelief: z.boolean(),
  cess: pct,
});
/** Each kind of rule's figures, checked before they are kept. */
const RULE_DATA: Record<RuleKind, z.ZodType> = {
  wages: z.object({ excludedCap: pct }),
  pf: z.object({
    ceiling: money,
    employeeRate: pct,
    employerRate: pct,
    epsRate: pct,
    edliRate: pct,
    adminRate: pct,
  }),
  esi: z.object({ ceiling: money, employeeRate: pct, employerRate: pct }),
  pt: z.object({
    slabs: z.array(
      z.object({
        from: money,
        amount: money,
        february: money.optional(),
        gender: z.enum(['female', 'male']).optional(),
      }),
    ),
  }),
  lwf: z.object({
    employee: money,
    employer: money,
    months: z.array(z.number().int().min(1).max(12)),
  }),
  income_tax: z.object({ new: taxRegime, old: taxRegime }),
};
const rule = z
  .object({
    kind: z.enum(['wages', 'pf', 'esi', 'pt', 'lwf', 'income_tax']),
    stateCode: z
      .string()
      .regex(/^\d{2}$/)
      .nullable()
      .default(null),
    effectiveFrom: date,
    data: z.unknown(),
    note: z.string().trim().max(500).default(''),
  })
  .superRefine((r, ctx) => {
    if ((r.kind === 'pt' || r.kind === 'lwf') !== (r.stateCode !== null))
      ctx.addIssue({
        code: 'custom',
        message: 'Professional tax and LWF are by state; the rest are not',
      });
    const parsed = RULE_DATA[r.kind].safeParse(r.data);
    if (!parsed.success)
      ctx.addIssue({ code: 'custom', message: `The ${r.kind} figures: ${parsed.error.message}` });
  });
const component = z.object({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z][A-Z0-9_]{0,11}$/.test(v), { message: 'Up to 12 letters, digits or _' }),
  name: z.string().trim().min(2).max(60),
  kind: z.enum(['earning', 'deduction']),
  inWages: z.boolean().default(false),
  taxable: z.boolean().default(true),
  prorated: z.boolean().default(true),
});
const salary = z.object({
  from: date,
  pfMode: z.enum(['none', 'ceiling', 'actual']).default('ceiling'),
  esi: z.boolean().default(true),
  regime: z.enum(['new', 'old']).default('new'),
  oldDeductions: amount.default('0'),
  lines: z
    .array(
      z
        .object({
          componentId: z.uuid(),
          amount: amount.nullable().default(null),
          percentOfBasic: amount.nullable().default(null),
        })
        .refine((l) => (l.amount === null) !== (l.percentOfBasic === null), {
          message: 'An amount or a percentage of basic',
        }),
    )
    .min(1)
    .max(30),
});
const adjustment = z.object({
  employeeId: z.uuid(),
  componentId: z.uuid(),
  amount,
  note: z.string().trim().max(200).default(''),
});

/** Payroll (docs/wave3-plan.md step 12). Who may do what is checked by the service. */
@Controller('tenant/payroll')
@UseGuards(TenantAuthGuard)
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('rules')
  rules(@Auth() c: TenantClaims) {
    return this.payroll.rules(c);
  }

  @Post('rules')
  @HttpCode(200)
  @RequiresFeatures()
  addRule(@Auth() c: TenantClaims, @Body(new ZodPipe(rule)) b: z.infer<typeof rule>) {
    return this.payroll.addRule(c, { ...b, data: b.data as object });
  }

  @Get('components')
  components(@Auth() c: TenantClaims) {
    return this.payroll.components(c);
  }

  @Post('components')
  @HttpCode(200)
  @RequiresFeatures()
  addComponent(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(component)) b: z.infer<typeof component>,
  ) {
    return this.payroll.addComponent(c, b);
  }

  @Get('increments')
  incrementSheet(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: z.iso.date() })))
    q: { entityId: string; from: string },
  ) {
    return this.payroll.incrementSheet(c, q.entityId, q.from);
  }

  /** Salary revisions for everyone at once (docs/wave7-plan.md step 7c.7). */
  @Post('increments')
  @HttpCode(200)
  @RequiresFeatures()
  applyIncrements(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({
          entityId: z.uuid(),
          from: z.iso.date(),
          rows: z
            .array(
              z.object({ employeeId: z.uuid(), pct: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/) }),
            )
            .min(1)
            .max(5000),
        }),
      ),
    )
    b: { entityId: string; from: string; rows: { employeeId: string; pct: string }[] },
  ) {
    return this.payroll.applyIncrements(c, b.entityId, b.from, b.rows);
  }

  @Get('employees/:id/salary')
  salaries(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.salaries(c, id);
  }

  @Post('employees/:id/salary')
  @HttpCode(200)
  @RequiresFeatures()
  setSalary(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(salary)) b: SalaryInput,
  ) {
    return this.payroll.setSalary(c, id, b);
  }

  @Get('runs')
  list(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.payroll.list(c, q.entityId);
  }

  @Post('runs')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ entityId: z.uuid(), month })))
    b: { entityId: string; month: string },
  ) {
    return this.payroll.create(c, b.entityId, b.month);
  }

  @Get('runs/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.get(c, id);
  }

  @Post('runs/:id/work')
  @HttpCode(200)
  @RequiresFeatures()
  async work(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    await this.payroll.work(c, id);
    return this.payroll.get(c, id);
  }

  @Post('runs/:id/adjustments')
  @HttpCode(200)
  @RequiresFeatures()
  addAdjustment(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(adjustment)) b: z.infer<typeof adjustment>,
  ) {
    return this.payroll.addAdjustment(c, id, b);
  }

  @Delete('runs/:id/adjustments/:adjustmentId')
  @RequiresFeatures()
  removeAdjustment(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('adjustmentId', ParseUUIDPipe) adjustmentId: string,
  ) {
    return this.payroll.removeAdjustment(c, id, adjustmentId);
  }

  @Post('runs/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submit(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.submit(c, id);
  }

  @Post('runs/:id/post')
  @HttpCode(200)
  @RequiresFeatures()
  post(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.post(c, id);
  }

  @Post('runs/:id/pay')
  @HttpCode(200)
  @RequiresFeatures()
  pay(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ bankAccountId: z.uuid(), date })))
    b: { bankAccountId: string; date: string },
  ) {
    return this.payroll.pay(c, id, b);
  }

  @Get('runs/:id/bank-file')
  async bankFile(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    const f = await this.payroll.bankFile(c, id);
    return new StreamableFile(Buffer.from(f.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: attachment(f.fileName),
    });
  }

  @Get('runs/:id/payslips/:employeeId')
  payslip(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.payroll.payslip(c, id, employeeId);
  }

  @Get('payslips/mine')
  mine(@Auth() c: TenantClaims) {
    return this.payroll.mine(c);
  }
}
