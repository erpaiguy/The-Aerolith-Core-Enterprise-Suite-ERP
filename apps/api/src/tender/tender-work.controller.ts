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
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { day, instant, money, text } from './tender.controller.js';
import { TenderWorkService } from './tender-work.service.js';

const rowVersion = z.number().int().positive();
const fyParam = z.string().regex(/^\d{4}-\d{2}$/, 'A financial year looks like 2026-27');

const queryCreate = z.object({
  reference: z.string().trim().max(200).default(''),
  question: z.string().trim().min(3).max(4000),
});
const queryUpdate = z.object({
  rowVersion,
  reference: z.string().trim().max(200).optional(),
  question: z.string().trim().min(3).max(4000).optional(),
  status: z.enum(['draft', 'sent', 'answered', 'withdrawn']).optional(),
  sentOn: day.optional(),
  answer: z.string().trim().max(8000).optional(),
  answeredOn: day.optional(),
  addendumId: z.uuid().nullable().optional(),
});

const addendumFields = {
  ref: z.string().trim().min(1).max(100),
  issuedOn: z.iso.date(),
  summary: z.string().trim().min(3).max(8000),
  affectsBoq: z.boolean(),
  acknowledged: z.boolean(),
};
const addendumCreate = z.object({
  ...addendumFields,
  affectsBoq: addendumFields.affectsBoq.default(false),
  acknowledged: addendumFields.acknowledged.default(false),
  /** The addendum moves the submission date to this. */
  newSubmissionDueAt: instant.default(null),
});
const addendumUpdate = z.object(addendumFields).partial().extend({ rowVersion });

const securityFields = {
  purpose: z.enum(['emd', 'performance', 'other']),
  form: z.enum(['bank_guarantee', 'demand_draft', 'fdr', 'online', 'insurance_bond', 'exempt']),
  amount: money.refine((v) => v !== null, 'Required'),
  bank: text(200),
  instrumentNo: text(100),
  issuedOn: day,
  validUntil: day,
  claimUntil: day,
  status: z.enum([
    'planned',
    'issued',
    'submitted',
    'returned',
    'adjusted',
    'forfeited',
    'cancelled',
  ]),
  returnedOn: day,
  notes: z.string().trim().max(4000),
};
const securityCreate = z.object({
  purpose: securityFields.purpose.default('emd'),
  form: securityFields.form,
  amount: securityFields.amount,
  bank: securityFields.bank.default(null),
  instrumentNo: securityFields.instrumentNo.default(null),
  issuedOn: securityFields.issuedOn.default(null),
  validUntil: securityFields.validUntil.default(null),
  claimUntil: securityFields.claimUntil.default(null),
  status: securityFields.status.default('planned'),
  returnedOn: securityFields.returnedOn.default(null),
  notes: securityFields.notes.default(''),
});
const securityUpdate = z.object(securityFields).partial().extend({ rowVersion });

const checklistFields = {
  envelope: z.enum(['technical', 'financial', 'other']),
  title: z.string().trim().min(2).max(300),
  required: z.boolean(),
  status: z.enum(['pending', 'ready', 'not_applicable']),
  assigneeId: z.uuid().nullable(),
  dueOn: day,
  notes: z.string().trim().max(4000),
};
const checklistCreate = z.object({
  envelope: checklistFields.envelope.default('technical'),
  title: checklistFields.title,
  required: checklistFields.required.default(true),
  status: checklistFields.status.default('pending'),
  assigneeId: checklistFields.assigneeId.default(null),
  dueOn: checklistFields.dueOn.default(null),
  notes: checklistFields.notes.default(''),
});
const checklistUpdate = z.object(checklistFields).partial().extend({ rowVersion });

const submissionBody = z.object({
  submittedAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  mode: z.enum(['portal', 'physical', 'email', 'other']),
  reference: text(200).default(null),
  bidValue: money.default(null),
  notes: z.string().trim().max(4000).default(''),
});

const bidsBody = z.object({
  bids: z
    .array(
      z
        .object({
          us: z.boolean().default(false),
          partyId: z.uuid().nullable().default(null),
          name: text(200).default(null),
          quotedValue: money.default(null),
          qualified: z.boolean().default(true),
          notes: z.string().trim().max(1000).default(''),
        })
        .refine((b) => b.us || b.partyId || b.name, 'Name the bidder'),
    )
    .max(200),
});

const resultBody = z.object({
  outcome: z.enum(['won', 'lost']),
  on: day.default(null),
  category: z
    .enum(['price', 'technical', 'qualification', 'documents', 'scope', 'client', 'other'])
    .nullable()
    .default(null),
  reason: z.string().trim().max(1000).default(''),
  value: money.default(null),
  winnerId: z.uuid().nullable().default(null),
  winnerName: text(200).default(null),
});

