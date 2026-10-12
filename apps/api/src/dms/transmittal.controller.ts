import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { RateLimit } from '../auth/rate-limit.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { RfiService } from './rfi.service.js';
import { TransmittalService } from './transmittal.service.js';

const transmittal = z.object({
  subject: z.string().trim().min(3).max(300),
  partyId: z.uuid().nullable().default(null),
  recipient: z.string().trim().min(2).max(200),
  email: z.email().max(254).nullable().default(null),
  purpose: z.enum(['information', 'review', 'construction', 'record']),
  responseDays: z.number().int().min(1).max(90).nullable().default(null),
  notes: z.string().trim().max(2000).default(''),
  items: z
    .array(
      z.object({
        documentId: z.uuid(),
        versionNo: z.number().int().positive().nullable().default(null),
        copies: z.number().int().min(0).max(100).default(1),
        remark: z.string().trim().max(300).default(''),
      }),
    )
    .max(200),
});
const name = z.string().trim().min(2).max(120);
const staffResponse = z.object({
  by: name,
  response: z.string().trim().min(1).max(4000),
  code: z.string().min(1).max(4).nullable().default(null),
  documentId: z.uuid().nullable().default(null),
});
const rfi = z.object({
  subject: z.string().trim().min(3).max(300),
  question: z.string().trim().min(3).max(4000),
  documentId: z.uuid().nullable().default(null),
  versionNo: z.number().int().positive().nullable().default(null),
  location: z.string().trim().max(200).default(''),
  reference: z.string().trim().max(200).default(''),
  assignedTo: z.uuid(),
  dueDays: z.number().int().min(0).max(90).default(7),
});
const answer = z.object({
  answer: z.string().trim().min(1).max(4000),
  documentId: z.uuid().nullable().default(null),
});
const outcome = z.object({
  outcome: z.enum(['none', 'variation', 'revision']),
  variationId: z.uuid().nullable().default(null),
  documentId: z.uuid().nullable().default(null),
  versionNo: z.number().int().positive().nullable().default(null),
  close: z.boolean().default(false),
});
const submittal = z.object({
  kind: z.enum(['shop_drawing', 'method_statement', 'material', 'sample', 'other']),
  title: z.string().trim().min(3).max(300),
  documentId: z.uuid(),
  versionNo: z.number().int().positive().nullable().default(null),
  workflowId: z.uuid(),
  materialApprovalId: z.uuid().nullable().default(null),
});

function fileHeaders(reply: FastifyReply) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
  reply.header('Cache-Control', 'private, no-store');
}

/** Transmittals, RFIs and submittals (docs/wave5-plan.md step 3), for the project's people. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class TransmittalController {
  constructor(
    private readonly transmittals: TransmittalService,
    private readonly rfis: RfiService,
  ) {}

  @Get('projects/:id/transmittals')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.transmittals.list(c, id);
  }

  @Post('projects/:id/transmittals')
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(transmittal)) b: z.infer<typeof transmittal>,
  ) {
    return this.transmittals.save(c, id, null, b);
  }

  @Get('transmittals/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.transmittals.get(c, id);
  }

  @Post('projects/:pid/transmittals/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('pid', ParseUUIDPipe) pid: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(transmittal)) b: z.infer<typeof transmittal>,
  ) {
    return this.transmittals.save(c, pid, id, b);
  }

  @Post('transmittals/:id/issue')
  @HttpCode(200)
  @RequiresFeatures()
  issue(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.transmittals.issue(c, id);
  }

  /** A new link for the recipient; the token is returned this once. */
  @Post('transmittals/:id/link')
  @HttpCode(200)
  @RequiresFeatures()
  link(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ days: z.number().int().min(1).max(60).default(14) })))
    b: { days: number },
  ) {
    return this.transmittals.makeLink(c, id, b.days);
  }

  @Post('transmittals/:id/link/revoke')
  @HttpCode(200)
  @RequiresFeatures()
  revoke(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.transmittals.revokeLinks(c, id);
  }

  @Post('transmittals/:id/acknowledge')
  @HttpCode(200)
  @RequiresFeatures()
  acknowledge(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ by: name }))) b: { by: string },
  ) {
    return this.transmittals.acknowledge(c, id, b.by);
  }

  @Post('transmittals/:id/respond')
  @HttpCode(200)
  @RequiresFeatures()
  respond(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(staffResponse)) b: z.infer<typeof staffResponse>,
  ) {
    return this.transmittals.respond(c, id, b);
  }

  @Post('transmittals/:id/close')
  @HttpCode(200)
  @RequiresFeatures()
  close(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.transmittals.close(c, id);
  }

  @Get('projects/:id/rfis')
  rfiList(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.rfis.rfis(c, id);
  }

  @Post('projects/:id/rfis')
  @RequiresFeatures()
  raise(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rfi)) b: z.infer<typeof rfi>,
  ) {
    return this.rfis.raise(c, id, b);
  }

  @Post('rfis/:id/answer')
  @HttpCode(200)
  @RequiresFeatures()
  answer(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(answer)) b: z.infer<typeof answer>,
  ) {
    return this.rfis.answer(c, id, b);
  }

  @Post('rfis/:id/outcome')
  @HttpCode(200)
  @RequiresFeatures()
  outcome(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(outcome)) b: z.infer<typeof outcome>,
  ) {
    return this.rfis.outcome(c, id, b);
  }

  @Get('projects/:id/submittals')
  submittals(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.rfis.submittals(c, id);
  }

  @Post('projects/:id/submittals')
  @RequiresFeatures()
  submit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(submittal)) b: z.infer<typeof submittal>,
  ) {
    return this.rfis.submit(c, id, b);
  }
}

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Not a link token');

