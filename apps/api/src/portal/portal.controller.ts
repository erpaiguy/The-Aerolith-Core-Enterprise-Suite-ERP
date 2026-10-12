// Portal routes (docs/wave6-plan.md step 5):
// - `/api/portal/auth/*`: accept an invitation, sign in, refresh and sign out. No token needed; rate limited.
// - `/api/portal/*`: the portal user's own records, behind PortalGuard (portal tokens only).
// - `/api/tenant/portal-users`, `/api/tenant/portal-submissions`: staff invite people and check what they send.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
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
import {
  CLIENT_HEADER,
  clearedPortalRefreshCookie,
  PORTAL_REFRESH_COOKIE,
  portalRefreshCookie,
  readCookie,
} from '../auth/cookie.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { RateLimit } from '../auth/rate-limit.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { PortalAuthService, type PortalClaims } from './portal-auth.service.js';
import { PortalGuard } from './portal.guard.js';
import { PortalService } from './portal.service.js';
import { PORTAL_KINDS } from './portal-rules.js';
import { SubmissionsService } from './submissions.service.js';

const inviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const money = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'An amount in rupees');
const qty = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'A quantity');
const date = z.iso.date();

const login = z.object({
  tenant: z.uuid(),
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});
const accept = z.object({
  tenant: z.uuid(),
  token: inviteToken,
  password: z.string().min(1).max(200),
});
const refresh = z.object({ tenant: z.uuid() });
const invite = z.object({
  partyId: z.uuid(),
  kind: z.enum(PORTAL_KINDS),
  email: z.email().max(254),
  name: z.string().trim().min(2).max(120),
});
const quote = z.object({
  validUntil: date.nullable().default(null),
  reference: z.string().trim().max(100).default(''),
  gstMode: z.enum(['extra', 'included', 'exempt']).default('extra'),
  gstPct: z.enum(['0', '5', '12', '18', '28']).default('18'),
  terms: z.string().trim().max(4000).default(''),
  lines: z
    .array(
      z.object({
        lineId: z.uuid(),
        rate: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'A rate'),
        remark: z.string().trim().max(500).default(''),
      }),
    )
    .min(1)
    .max(2000),
});
const measurement = z.object({
  measuredOn: date,
  lines: z
    .array(
      z.object({
        lineKey: z.uuid(),
        qty: qty.refine((v) => Number(v) > 0, 'More than nothing'),
        description: z.string().trim().max(500).default(''),
      }),
    )
    .min(1)
    .max(500),
});
const invoiceQuery = z.object({
  invoiceNo: z.string().trim().min(1).max(60),
  invoiceDate: date,
  amount: money,
});

function fileHeaders(reply: FastifyReply) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
  reply.header('Cache-Control', 'private, max-age=600');
}

@Controller('portal/auth')
@RateLimit(30)
export class PortalAuthController {
  constructor(
    private readonly auth: PortalAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private withCookie<T extends { refreshToken: string }>(reply: FastifyReply, result: T) {
    reply.header('set-cookie', portalRefreshCookie(result.refreshToken, this.config.secureCookies));
    const { refreshToken: _refreshToken, ...rest } = result;
    return rest;
  }

  @Get('invitation')
  invitation(
    @Query(new ZodPipe(z.object({ tenant: z.uuid(), token: inviteToken })))
    q: {
      tenant: string;
      token: string;
    },
  ) {
    return this.auth.invitation(q.tenant, q.token);
  }

  @Post('accept')
  @HttpCode(200)
  @RateLimit(10)
  async accept(
    @Body(new ZodPipe(accept)) b: z.infer<typeof accept>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.withCookie(reply, await this.auth.accept(b.tenant, b.token, b.password));
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit(10)
  async login(
    @Body(new ZodPipe(login)) b: z.infer<typeof login>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.withCookie(reply, await this.auth.login(b.tenant, b.email, b.password));
  }

  /** The cookie plus the client header (which a cross-site page cannot send), as for staff. */
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(new ZodPipe(refresh)) b: z.infer<typeof refresh>,
    @Headers('cookie') cookie: string | undefined,
    @Headers(CLIENT_HEADER) client: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = readCookie(cookie, PORTAL_REFRESH_COOKIE);
    if (!token || !client) throw new BadRequestException({ code: 'refresh_token_missing' });
    return this.withCookie(reply, await this.auth.refresh(b.tenant, token));
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(PortalGuard)
  async logout(
    @Auth() c: PortalClaims,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logout(c);
    reply.header('set-cookie', clearedPortalRefreshCookie(this.config.secureCookies));
  }
}

@Controller('portal')
@UseGuards(PortalGuard)
@RateLimit(120)
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('enquiries')
  enquiries(@Auth() c: PortalClaims) {
    return this.portal.enquiries(c);
  }

  @Get('enquiries/:id')
  enquiry(@Auth() c: PortalClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.enquiry(c, id);
  }

  @Post('enquiries/:id/quote')
  submitQuote(
    @Auth() c: PortalClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(quote)) b: z.infer<typeof quote>,
  ) {
    return this.portal.submitQuote(c, id, b);
  }

