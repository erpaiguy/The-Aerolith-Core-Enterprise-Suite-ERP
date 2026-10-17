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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { KYC_KINDS, KYC_MAX, VendorMasterService } from './vendor-master.service.js';
import { VENDOR_STATUSES } from './vendor-rules.js';

const categoryKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const docMeta = z.object({
  kind: z.enum(KYC_KINDS),
  number: z.string().trim().max(100).default(''),
  validUntil: z.iso.date().nullable().default(null),
  note: z.string().trim().max(500).default(''),
});

/** The vendor master (docs/wave8-plan.md step 8e.1). Changes need `purchase.edit`, checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class VendorMasterController {
  constructor(private readonly vendors: VendorMasterService) {}

  @Get('trade-categories')
  categories(@Auth() c: TenantClaims) {
    return this.vendors.categories(c);
  }

  @Post('trade-categories')
  @HttpCode(200)
  @RequiresFeatures()
  addCategory(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({
          key: categoryKey,
          name: z.string().trim().min(2).max(80),
          kind: z.enum(['material', 'work', 'service']),
        }),
      ),
    )
    b: { key: string; name: string; kind: 'material' | 'work' | 'service' },
  ) {
    return this.vendors.addCategory(c, b);
  }

  @Get('vendor-policy')
  policy(@Auth() c: TenantClaims) {
    return this.vendors.policy(c);
  }

  @Post('vendor-policy')
  @HttpCode(200)
  @RequiresFeatures()
  setPolicy(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ approvedOnly: z.boolean() }))) b: { approvedOnly: boolean },
  ) {
    return this.vendors.setPolicy(c, b.approvedOnly);
  }

  @Get('vendors')
  list(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({ category: categoryKey.optional(), status: z.enum(VENDOR_STATUSES).optional() }),
      ),
    )
    q: { category?: string; status?: (typeof VENDOR_STATUSES)[number] },
  ) {
    return this.vendors.vendors(c, q);
  }

  @Get('vendors/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.vendor(c, id);
  }

  @Post('vendors/:id/categories')
  @HttpCode(200)
  @RequiresFeatures()
  setCategories(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ categories: z.array(categoryKey).max(40) })))
    b: { categories: string[] },
  ) {
    return this.vendors.setCategories(c, id, b.categories);
  }

  @Post('vendors/:id/status')
  @HttpCode(200)
  @RequiresFeatures()
  setStatus(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          status: z.enum(VENDOR_STATUSES),
          reason: z.string().trim().max(1000).default(''),
        }),
      ),
    )
    b: { status: (typeof VENDOR_STATUSES)[number]; reason: string },
  ) {
    return this.vendors.setStatus(c, id, b);
  }

  /** A KYC document: JSON with no scan, or multipart/form-data with the scan in `file` and the rest in the query. */
  @Post('vendors/:id/documents')
  @HttpCode(200)
  @RequiresFeatures()
  async addDocument(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart()) {
      const b = new ZodPipe(docMeta).transform(req.body ?? {}) as z.infer<typeof docMeta>;
      return this.vendors.addDocument(c, id, b, null);
    }
    const q = new ZodPipe(docMeta).transform(req.query ?? {}) as z.infer<typeof docMeta>;
    const file = await req.file({
      limits: { fileSize: KYC_MAX + 1, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No document was sent.' });
    return this.vendors.addDocument(c, id, q, {
      stream: file.file,
      truncated: () => file.file.truncated,
      name: file.filename,
    });
  }

  @Post('vendor-documents/:id/remove')
  @HttpCode(200)
  @RequiresFeatures()
  removeDocument(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.removeDocument(c, id);
  }

  @Get('vendor-documents/:id/file')
  async file(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.vendors.documentFile(c, id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    reply.header(
      'Content-Disposition',
      `inline; filename="${f.name.replace(/[^A-Za-z0-9._ -]/g, '_')}"`,
    );
    return new StreamableFile(f.stream, { type: f.mime, length: f.size });
  }

  @Post('rfqs/:id/category')
  @HttpCode(200)
  @RequiresFeatures()
  rfqCategory(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ category: categoryKey.nullable() })))
    b: { category: string | null },
  ) {
    return this.vendors.setRfqCategory(c, id, b.category);
  }
}
