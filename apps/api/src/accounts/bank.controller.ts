import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Mapping } from './bank-parse.js';
import { BankService } from './bank.service.js';

const date = z.iso.date();
const heading = z.string().trim().min(1).max(100);
const mapping = z
  .object({
    date: heading,
    narration: heading,
    reference: heading.nullable().default(null),
    withdrawal: heading.nullable().default(null),
    deposit: heading.nullable().default(null),
    amount: heading.nullable().default(null),
    balance: heading.nullable().default(null),
    dateFormat: z.enum(['DD/MM/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY']),
  })
  .refine((m) => m.amount !== null || (m.withdrawal !== null && m.deposit !== null), {
    message: 'Map either withdrawal and deposit columns, or one amount column',
  });
const picks = z
  .array(z.object({ voucherId: z.uuid(), position: z.number().int().positive() }))
  .min(1)
  .max(200);

/** Bank reconciliation (docs/wave3-plan.md step 7). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class BankController {
  constructor(private readonly bank: BankService) {}

  @Get('accounts/bank/:accountId/mapping')
  mapping(@Auth() c: TenantClaims, @Param('accountId', ParseUUIDPipe) id: string) {
    return this.bank.mapping(c, id);
  }

  @Put('accounts/bank/:accountId/mapping')
  @RequiresFeatures()
  setMapping(
    @Auth() c: TenantClaims,
    @Param('accountId', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(mapping)) b: Mapping,
  ) {
    return this.bank.setMapping(c, id, b);
  }

  /** multipart/form-data, field `file`: the statement (CSV, Excel, OFX or MT940). */
  @Post('accounts/bank/:accountId/statements')
  @HttpCode(200)
  @RequiresFeatures()
  async import(
    @Auth() c: TenantClaims,
    @Param('accountId', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the statement as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    });
    if (!file)
      throw new BadRequestException({ code: 'no_file', message: 'No statement was sent.' });
    return this.bank.import(c, id, { fileName: file.filename, buf: await file.toBuffer() });
  }

  @Get('accounts/bank/:accountId/statement')
  statement(
    @Auth() c: TenantClaims,
    @Param('accountId', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: date, to: date })))
    q: { entityId: string; from: string; to: string },
  ) {
    return this.bank.statement(c, { ...q, accountId: id });
  }

  @Get('accounts/bank/:accountId/reconciliation')
  reconciliation(
    @Auth() c: TenantClaims,
    @Param('accountId', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), asOf: date })))
    q: { entityId: string; asOf: string },
  ) {
    return this.bank.reconciliation(c, { ...q, accountId: id });
  }

  @Post('accounts/bank-lines/:id/match')
  @HttpCode(200)
  @RequiresFeatures()
  match(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ entityId: z.uuid(), lines: picks })))
    b: { entityId: string; lines: { voucherId: string; position: number }[] },
  ) {
    return this.bank.match(c, id, b);
  }

  @Post('accounts/bank-lines/:id/post')
  @HttpCode(200)
  @RequiresFeatures()
  post(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          entityId: z.uuid(),
          accountId: z.uuid(),
          narration: z.string().trim().min(2).max(500),
        }),
      ),
    )
    b: { entityId: string; accountId: string; narration: string },
  ) {
    return this.bank.post(c, id, b);
  }

  @Post('accounts/bank-matches/:id/undo')
  @HttpCode(200)
  @RequiresFeatures()
  undo(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ reason: z.string().trim().min(3).max(500) })))
    b: { reason: string },
  ) {
    return this.bank.undo(c, id, b.reason);
  }
}