  @Get('orders')
  orders(@Auth() c: PortalClaims) {
    return this.portal.orders(c);
  }

  @Get('orders/:id')
  order(@Auth() c: PortalClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.order(c, id);
  }

  @Post('orders/:id/acknowledge')
  @HttpCode(200)
  acknowledge(
    @Auth() c: PortalClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ reference: z.string().trim().max(150).default('') })))
    b: { reference: string },
  ) {
    return this.portal.acknowledge(c, id, b.reference);
  }

  @Post('orders/:id/measurements')
  submitMeasurement(
    @Auth() c: PortalClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(measurement)) b: z.infer<typeof measurement>,
  ) {
    return this.portal.submitMeasurement(c, id, b);
  }

  /** multipart/form-data, field `file`: the invoice (PDF or photo); its number, date and amount in the query. */
  @Post('orders/:id/invoices')
  async submitInvoice(
    @Auth() c: PortalClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(invoiceQuery)) q: z.infer<typeof invoiceQuery>,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the file as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 10 * 1024 * 1024 + 1, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
    return this.portal.submitInvoice(c, id, q, {
      name: file.filename,
      stream: file.file,
      truncated: () => file.file.truncated,
    });
  }

  @Get('submissions')
  submissions(@Auth() c: PortalClaims) {
    return this.portal.submissions(c);
  }

  @Get('bills')
  bills(@Auth() c: PortalClaims) {
    return this.portal.bills(c);
  }

  @Get('projects')
  projects(@Auth() c: PortalClaims) {
    return this.portal.projects(c);
  }

  @Get('projects/:id')
  project(@Auth() c: PortalClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.project(c, id);
  }

  @Get('projects/:id/photos/:photoId')
  async photo(
    @Auth() c: PortalClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.portal.photo(c, id, photoId);
    fileHeaders(reply);
    return new StreamableFile(p.stream, { type: p.mime, length: p.size });
  }

  @Get('transmittals')
  transmittals(@Auth() c: PortalClaims) {
    return this.portal.transmittalList(c);
  }

  @Get('transmittals/:id')
  transmittal(@Auth() c: PortalClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.transmittal(c, id);
  }

  @Get('transmittals/:id/items/:item')
  async transmittalFile(
    @Auth() c: PortalClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('item', ParseUUIDPipe) item: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.portal.transmittalFile(c, id, item);
    fileHeaders(reply);
    return new StreamableFile(f.stream, {
      type: f.mime,
      length: f.size,
      disposition: attachment(f.fileName),
    });
  }

  @Post('transmittals/:id/acknowledge')
  @HttpCode(200)
  acknowledgeTransmittal(@Auth() c: PortalClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.acknowledgeTransmittal(c, id);
  }

  @Post('transmittals/:id/respond')
  @HttpCode(200)
  respondTransmittal(
    @Auth() c: PortalClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          response: z.string().trim().min(1).max(4000),
          code: z.string().trim().max(20).nullable().default(null),
        }),
      ),
    )
    b: { response: string; code: string | null },
  ) {
    return this.portal.respondTransmittal(c, id, b);
  }
}

@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class PortalStaffController {
  constructor(
    private readonly auth: PortalAuthService,
    private readonly submissions: SubmissionsService,
  ) {}

  @Get('portal-users')
  users(@Auth() c: TenantClaims) {
    return this.auth.list(c);
  }

  @Post('portal-users')
  @RequiresFeatures()
  invite(@Auth() c: TenantClaims, @Body(new ZodPipe(invite)) b: z.infer<typeof invite>) {
    return this.auth.invite(c, b);
  }

  @Post('portal-users/:id/resend')
  @HttpCode(200)
  @RequiresFeatures()
  resend(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.resend(c, id);
  }

  @Post('portal-users/:id/deactivate')
  @HttpCode(200)
  deactivate(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.deactivate(c, id);
  }

  @Get('portal-submissions')
  list(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ status: z.enum(['submitted', 'all']).default('submitted') })))
    q: { status: 'submitted' | 'all' },
  ) {
    return this.submissions.list(c, q.status);
  }

  @Get('portal-submissions/:id/file')
  async file(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.submissions.file(c, id);
    fileHeaders(reply);
    return new StreamableFile(f.stream, {
      type: f.mime,
      ...(f.size === undefined ? {} : { length: f.size }),
      disposition: attachment(f.name),
    });
  }

  @Post('portal-submissions/:id/accept')
  @HttpCode(200)
  @RequiresFeatures()
  acceptSubmission(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.submissions.accept(c, id);
  }

  @Post('portal-submissions/:id/reject')
  @HttpCode(200)
  rejectSubmission(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ reason: z.string().trim().min(3).max(500) })))
    b: { reason: string },
  ) {
    return this.submissions.reject(c, id, b.reason);
  }
}
