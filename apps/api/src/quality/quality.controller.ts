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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { Idempotent } from '../common/idempotency.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { QualityService } from './quality.service.js';

const date = z.iso.date();
const text = (max: number) => z.string().trim().max(max);
const kind = z.enum(['cube', 'slump', 'steel', 'soil', 'brick']);
const item = z.object({
  text: z.string().trim().min(2).max(300),
  kind: z.enum(['yes_no', 'number', 'note']),
  required: z.boolean().default(true),
  min: z.number().optional(),
  max: z.number().optional(),
});

/** Quality (docs/wave3-plan.md step 14). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  @Get('projects/:id/quality')
  register(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.quality.register(c, id);
  }

  @Put('projects/:id/quality/hold')
  @RequiresFeatures()
  setHold(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ hold: z.boolean() }))) b: { hold: boolean },
  ) {
    return this.quality.setHold(c, id, b.hold);
  }

  @Post('projects/:id/inspections')
  @HttpCode(200)
  @RequiresFeatures()
  requestInspection(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          lineKey: z.uuid(),
          siteId: z.uuid().nullable().default(null),
          location: text(300).default(''),
          activity: text(300).default(''),
          requestedFor: date,
        }),
      ),
    )
    b: {
      lineKey: string;
      siteId: string | null;
      location: string;
      activity: string;
      requestedFor: string;
    },
  ) {
    return this.quality.requestInspection(c, id, b);
  }

  @Get('inspections/:id')
  inspection(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.quality.inspection(c, id);
  }

  @Post('inspections/:id/decide')
  @HttpCode(200)
  @RequiresFeatures()
  decide(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          status: z.enum(['approved', 'approved_with_comments', 'rejected']),
          inspector: text(120).min(2),
          comments: text(2000).default(''),
          decidedOn: date,
        }),
      ),
    )
    b: {
      status: 'approved' | 'approved_with_comments' | 'rejected';
      inspector: string;
      comments: string;
      decidedOn: string;
    },
  ) {
    return this.quality.decideInspection(c, id, b);
  }

  @Get('quality/checklist-templates')
  templates(@Auth() c: TenantClaims) {
    return this.quality.templates(c);
  }

  @Post('quality/checklist-templates')
  @HttpCode(200)
  @RequiresFeatures()
  addTemplate(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({
          name: z.string().trim().min(2).max(120),
          workType: text(60).default(''),
          items: z.array(item).min(1).max(200),
        }),
      ),
    )
    b: { name: string; workType: string; items: z.infer<typeof item>[] },
  ) {
    return this.quality.addTemplate(c, b as never);
  }

  @Post('projects/:id/checklists')
  @Idempotent()
  @HttpCode(200)
  @RequiresFeatures()
  fill(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          templateId: z.uuid(),
          siteId: z.uuid().nullable().default(null),
          inspectionId: z.uuid().nullable().default(null),
          doneOn: date,
          location: text(300).default(''),
          answers: z
            .array(
              z.object({
                answer: z.union([z.string().max(200), z.number(), z.null()]),
                note: text(300).default(''),
              }),
            )
            .max(200),
        }),
      ),
    )
    b: {
      templateId: string;
      siteId: string | null;
      inspectionId: string | null;
      doneOn: string;
      location: string;
      answers: { answer: unknown; note: string }[];
    },
  ) {
    return this.quality.fillChecklist(c, id, b);
  }

  @Get('checklists/:id')
  checklist(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.quality.checklist(c, id);
  }

  /** multipart/form-data, field `file`: a photo of a checklist (`?checklistId`) or a snag (`?snagId`). */
  @Post('quality/photos')
  @HttpCode(200)
  @RequiresFeatures()
  async addPhoto(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z
          .object({
            checklistId: z.uuid().optional(),
            snagId: z.uuid().optional(),
            caption: text(200).default(''),
          })
          .refine((q) => Boolean(q.checklistId) !== Boolean(q.snagId), {
            message: 'A checklist or a snag',
          }),
      ),
    )
    q: { checklistId?: string; snagId?: string; caption: string },
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the photo as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 8 * 1024 * 1024 + 1, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No photo was sent.' });
    return this.quality.addPhoto(
      c,
      q.checklistId ? { checklistId: q.checklistId } : { snagId: q.snagId! },
      q.caption,
      { stream: file.file, truncated: () => file.file.truncated },
    );
  }

  @Get('quality/photos/:id')
  async photo(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.quality.photo(c, id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    return new StreamableFile(p.stream, { type: p.mime, length: p.size });
  }

  @Get('quality/test-criteria')
  criteria(@Auth() c: TenantClaims) {
    return this.quality.criteria(c);
  }

  @Post('quality/test-criteria')
  @HttpCode(200)
  @RequiresFeatures()
  addCriteria(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({
          kind,
          effectiveFrom: date,
          data: z.record(z.string(), z.unknown()),
          note: text(300).default(''),
        }),
      ),
    )
    b: {
      kind: z.infer<typeof kind>;
      effectiveFrom: string;
      data: Record<string, unknown>;
      note: string;
    },
  ) {
    return this.quality.addCriteria(c, b);
  }

  @Post('projects/:id/tests')
  @HttpCode(200)
  @RequiresFeatures()
  recordTest(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          kind,
          sampleRef: text(60).default(''),
          location: text(300).default(''),
          sampledOn: date,
          testedOn: date,
          spec: z.record(z.string(), z.unknown()),
          results: z.record(z.string(), z.unknown()),
        }),
      ),
    )
    b: {
      kind: z.infer<typeof kind>;
      sampleRef: string;
      location: string;
      sampledOn: string;
      testedOn: string;
      spec: Record<string, unknown>;
      results: Record<string, unknown>;
    },
  ) {
    return this.quality.recordTest(c, id, b);
  }

  @Post('projects/:id/ncrs')
  @HttpCode(200)
  @RequiresFeatures()
  raiseNcr(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          description: z.string().trim().min(3).max(2000),
          responsible: text(120).default(''),
          dueOn: date.nullable().default(null),
        }),
      ),
    )
    b: { description: string; responsible: string; dueOn: string | null },
  ) {
    return this.quality.raiseNcr(c, id, b);
  }

  @Get('ncrs/:id')
  ncr(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.quality.ncr(c, id);
  }

  @Put('ncrs/:id')
  @RequiresFeatures()
  actOnNcr(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          rootCause: text(2000).default(''),
          correctiveAction: text(2000).default(''),
          responsible: text(120).default(''),
          dueOn: date.nullable().default(null),
          done: z.boolean().default(false),
          rowVersion: z.number().int(),
        }),
      ),
    )
    b: {
      rootCause: string;
      correctiveAction: string;
      responsible: string;
      dueOn: string | null;
      done: boolean;
      rowVersion: number;
    },
  ) {
    return this.quality.actOnNcr(c, id, b);
  }

  @Post('ncrs/:id/close')
  @HttpCode(200)
  @RequiresFeatures()
  closeNcr(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(z.object({ note: text(2000).default(''), reopen: z.boolean().default(false) })),
    )
    b: { note: string; reopen: boolean },
  ) {
    return this.quality.closeNcr(c, id, b);
  }

  @Post('projects/:id/snags')
  @HttpCode(200)
  @RequiresFeatures()
  addSnag(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          area: z.string().trim().min(1).max(120),
          description: z.string().trim().min(3).max(1000),
          responsiblePartyId: z.uuid().nullable().default(null),
          dueOn: z.iso.date().nullable().default(null),
          backcharge: z
            .string()
            .trim()
            .regex(/^\d{1,12}(\.\d{1,2})?$/)
            .refine((v) => Number(v) > 0, { message: 'More than nothing' })
            .nullable()
            .default(null),
        }),
      ),
    )
    b: {
      area: string;
      description: string;
      responsiblePartyId: string | null;
      dueOn: string | null;
      backcharge: string | null;
    },
  ) {
    return this.quality.addSnag(c, id, b);
  }

  @Put('snags/:id')
  @RequiresFeatures()
  setSnag(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({ status: z.enum(['open', 'fixed', 'closed']), rowVersion: z.number().int() }),
      ),
    )
    b: { status: 'open' | 'fixed' | 'closed'; rowVersion: number },
  ) {
    return this.quality.setSnag(c, id, b);
  }

  @Put('projects/:id/make-required/:resourceId')
  @RequiresFeatures()
  requireMake(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Body(new ZodPipe(z.object({ required: z.boolean() }))) b: { required: boolean },
  ) {
    return this.quality.requireMake(c, id, resourceId, b.required);
  }

  @Post('projects/:id/material-approvals')
  @HttpCode(200)
  @RequiresFeatures()
  submitMake(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          resourceId: z.uuid(),
          make: z.string().trim().min(2).max(120),
          sampleRef: text(60).default(''),
        }),
      ),
    )
    b: { resourceId: string; make: string; sampleRef: string },
  ) {
    return this.quality.submitMake(c, id, b);
  }

  @Post('material-approvals/:id/decide')
  @HttpCode(200)
  @RequiresFeatures()
  decideMake(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({ status: z.enum(['approved', 'rejected']), comments: text(1000).default('') }),
      ),
    )
    b: { status: 'approved' | 'rejected'; comments: string },
  ) {
    return this.quality.decideMake(c, id, b);
  }
}
