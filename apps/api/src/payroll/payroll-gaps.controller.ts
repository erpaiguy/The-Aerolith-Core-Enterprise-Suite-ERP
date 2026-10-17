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
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { PayrollGapsService } from './payroll-gaps.service.js';

const date = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month: YYYY-MM');
const amount = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v).replace(/,/g, ''))
  .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), { message: 'An amount' });
const year = z.coerce.number().int().min(2000).max(2100);

/** Payroll gaps (docs/wave8-plan.md step 8c.4). Who may do what is checked by the service. */
@Controller('tenant/payroll')
@UseGuards(TenantAuthGuard)
export class PayrollGapsController {
  constructor(private readonly gaps: PayrollGapsService) {}

  @Get('employees/:id/overtime')
  overtime(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ month }))) q: { month: string },
  ) {
    return this.gaps.overtime(c, id, q.month);
  }

  @Post('employees/:id/overtime')
  @HttpCode(200)
  @RequiresFeatures()
  addOvertime(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          day: date,
          hours: z
            .union([z.string().trim(), z.number()])
            .transform((v) => String(v))
            .refine((v) => /^\d{1,2}(\.\d)?$/.test(v) && Number(v) > 0 && Number(v) <= 16, {
              message: 'Up to 16 hours',
            }),
          reason: z.string().trim().max(300).default(''),
        }),
      ),
    )
    b: { day: string; hours: string; reason: string },
  ) {
    return this.gaps.addOvertime(c, id, b);
  }

  @Delete('overtime/:id')
  removeOvertime(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.gaps.removeOvertime(c, id);
  }

  @Get('employees/:id/loans')
  loans(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.gaps.loans(c, id);
  }

  @Post('employees/:id/loans')
  @HttpCode(200)
  @RequiresFeatures()
  giveLoan(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          kind: z.enum(['loan', 'advance']),
          principal: amount.refine((v) => Number(v) > 0, { message: 'More than zero' }),
          emi: amount.refine((v) => Number(v) > 0, { message: 'More than zero' }),
          firstMonth: month,
          givenOn: date,
          bankAccountId: z.uuid(),
          note: z.string().trim().max(300).default(''),
        }),
      ),
    )
    b: {
      kind: 'loan' | 'advance';
      principal: string;
      emi: string;
      firstMonth: string;
      givenOn: string;
      bankAccountId: string;
      note: string;
    },
  ) {
    return this.gaps.giveLoan(c, id, b);
  }

  @Get('employees/:id/declarations')
  declarations(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ year }))) q: { year: number },
  ) {
    return this.gaps.declarations(c, id, q.year);
  }

  @Post('employees/:id/declarations')
  @HttpCode(200)
  @RequiresFeatures()
  declare(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          fyStart: year,
          section: z.enum(['80C', '80CCD1B', '80D', '24b', 'HRA', '80E', '80G', 'other']),
          description: z.string().trim().max(200).default(''),
          declared: amount,
        }),
      ),
    )
    b: { fyStart: number; section: string; description: string; declared: string },
  ) {
    return this.gaps.declare(c, id, b);
  }

  @Post('declarations/:id/verify')
  @HttpCode(200)
  @RequiresFeatures()
  verify(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ proved: amount }))) b: { proved: string },
  ) {
    return this.gaps.verify(c, id, b.proved);
  }

  @Get('bonus')
  bonus(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(z.object({ entityId: z.uuid(), year, pct: z.coerce.number().default(8.33) })),
    )
    q: { entityId: string; year: number; pct: number },
  ) {
    return this.gaps.bonus(c, { entityId: q.entityId, fyStart: q.year, pct: q.pct });
  }
}
