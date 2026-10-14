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
import { type EntryInput, ImprestService } from './imprest.service.js';

const amount = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'An amount in rupees, to the paisa.');
const entry = {
  date: z.iso.date(),
  amount,
  accountId: z.uuid(),
  description: z.string().trim().max(500).default(''),
  reference: z.string().trim().max(100).default(''),
};

/** Site imprest (docs/wave7-plan.md step 7d.6). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ImprestController {
  constructor(private readonly imprest: ImprestService) {}

  @Get('projects/:id/imprests')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.imprest.list(c, id);
  }

  @Post('projects/:id/imprests')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          custodianId: z.uuid(),
          purpose: z.string().trim().max(500).default(''),
          floatLimit: amount.default('0'),
        }),
      ),
    )
    b: { custodianId: string; purpose: string; floatLimit: string },
  ) {
    return this.imprest.create(c, id, b);
  }

  @Get('imprests/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.imprest.get(c, id);
  }

  @Post('imprests/:id/advances')
  @HttpCode(200)
  @RequiresFeatures()
  advance(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object(entry))) b: EntryInput,
  ) {
    return this.imprest.advance(c, id, b);
  }

  @Post('imprests/:id/expenses')
  @HttpCode(200)
  @RequiresFeatures()
  expense(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ ...entry, description: z.string().trim().min(2).max(500) })))
    b: EntryInput,
  ) {
    return this.imprest.expense(c, id, b);
  }

  @Post('imprests/:id/settle')
  @HttpCode(200)
  @RequiresFeatures()
  settle(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ date: z.iso.date() }))) b: { date: string },
  ) {
    return this.imprest.settle(c, id, b);
  }

  @Post('imprests/:id/take-back')
  @HttpCode(200)
  @RequiresFeatures()
  takeBack(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          date: z.iso.date(),
          amount: amount.default('0'),
          accountId: z.uuid().default('00000000-0000-0000-0000-000000000000'),
          description: z.string().trim().max(500).default(''),
          reference: z.string().trim().max(100).default(''),
          close: z.boolean().default(false),
        }),
      ),
    )
    b: EntryInput & { close: boolean },
  ) {
    return this.imprest.takeBack(c, id, b);
  }
}