const agendaQuery = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) });
const analysisQuery = z.object({ fy: fyParam.optional() });

type Claims = TenantClaims;

/**
 * Tender management detail (docs/wave1-plan.md step 8): queries, addenda, EMD/BG, checklist, submissions, opening
 * and result, agenda, win/loss. Everyone may read; changes need `tender.edit`, except an assignee marking their own
 * checklist item. The win/loss analysis shows bid values, so it needs `pricing.edit`.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class TenderWorkController {
  constructor(private readonly work: TenderWorkService) {}

  @Get('tenders/:id/work')
  get(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.work(c, id);
  }

  @Get('tender-agenda')
  agenda(@Auth() c: Claims, @Query(new ZodPipe(agendaQuery)) q: z.infer<typeof agendaQuery>) {
    return this.work.agenda(c, q.days);
  }

  @Get('tender-analysis')
  @RequiresPermission('pricing.edit')
  analysis(@Auth() c: Claims, @Query(new ZodPipe(analysisQuery)) q: z.infer<typeof analysisQuery>) {
    return this.work.analysis(c, q.fy ?? null);
  }

  // --- queries ---

  @Post('tenders/:id/queries')
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  createQuery(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(queryCreate)) b: z.infer<typeof queryCreate>,
  ) {
    return this.work.createQuery(c, id, b);
  }

  @Post('queries/:id')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  updateQuery(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(queryUpdate)) b: z.infer<typeof queryUpdate>,
  ) {
    const { rowVersion: v, ...patch } = b;
    return this.work.updateQuery(c, id, v, patch);
  }

  @Post('queries/:id/delete')
  @HttpCode(204)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  deleteQuery(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.deleteQuery(c, id);
  }

  // --- addenda ---

  @Post('tenders/:id/addenda')
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  createAddendum(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(addendumCreate)) b: z.infer<typeof addendumCreate>,
  ) {
    return this.work.createAddendum(c, id, b);
  }

  @Post('addenda/:id')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  updateAddendum(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(addendumUpdate)) b: z.infer<typeof addendumUpdate>,
  ) {
    const { rowVersion: v, ...patch } = b;
    return this.work.updateAddendum(c, id, v, patch);
  }

  // --- EMD and bank guarantees ---

  @Post('tenders/:id/securities')
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  createSecurity(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(securityCreate)) b: z.infer<typeof securityCreate>,
  ) {
    return this.work.createSecurity(c, id, { ...b, amount: b.amount! });
  }

  @Post('securities/:id')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  updateSecurity(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(securityUpdate)) b: z.infer<typeof securityUpdate>,
  ) {
    const { rowVersion: v, amount, ...patch } = b;
    return this.work.updateSecurity(c, id, v, {
      ...patch,
      ...(amount ? { amount } : {}),
    });
  }

  // --- checklist ---

  @Post('tenders/:id/checklist')
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  addChecklistItem(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(checklistCreate)) b: z.infer<typeof checklistCreate>,
  ) {
    return this.work.addChecklistItem(c, id, b);
  }

  @Post('tenders/:id/checklist/standard')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  addStandardChecklist(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.addStandardChecklist(c, id);
  }

  /** No permission on the route: the assignee may mark their own item; the service checks. */
  @Post('checklist/:id')
  @HttpCode(200)
  @RequiresFeatures()
  updateChecklistItem(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(checklistUpdate)) b: z.infer<typeof checklistUpdate>,
  ) {
    const { rowVersion: v, ...patch } = b;
    return this.work.updateChecklistItem(c, id, v, patch);
  }

  @Post('checklist/:id/delete')
  @HttpCode(204)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  deleteChecklistItem(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.deleteChecklistItem(c, id);
  }

  // --- submission, opening, result ---

  @Post('tenders/:id/submissions')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  submit(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(submissionBody)) b: z.infer<typeof submissionBody>,
  ) {
    return this.work.submit(c, id, b);
  }

  @Post('tenders/:id/bids')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  setBids(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(bidsBody)) b: z.infer<typeof bidsBody>,
  ) {
    return this.work.setBids(c, id, b.bids);
  }

  @Post('tenders/:id/result')
  @HttpCode(200)
  @RequiresPermission('tender.edit')
  @RequiresFeatures()
  result(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resultBody)) b: z.infer<typeof resultBody>,
  ) {
    return this.work.recordResult(c, id, b);
  }
}
