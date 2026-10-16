import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { GstTdsService } from './gst-tds.service.js';
import { ItcReversalService } from './itc-reversal.service.js';
import { MsmeService } from './msme.service.js';
import { TdsStatementService } from './tds-statements.service.js';

const asOf = z.object({ entityId: z.uuid(), asOf: z.iso.date() });
const quarter = z.string().regex(/^\d{4}-\d{2}-Q[1-4]$/, 'A quarter: 2026-27-Q2');
const amount = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v).replace(/,/g, ''))
  .refine((v) => /^\d{1,16}(\.\d{1,3})?$/.test(v), { message: 'An amount' });
const certificate = z.object({
  entityId: z.uuid(),
  partyId: z.uuid(),
  section: z.enum(['194C', '194J', '194I', '194Q']),
  certNo: z.string().trim().min(1).max(40),
  rate: amount.refine((v) => Number(v) < 30, { message: 'Below 30%' }),
  limit: amount.refine((v) => Number(v) > 0, { message: 'More than zero' }),
  validFrom: z.iso.date(),
  validTo: z.iso.date(),
});
const salaryChallan = z.object({
  entityId: z.uuid(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month: YYYY-MM'),
  depositedOn: z.iso.date(),
  bsrCode: z
    .string()
    .trim()
    .regex(/^\d{7}$/, 'A BSR code: 7 digits'),
  challanNo: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'A challan number: 5 digits'),
  interest: amount.default('0'),
  fee: amount.default('0'),
  bankAccountId: z.uuid(),
});
const range = z.object({ entityId: z.uuid(), from: z.iso.date(), to: z.iso.date() });
const credit = z.object({
  entityId: z.uuid(),
  partyId: z.uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  deductorGstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[0-9A-Z]{13}$/, 'A 15-character GSTIN'),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,14}(\.\d{1,2})?$/)
    .refine((v) => Number(v) > 0, { message: 'More than zero' }),
  acceptedOn: z.iso.date(),
});

/** Tax compliance (docs/wave8-plan.md Wave 8b). Who may do what is checked by the services. */
@Controller('tenant/accounts')
@UseGuards(TenantAuthGuard)
export class TaxComplianceController {
  constructor(
    private readonly rule37: ItcReversalService,
    private readonly gstTds: GstTdsService,
    private readonly statements: TdsStatementService,
    private readonly msme: MsmeService,
  ) {}

  @Get('msme/alerts')
  msmeAlerts(@Auth() c: TenantClaims, @Query(new ZodPipe(asOf)) q: z.infer<typeof asOf>) {
    return this.msme.alerts(c, q);
  }

  @Get('msme/43bh')
  disallowance(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({ entityId: z.uuid(), year: z.coerce.number().int().min(2020).max(2100) }),
      ),
    )
    q: { entityId: string; year: number },
  ) {
    return this.msme.disallowance(c, q);
  }

  @Get('msme/msme-1')
  msme1(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), half: z.string().regex(/^\d{4}-H[12]$/) })))
    q: { entityId: string; half: string },
  ) {
    return this.msme.msme1(c, q);
  }

  @Get('tds/certificates')
  certificates(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.statements.certificates(c, q.entityId);
  }

  @Post('tds/certificates')
  @HttpCode(200)
  @RequiresFeatures()
  addCertificate(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(certificate)) b: z.infer<typeof certificate>,
  ) {
    return this.statements.addCertificate(c, b);
  }

  @Post('tds/salary-challans')
  @HttpCode(200)
  @RequiresFeatures()
  salaryChallan(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(salaryChallan)) b: z.infer<typeof salaryChallan>,
  ) {
    return this.statements.salaryChallan(c, b);
  }

  @Get('tds/24q')
  form24q(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), quarter })))
    q: { entityId: string; quarter: string },
  ) {
    return this.statements.form24q(c, q);
  }

  @Get('tds/16a')
  form16a(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), quarter, partyId: z.uuid() })))
    q: { entityId: string; quarter: string; partyId: string },
  ) {
    return this.statements.form16a(c, q);
  }

  /** The 26Q or 24Q text for the free File Validation Utility. */
  @Get('tds/fvu')
  async fvu(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), quarter, form: z.enum(['26Q', '24Q']) })))
    q: { entityId: string; quarter: string; form: '26Q' | '24Q' },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.statements.fvuText(c, q);
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(Buffer.from(r.text, 'utf8'), {
      type: 'text/plain; charset=utf-8',
      disposition: attachment(r.fileName),
    });
  }

  @Get('gst-tds')
  gstTdsView(@Auth() c: TenantClaims, @Query(new ZodPipe(range)) q: z.infer<typeof range>) {
    return this.gstTds.view(c, q);
  }

  @Post('gst-tds/credits')
  @HttpCode(200)
  @RequiresFeatures()
  acceptGstTds(@Auth() c: TenantClaims, @Body(new ZodPipe(credit)) b: z.infer<typeof credit>) {
    return this.gstTds.accept(c, b);
  }

  @Get('itc-reversals')
  reversals(@Auth() c: TenantClaims, @Query(new ZodPipe(asOf)) q: z.infer<typeof asOf>) {
    return this.rule37.view(c, q.entityId, q.asOf);
  }

  @Post('itc-reversals')
  @HttpCode(200)
  @RequiresFeatures()
  runReversals(@Auth() c: TenantClaims, @Body(new ZodPipe(asOf)) b: z.infer<typeof asOf>) {
    return this.rule37.run(c, b.entityId, b.asOf);
  }
}
