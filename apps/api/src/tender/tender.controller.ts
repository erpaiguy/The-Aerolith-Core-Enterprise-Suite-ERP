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
import { RCM_CATEGORIES } from '../accounts/accounts-rules.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TENDER_STATUSES } from './tender-rules.js';
import { TenderService } from './tender.service.js';

// Optional text: trimmed, and an empty string means "clear it".
export const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));
// Money as a decimal string, never a float (docs/05-database.md §1).
export const money = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,18}(\.\d{1,2})?$/.test(v), {
    message: 'Up to 2 decimal places, not negative',
  })
  .nullable();
export const instant = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v))
  .nullable();
export const day = z.iso.date().nullable();

const partyFields = {
  name: z.string().trim().min(2).max(200),
  isClient: z.boolean(),
  isVendor: z.boolean(),
  isSubcontractor: z.boolean(),
  isCompetitor: z.boolean(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      /^[0-9]{2}[A-Z0-9]{13}$/,
      'A GSTIN has 15 characters, starting with the 2-digit state code',
    )
    .nullable()
    .or(z.literal('').transform(() => null)),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN looks like ABCDE1234F')
    .nullable()
    .or(z.literal('').transform(() => null)),
  contactName: text(200),
  email: z
    .email()
    .max(254)
    .nullable()
    .or(z.literal('').transform(() => null)),
  phone: text(40),
  address: text(1000),
  notes: z.string().trim().max(4000),
  // A supplier's default TDS section and bank account (docs/wave3-plan.md step 4).
  tdsSection: z
    .enum(['194C', '194J', '194I', '194Q'])
    .nullable()
    .or(z.literal('').transform(() => null)),
  // Services under GST reverse charge (docs/wave8-plan.md step 8b.1): the supplier's bills default to it.
  rcmCategory: z
    .enum(RCM_CATEGORIES)
    .nullable()
    .or(z.literal('').transform(() => null)),
  // MSME suppliers (docs/wave8-plan.md step 8b.4).
  udyamNo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/, 'A Udyam number: UDYAM-MH-12-0012345')
    .nullable()
    .or(z.literal('').transform(() => null)),
  msmeType: z
    .enum(['micro', 'small', 'medium'])
    .nullable()
    .or(z.literal('').transform(() => null)),
  bankAccountName: text(200),
  bankAccountNo: z
    .string()
    .trim()
    .regex(/^[0-9]{6,20}$/, 'An account number: 6 to 20 digits')
    .nullable()
    .or(z.literal('').transform(() => null)),
  bankIfsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC looks like HDFC0001234')
    .nullable()
    .or(z.literal('').transform(() => null)),
  // What the e-invoice and TDS returns need of a client (docs/wave3-plan.md step 6).
  legalName: text(200),
  city: z.string().trim().max(100),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{5}$/, 'A PIN code: 6 digits')
    .nullable()
    .or(z.literal('').transform(() => null)),
  stateCode: z
    .string()
    .trim()
    .regex(/^[0-9]{2}$/, 'A two-digit state code')
    .nullable()
    .or(z.literal('').transform(() => null)),
  tan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}[0-9]{5}[A-Z]$/, 'A TAN: 4 letters, 5 digits, a letter')
    .nullable()
    .or(z.literal('').transform(() => null)),
};
const partyCreate = z.object({
  ...partyFields,
  isClient: partyFields.isClient.default(true),
  isVendor: partyFields.isVendor.default(false),
  isSubcontractor: partyFields.isSubcontractor.default(false),
  isCompetitor: partyFields.isCompetitor.default(false),
  gstin: partyFields.gstin.default(null),
  pan: partyFields.pan.default(null),
  contactName: partyFields.contactName.default(null),
  email: partyFields.email.default(null),
  phone: partyFields.phone.default(null),
  address: partyFields.address.default(null),
  notes: partyFields.notes.default(''),
  tdsSection: partyFields.tdsSection.default(null),
  rcmCategory: partyFields.rcmCategory.default(null),
  udyamNo: partyFields.udyamNo.default(null),
  msmeType: partyFields.msmeType.default(null),
  bankAccountName: partyFields.bankAccountName.default(null),
  bankAccountNo: partyFields.bankAccountNo.default(null),
  bankIfsc: partyFields.bankIfsc.default(null),
  legalName: partyFields.legalName.default(null),
  city: partyFields.city.default(''),
  pincode: partyFields.pincode.default(null),
  stateCode: partyFields.stateCode.default(null),
  tan: partyFields.tan.default(null),
});
const partyUpdate = z
  .object(partyFields)
  .partial()
  .extend({ rowVersion: z.number().int().positive() });
const partyQuery = z.object({
  q: z.string().max(200).optional(),
  kind: z.enum(['client', 'vendor', 'subcontractor', 'competitor']).optional(),
});

