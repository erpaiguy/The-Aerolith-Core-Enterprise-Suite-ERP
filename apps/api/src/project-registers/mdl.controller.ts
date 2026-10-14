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
import { type ExpectedInput, MdlService } from './mdl.service.js';

const CATEGORIES = [
  'drawing',
  'specification',
  'approval',
  'method_statement',
  'test_certificate',
  'report',
  'other',
] as const;

/** A project's master document list (docs/wave7-plan.md step 7d.3). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class MdlController {
  constructor(private readonly mdl: MdlService) {}

  @Get('projects/:id/expected-documents')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.mdl.list(c, id);
  }

  @Post('projects/:id/expected-documents')
  @HttpCode(200)
  @RequiresFeatures()
  add(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          items: z
            .array(
              z.object({
                code: z.string().trim().min(1).max(60),
                title: z.string().trim().min(2).max(300),
                category: z.enum(CATEGORIES).default('drawing'),
                fromParty: z.string().trim().max(200).default(''),
                plannedOn: z.iso.date(),
              }),
            )
            .min(1)
            .max(1000),
        }),
      ),
    )
    b: { items: ExpectedInput[] },
  ) {
    return this.mdl.add(c, id, b.items);
  }

  @Post('expected-documents/:id/received')
  @HttpCode(200)
  @RequiresFeatures()
  receive(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          receivedOn: z.iso.date(),
          documentId: z.uuid().nullable().default(null),
          note: z.string().trim().max(1000).default(''),
        }),
      ),
    )
    b: { receivedOn: string; documentId: string | null; note: string },
  ) {
    return this.mdl.receive(c, id, b);
  }
}
