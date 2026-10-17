import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SOR_MAX, SorService } from './sor.service.js';

const rate = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,16}(\.\d{1,4})?$/.test(v), { message: 'A rate, up to 4 decimals' });
const pct = z
  .string()
  .trim()
  .regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'A percentage, e.g. -4.5');

/** Schedule-of-rates tendering (docs/wave8-plan.md step 8f.2). */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class SorController {
  constructor(private readonly sor: SorService) {}

  @Get('sor-books')
  books(@Auth() c: TenantClaims) {
    return this.sor.books(c);
  }

  @Post('sor-books')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  addBook(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({
          name: z.string().trim().min(2).max(120),
          issuer: z.string().trim().min(2).max(120),
          stateCode: z
            .string()
            .regex(/^\d{2}$/)
            .nullable()
            .default(null),
          edition: z.string().trim().max(40).default(''),
        }),
      ),
    )
    b: { name: string; issuer: string; stateCode: string | null; edition: string },
  ) {
    return this.sor.addBook(c, b);
  }

  /** multipart/form-data, field `file`: the schedule as an .xlsx with Code, Description, Unit and Rate columns. */
  @Post('sor-books/:id/import')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  async import(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the file as form data.',
      });
    const file = await req.file({
      limits: { fileSize: SOR_MAX + 1, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
    const buffer = await file.toBuffer();
    if (file.file.truncated)
      throw new BadRequestException({ code: 'too_large', message: 'The schedule is over 10 MB.' });
    return this.sor.importItems(c, id, buffer);
  }

  @Get('sor-items')
  search(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({ q: z.string().trim().max(100).optional(), bookId: z.uuid().optional() }),
      ),
    )
    q: { q?: string; bookId?: string },
  ) {
    return this.sor.search(c, q);
  }

  @Get('boqs/:id/sor')
  citations(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.sor.citations(c, id);
  }

  @Post('boqs/:id/lines/:lineId/sor')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  cite(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', new ZodPipe(z.string().regex(/^\d{1,19}$/))) lineId: string,
    @Body(new ZodPipe(z.object({ sorItemId: z.uuid().nullable() })))
    b: { sorItemId: string | null },
  ) {
    return this.sor.cite(c, id, lineId, b.sorItemId);
  }

  @Post('boqs/:id/sor/apply')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  apply(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.sor.applyRates(c, id);
  }

  @Get('tenders/:id/rate-mode')
  getMode(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.sor.mode(c, id);
  }

  @Post('tenders/:id/rate-mode')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  mode(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          rateMode: z.enum(['item_rate', 'percentage']),
          quotedPct: pct.nullable().default(null),
        }),
      ),
    )
    b: { rateMode: 'item_rate' | 'percentage'; quotedPct: string | null },
  ) {
    return this.sor.setMode(c, id, b);
  }

  @Get('tenders/:id/item-comparative')
  comparative(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.sor.comparative(c, id);
  }

  @Post('tenders/:id/item-bids')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  itemBids(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          partyId: z.uuid().nullable().default(null),
          rates: z.array(z.object({ lineKey: z.uuid(), rate })).max(20000),
        }),
      ),
    )
    b: { partyId: string | null; rates: { lineKey: string; rate: string }[] },
  ) {
    return this.sor.setItemBids(c, id, b.partyId, b.rates);
  }

  @Get('tenders/percentage-history')
  history(@Auth() c: TenantClaims) {
    return this.sor.percentageHistory(c);
  }
}
