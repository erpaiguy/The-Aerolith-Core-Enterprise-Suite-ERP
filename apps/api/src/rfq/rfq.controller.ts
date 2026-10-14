import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { day, money, text } from '../tender/tender.controller.js';
import { RfqService } from './rfq.service.js';

/** A rate or quantity: a decimal string with up to 4 places, never negative. */
const decimal4 = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v).replace(/,/g, ''))
  .refine((v) => /^\d{1,16}(\.\d{1,4})?$/.test(v), {
    message: 'Up to 4 decimal places, not negative',
  });
const rowVersion = z.number().int().positive();
const QUOTE_MAX_BYTES = 5 * 1024 * 1024;

const rfqCreate = z.object({
  title: z.string().trim().min(3).max(200),
  kind: z.enum(['work', 'material']),
  dueOn: day.default(null),
  terms: z.string().trim().max(8000).default(''),
});
const rfqUpdate = z.object({
  rowVersion,
  title: z.string().trim().min(3).max(200).optional(),
  dueOn: day.optional(),
  terms: z.string().trim().max(8000).optional(),
  status: z.enum(['draft', 'sent', 'closed', 'cancelled']).optional(),
});
const linesAdd = z
  .object({
    boqId: z.uuid().optional(),
    nodeIds: z.array(z.string().regex(/^\d+$/)).max(5000).optional(),
    resourceIds: z.array(z.uuid()).max(2000).optional(),
    requisitionIds: z.array(z.uuid()).max(100).optional(),
    free: z
      .object({
        code: text(40).default(null),
        description: z.string().trim().min(1).max(4000),
        unit: text(20).default(null),
        qty: decimal4.nullable().default(null),
      })
      .optional(),
  })
  .refine(
    (b) =>
      (b.boqId && b.nodeIds?.length) || b.resourceIds?.length || b.requisitionIds?.length || b.free,
    'Nothing to add',
  );
const lineUpdate = z.object({
  code: text(40).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  unit: text(20).optional(),
  qty: decimal4.nullable().optional(),
});
const vendorAdd = z
  .object({
    partyId: z.uuid().nullable().default(null),
    name: text(200).default(null),
    email: z
      .email()
      .max(254)
      .nullable()
      .or(z.literal('').transform(() => null))
      .default(null),
    phone: text(40).default(null),
  })
  .refine((b) => b.partyId || b.name, 'Choose or name the vendor');
const vendorUpdate = z.object({
  status: z.enum(['invited', 'sent', 'quoted', 'declined']).optional(),
  sentOn: day.optional(),
  notes: z.string().trim().max(1000).optional(),
});
const quoteBody = z.object({
  receivedOn: z.iso.date(),
  validUntil: day.default(null),
  reference: text(100).default(null),
  gstMode: z.enum(['extra', 'included', 'exempt']).default('extra'),
  gstPct: money.refine((v) => v !== null && Number(v) <= 100, 'A percentage').default('18'),
  terms: z.string().trim().max(4000).default(''),
  lines: z
    .array(
      z.object({
        lineId: z.uuid(),
        rate: decimal4,
        remark: z.string().trim().max(1000).default(''),
      }),
    )
    .max(2000),
  newRound: z.boolean().default(true),
});
const importQuery = z.object({ partyId: z.uuid().optional() });
const selectBody = z
  .object({
    lines: z
      .array(
        z.object({
          lineId: z.uuid(),
          partyId: z.uuid().nullable(),
          note: z.string().trim().max(1000).default(''),
        }),
      )
      .max(2000)
      .optional(),
    award: z.uuid().optional(),
    lowest: z.boolean().optional(),
  })
  .refine((b) => b.lines || b.award || b.lowest, 'Say what to choose');

type Claims = TenantClaims;

