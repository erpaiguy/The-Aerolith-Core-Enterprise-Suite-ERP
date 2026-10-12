import {
  Body,
  Controller,
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
import { CrmService } from './crm.service.js';

const money = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,2})?$/, 'An amount in rupees')
  .nullable()
  .default(null);
const lead = z.object({
  title: z.string().trim().min(3).max(300),
  partyId: z.uuid().nullable().default(null),
  organisation: z.string().trim().min(2).max(200).nullable().default(null),
  contactId: z.uuid().nullable().default(null),
  source: z
    .enum(['referral', 'repeat_client', 'website', 'cold_call', 'event', 'portal', 'other'])
    .default('other'),
  segment: z
    .enum(['buildings', 'interiors', 'joinery', 'mep', 'real_estate', 'other'])
    .default('buildings'),
  location: z.string().trim().max(200).default(''),
  value: money,
  probability: z.number().int().min(0).max(100).nullable().default(null),
  expectedMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month, YYYY-MM')
    .nullable()
    .default(null),
  ownerId: z.uuid().nullable().default(null),
  notes: z.string().trim().max(4000).default(''),
});
const contact = z.object({
  partyId: z.uuid(),
  name: z.string().trim().min(2).max(120),
  role: z.string().trim().max(120).default(''),
  phone: z.string().trim().max(40).default(''),
  email: z.union([z.email().max(254), z.literal('')]).default(''),
});
const interaction = z.object({
  kind: z.enum(['call', 'meeting', 'site_visit', 'email', 'note']),
  happenedAt: z.coerce.date(),
  summary: z.string().trim().min(1).max(4000),
  contactId: z.uuid().nullable().default(null),
  followUpOn: z.iso.date().nullable().default(null),
  followUp: z.string().trim().max(500).default(''),
});
const stage = z.enum(['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'dropped']);

/** The CRM (docs/wave6-plan.md step 1). Everyone reads; writing needs crm.edit (checked by the service). */
@Controller('tenant/crm')
@UseGuards(TenantAuthGuard)
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('pipeline')
  pipeline(@Auth() c: TenantClaims) {
    return this.crm.pipeline(c);
  }

  @Get('leads')
  list(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({
          stage: z.string().max(20).optional(),
          ownerId: z.uuid().optional(),
        }),
      ),
    )
    q: { stage?: string; ownerId?: string },
  ) {
    return this.crm.list(c, { stage: q.stage ?? null, ownerId: q.ownerId ?? null });
  }

  @Post('leads')
  @RequiresFeatures()
  create(@Auth() c: TenantClaims, @Body(new ZodPipe(lead)) b: z.infer<typeof lead>) {
    return this.crm.create(c, b);
  }

  @Get('leads/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.crm.get(c, id);
  }

  @Post('leads/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(lead.extend({ rowVersion: z.number().int().positive() })))
    b: z.infer<typeof lead> & { rowVersion: number },
  ) {
    const { rowVersion, ...input } = b;
    return this.crm.update(c, id, rowVersion, input);
  }

  @Post('leads/:id/stage')
  @HttpCode(200)
  @RequiresFeatures()
  move(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ stage, reason: z.string().trim().max(1000).default('') })))
    b: { stage: z.infer<typeof stage>; reason: string },
  ) {
    return this.crm.move(c, id, b.stage, b.reason);
  }

  @Post('leads/:id/convert')
  @HttpCode(200)
  @RequiresFeatures()
  convert(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.crm.convert(c, id);
  }

  @Post('leads/:id/interactions')
  @RequiresFeatures()
  interact(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(interaction)) b: z.infer<typeof interaction>,
  ) {
    return this.crm.interact(c, id, b);
  }

  @Post('follow-ups/:id/done')
  @HttpCode(200)
  @RequiresFeatures()
  done(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.crm.followUpDone(c, id);
  }

  @Get('follow-ups')
  followUps(@Auth() c: TenantClaims) {
    return this.crm.followUps(c, false);
  }

  @Get('contacts')
  contacts(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ partyId: z.uuid().optional() }))) q: { partyId?: string },
  ) {
    return this.crm.contacts(c, q.partyId ?? null);
  }

  @Post('contacts')
  @RequiresFeatures()
  addContact(@Auth() c: TenantClaims, @Body(new ZodPipe(contact)) b: z.infer<typeof contact>) {
    return this.crm.addContact(c, b);
  }
}