/**
 * The recipient's link: no account, only the token in the path (docs/wave5-plan.md step 3). Rate limited per IP;
 * the service refuses unknown, expired and withdrawn links, and tenants whose licence has lapsed.
 */
@Controller('share')
@RateLimit(60)
export class ShareController {
  constructor(private readonly transmittals: TransmittalService) {}

  @Get(':tenant/:token')
  view(
    @Param('tenant', ParseUUIDPipe) tenant: string,
    @Param('token', new ZodPipe(token)) t: string,
    @Req() req: FastifyRequest,
  ) {
    return this.transmittals.publicView(tenant, t, req.ip);
  }

  @Get(':tenant/:token/items/:item')
  async file(
    @Param('tenant', ParseUUIDPipe) tenant: string,
    @Param('token', new ZodPipe(token)) t: string,
    @Param('item', ParseUUIDPipe) item: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.transmittals.publicFile(tenant, t, item, req.ip);
    fileHeaders(reply);
    return new StreamableFile(f.stream, {
      type: f.mime,
      length: f.size,
      disposition: attachment(f.fileName),
    });
  }

  @Post(':tenant/:token/acknowledge')
  @HttpCode(200)
  @RateLimit(10)
  acknowledge(
    @Param('tenant', ParseUUIDPipe) tenant: string,
    @Param('token', new ZodPipe(token)) t: string,
    @Body(new ZodPipe(z.object({ name }))) b: { name: string },
    @Req() req: FastifyRequest,
  ) {
    return this.transmittals.publicAcknowledge(tenant, t, b.name, req.ip);
  }

  /** Form data: the fields name, response and code (optional), then at most one file. */
  @Post(':tenant/:token/respond')
  @HttpCode(200)
  @RateLimit(10)
  async respond(
    @Param('tenant', ParseUUIDPipe) tenant: string,
    @Param('token', new ZodPipe(token)) t: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the form as form data.',
      });
    const fields: Record<string, string> = {};
    let result: Awaited<ReturnType<TransmittalService['publicRespond']>> | null = null;
    const input = () => {
      const parsed = z
        .object({
          name,
          response: z.string().trim().min(1).max(4000),
          code: z
            .string()
            .max(4)
            .transform((s) => s || null)
            .nullable()
            .default(null),
        })
        .safeParse(fields);
      if (!parsed.success)
        throw new BadRequestException({
          code: 'invalid',
          message: 'Your name and your response are needed.',
        });
      return parsed.data;
    };
    for await (const part of req.parts({
      limits: { fileSize: 25 * 1024 * 1024 + 1, files: 1, fields: 3, fieldSize: 8000 },
    })) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      const stream: Readable & { truncated?: boolean } = part.file;
      result = await this.transmittals.publicRespond(
        tenant,
        t,
        input(),
        { name: part.filename, stream, truncated: () => !!stream.truncated },
        req.ip,
      );
    }
    return result ?? this.transmittals.publicRespond(tenant, t, input(), null, req.ip);
  }
}
