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
import { ContractsService } from './contracts.service.js';

const date = z.iso.date();
const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'An amount in rupees');
const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'A percentage');
const contract = z.object({
  kind: z.enum(['client', 'subcontract']),
  partyId: z.uuid().nullable().default(null),
  orderId: z.uuid().nullable().default(null),
  reference: z.string().trim().min(1).max(200),
  title: z.string().trim().min(3).max(300),
  value: money.default('0'),
  signedOn: date.nullable().default(null),
  startOn: date.nullable().default(null),
  completionOn: date.nullable().default(null),
  dlpMonths: z.number().int().min(0).max(120).default(12),
  ldPctPerWeek: pct.default('0'),
  ldCapPct: pct.default('0'),
  paymentTerms: z.string().trim().max(2000).default(''),
  notes: z.string().trim().max(4000).default(''),
});
const contractUpdate = contract.extend({
  status: z.enum(['active', 'completed', 'closed']),
  rowVersion: z.number().int().positive(),
});
const security = z.object({
  kind: z.enum(['performance', 'advance', 'retention_bond', 'insurance', 'other']),
  issuer: z.string().trim().max(200).default(''),
  number: z.string().trim().max(100).default(''),
  amount: money,
  validUntil: date,
  claimUntil: date.nullable().default(null),
  notes: z.string().trim().max(2000).default(''),
});
const securityUpdate = z.object({
  validUntil: date,
  status: z.enum(['held', 'returned', 'invoked']),
  rowVersion: z.number().int().positive(),
});
const obligation = z.object({
  title: z.string().trim().min(3).max(500),
  clause: z.string().trim().max(100).default(''),
  dueOn: date,
});
const notice = z.object({
  direction: z.enum(['sent', 'received']),
  subject: z.string().trim().min(3).max(500),
  clause: z.string().trim().max(100).default(''),
  dated: date,
  reference: z.string().trim().max(200).default(''),
  replyBy: date.nullable().default(null),
});
const on = z.object({ on: date.nullable() });
const eot = z.object({
  from: date,
  to: date,
  daysClaimed: z.number().int().min(0).max(3650).nullable().default(null),
});
const eotAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit') }),
  z.object({
    action: z.literal('decide'),
    daysGranted: z.number().int().min(0).max(3650),
    reference: z.string().trim().min(1).max(200),
    date,
  }),
]);
const claim = z.object({
  kind: z.enum(['idle_resources', 'prolongation', 'escalation', 'other']),
  title: z.string().trim().min(3).max(300),
  amount: money,
  evidence: z.string().trim().max(8000).default(''),
  eotId: z.uuid().nullable().default(null),
});
const claimStatus = z.object({
  status: z.enum(['submitted', 'negotiation', 'settled', 'rejected']),
  settledAmount: money.nullable().default(null),
  date: date.nullable().default(null),
});

/** Contracts and claims (docs/wave4-plan.md step 5). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get('projects/:id/contracts')
  register(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.contracts.register(c, id);
  }

  @Post('projects/:id/contracts')
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(contract)) b: z.infer<typeof contract>,
  ) {
    return this.contracts.create(c, id, b);
  }

  @Post('contracts/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(contractUpdate)) b: z.infer<typeof contractUpdate>,
  ) {
    return this.contracts.update(c, id, b);
  }

  @Post('contracts/:id/securities')
  @HttpCode(200)
  @RequiresFeatures()
  addSecurity(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(security)) b: z.infer<typeof security>,
  ) {
    return this.contracts.addSecurity(c, id, b);
  }

  @Post('contract-securities/:id')
  @HttpCode(200)
  @RequiresFeatures()
  updateSecurity(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(securityUpdate)) b: z.infer<typeof securityUpdate>,
  ) {
    return this.contracts.updateSecurity(c, id, b);
  }

  @Post('contracts/:id/obligations')
  @HttpCode(200)
  @RequiresFeatures()
  addObligation(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(obligation)) b: z.infer<typeof obligation>,
  ) {
    return this.contracts.addObligation(c, id, b);
  }

  @Post('obligations/:id/done')
  @HttpCode(200)
  @RequiresFeatures()
  obligationDone(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(on)) b: z.infer<typeof on>,
  ) {
    return this.contracts.obligationDone(c, id, b.on);
  }

  @Post('contracts/:id/notices')
  @HttpCode(200)
  @RequiresFeatures()
  addNotice(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(notice)) b: z.infer<typeof notice>,
  ) {
    return this.contracts.addNotice(c, id, b);
  }

  @Post('notices/:id/replied')
  @HttpCode(200)
  @RequiresFeatures()
  replied(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(on)) b: z.infer<typeof on>,
  ) {
    return this.contracts.noticeReplied(c, id, b.on);
  }

  @Get('contracts/:id/eot-basis')
  basis(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ from: date, to: date }))) q: { from: string; to: string },
  ) {
    return this.contracts.eotBasis(c, id, q.from, q.to);
  }

  @Post('contracts/:id/eots')
  @HttpCode(200)
  @RequiresFeatures()
  addEot(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(eot)) b: z.infer<typeof eot>,
  ) {
    return this.contracts.addEot(c, id, b);
  }

  @Post('eots/:id')
  @HttpCode(200)
  @RequiresFeatures()
  eotAction(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(eotAction)) b: z.infer<typeof eotAction>,
  ) {
    return this.contracts.decideEot(c, id, b);
  }

  @Post('contracts/:id/claims')
  @HttpCode(200)
  @RequiresFeatures()
  addClaim(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(claim)) b: z.infer<typeof claim>,
  ) {
    return this.contracts.addClaim(c, id, b);
  }

  @Post('claims/:id/status')
  @HttpCode(200)
  @RequiresFeatures()
  claimStatus(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(claimStatus)) b: z.infer<typeof claimStatus>,
  ) {
    return this.contracts.claimStatus(c, id, b);
  }
}