const tenderFields = {
  title: z.string().trim().min(3).max(300),
  clientId: z.uuid().nullable(),
  clientRef: text(100),
  source: z.enum([
    'public_portal',
    'gem',
    'private_invitation',
    'repeat_client',
    'referral',
    'other',
  ]),
  portalUrl: z
    .url({ protocol: /^https?$/ })
    .max(1000)
    .nullable()
    .or(z.literal('').transform(() => null)),
  vertical: z.enum(['buildings', 'interiors', 'joinery', 'mep', 'other']),
  location: text(200),
  estimatedValue: money,
  emdAmount: money,
  tenderFee: money,
  publishedOn: day,
  prebidAt: instant,
  submissionDueAt: instant,
  openingAt: instant,
  queriesDueAt: instant,
  bidValidityDays: z.number().int().min(1).max(730).nullable(),
  ownerId: z.uuid().nullable(),
  description: z.string().trim().max(10_000),
};
const tenderCreate = z.object({
  title: tenderFields.title,
  clientId: tenderFields.clientId.default(null),
  clientRef: tenderFields.clientRef.default(null),
  source: tenderFields.source.default('other'),
  portalUrl: tenderFields.portalUrl.default(null),
  vertical: tenderFields.vertical.default('buildings'),
  location: tenderFields.location.default(null),
  estimatedValue: tenderFields.estimatedValue.default(null),
  emdAmount: tenderFields.emdAmount.default(null),
  tenderFee: tenderFields.tenderFee.default(null),
  publishedOn: tenderFields.publishedOn.default(null),
  prebidAt: tenderFields.prebidAt.default(null),
  submissionDueAt: tenderFields.submissionDueAt.default(null),
  openingAt: tenderFields.openingAt.default(null),
  queriesDueAt: tenderFields.queriesDueAt.default(null),
  bidValidityDays: tenderFields.bidValidityDays.default(null),
  ownerId: tenderFields.ownerId.default(null),
  description: tenderFields.description.default(''),
});
const tenderUpdate = z
  .object(tenderFields)
  .partial()
  .extend({ rowVersion: z.number().int().positive() });
const tenderQuery = z.object({
  status: z.enum(['open', 'closed', ...TENDER_STATUSES]).optional(),
  q: z.string().max(200).optional(),
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
const moveBody = z.object({
  to: z.enum(TENDER_STATUSES),
  reason: z.string().trim().max(1000).default(''),
});
const decideBody = z.object({
  criteria: z
    .array(
      z.object({
        key: z.string().max(40),
        weight: z.number().min(0).max(5),
        score: z.number().int().min(1).max(5),
      }),
    )
    .min(1)
    .max(20),
  decision: z.enum(['bid', 'no_bid']),
  reason: z.string().trim().max(2000).default(''),
});

type Claims = TenantClaims;

/** Tender register and the party master (docs/wave1-plan.md step 1). Everyone may read; changes need the `tender.edit` permission (admin-configurable per role). */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class TenderController {
  constructor(private readonly tenders: TenderService) {}

  @Get('parties')
  parties(@Auth() c: Claims, @Query(new ZodPipe(partyQuery)) q: z.infer<typeof partyQuery>) {
    return this.tenders.listParties(c, q);
  }

  @Post('parties')
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  createParty(@Auth() c: Claims, @Body(new ZodPipe(partyCreate)) b: z.infer<typeof partyCreate>) {
    return this.tenders.createParty(c, b);
  }

  @Post('parties/:id')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  updateParty(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(partyUpdate)) b: z.infer<typeof partyUpdate>,
  ) {
    const { rowVersion, ...fields } = b;
    return this.tenders.updateParty(c, id, rowVersion, fields);
  }

  @Get('people')
  people(@Auth() c: Claims) {
    return this.tenders.people(c);
  }

  @Get('tenders')
  list(@Auth() c: Claims, @Query(new ZodPipe(tenderQuery)) q: z.infer<typeof tenderQuery>) {
    return this.tenders.list(c, q);
  }

  @Get('tenders/:id')
  get(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenders.get(c, id);
  }

  @Post('tenders')
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  create(@Auth() c: Claims, @Body(new ZodPipe(tenderCreate)) b: z.infer<typeof tenderCreate>) {
    return this.tenders.create(c, b);
  }

  @Post('tenders/:id')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  update(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(tenderUpdate)) b: z.infer<typeof tenderUpdate>,
  ) {
    const { rowVersion, ...fields } = b;
    return this.tenders.update(c, id, rowVersion, fields);
  }

  @Post('tenders/:id/status')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  move(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(moveBody)) b: z.infer<typeof moveBody>,
  ) {
    return this.tenders.move(c, id, b.to, b.reason);
  }

  @Post('tenders/:id/decision')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  decide(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decideBody)) b: z.infer<typeof decideBody>,
  ) {
    return this.tenders.decide(c, id, {
      decision: b.decision,
      reason: b.reason,
      criteria: b.criteria.map((x) => ({ ...x, label: '' })),
    });
  }
}