/**
 * RFQs (docs/wave1-plan.md step 9). Everyone may read; changes need `rfq.edit`. Putting chosen rates into the
 * estimate also needs `boq.edit` (BOQ items) or `rates.edit` (resources), checked by the service.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class RfqController {
  constructor(
    private readonly rfqs: RfqService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('rfqs')
  listAll(
    @Auth() c: Claims,
    @Query(
      new ZodPipe(
        z.object({
          status: z.enum(['open', 'all', 'draft', 'sent', 'closed', 'cancelled']).default('open'),
          source: z.enum(['all', 'tender', 'project']).default('all'),
        }),
      ),
    )
    q: { status: string; source: 'all' | 'tender' | 'project' },
  ) {
    return this.rfqs.listAll(c, q);
  }

  @Get('tenders/:id/rfqs')
  list(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.list(c, id);
  }

  @Post('tenders/:id/rfqs')
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  create(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rfqCreate)) b: z.infer<typeof rfqCreate>,
  ) {
    return this.rfqs.create(c, id, b);
  }

  @Get('rfqs/:id')
  get(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.get(c, id);
  }

  @Post('rfqs/:id')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  update(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rfqUpdate)) b: z.infer<typeof rfqUpdate>,
  ) {
    const { rowVersion: v, ...patch } = b;
    return this.rfqs.update(c, id, v, patch);
  }

  @Post('rfqs/:id/lines')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  addLines(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(linesAdd)) b: z.infer<typeof linesAdd>,
  ) {
    return this.rfqs.addLines(c, id, b);
  }

  @Post('rfq-lines/:id')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  updateLine(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(lineUpdate)) b: z.infer<typeof lineUpdate>,
  ) {
    return this.rfqs.updateLine(c, id, b);
  }

  @Post('rfq-lines/:id/delete')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  deleteLine(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.deleteLine(c, id);
  }

  @Post('rfqs/:id/vendors')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  addVendor(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(vendorAdd)) b: z.infer<typeof vendorAdd>,
  ) {
    return this.rfqs.addVendor(c, id, b);
  }

  @Post('rfqs/:id/vendors/:partyId')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  updateVendor(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Body(new ZodPipe(vendorUpdate)) b: z.infer<typeof vendorUpdate>,
  ) {
    return this.rfqs.updateVendor(c, id, partyId, b);
  }

  @Post('rfqs/:id/vendors/:partyId/delete')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  removeVendor(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partyId', ParseUUIDPipe) partyId: string,
  ) {
    return this.rfqs.removeVendor(c, id, partyId);
  }

  /** The enquiry workbook for one vendor, to send from your own email. */
  @Get('rfqs/:id/vendors/:partyId/pack')
  @RequiresPermission('rfq.edit')
  async pack(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partyId', ParseUUIDPipe) partyId: string,
  ) {
    const out = await this.rfqs.pack(c, id, partyId);
    return new StreamableFile(Readable.from(out.buffer), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(out.fileName),
    });
  }

  @Post('rfqs/:id/vendors/:partyId/quote')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  saveQuote(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Body(new ZodPipe(quoteBody)) b: z.infer<typeof quoteBody>,
  ) {
    return this.rfqs.saveQuote(c, id, partyId, { ...b, gstPct: b.gstPct! });
  }

  /** multipart/form-data, field `file`: the vendor's filled enquiry workbook. */
  @Post('rfqs/:id/quotes/import')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  async importQuote(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(importQuery)) q: z.infer<typeof importQuery>,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the file as form data.',
      });
    const limit = Math.min(this.config.importMaxBytes, QUOTE_MAX_BYTES);
    const file = await req.file({ limits: { fileSize: limit, files: 1 } });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
    const buffer = await file.toBuffer().catch(() => null);
    if (!buffer || file.file.truncated)
      throw new BadRequestException({
        code: 'file_too_large',
        message: 'A quote workbook is at most 5 MB.',
      });
    return this.rfqs.importQuote(c, id, q.partyId ?? null, { name: file.filename, buffer });
  }

  @Post('rfqs/:id/select')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  select(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(selectBody)) b: z.infer<typeof selectBody>,
  ) {
    return this.rfqs.select(c, id, b);
  }

  @Post('rfqs/:id/apply')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  apply(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.apply(c, id);
  }
}
