import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { RateLimit } from '../auth/rate-limit.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LicensingService } from './licensing.service.js';

const activateSchema = z.object({
  key: z.string().min(1).max(64),
  deviceId: z.string().min(16).max(128),
  platform: z.enum(['windows', 'macos', 'linux', 'browser']),
  label: z.string().max(100).nullable().default(null),
});

const refreshSchema = z.object({ token: z.string().min(10).max(4096) });

const downloadSchema = z.object({
  email: z.string().email().max(254),
  kind: z.enum(['trial', 'paid']),
  seats: z.number().int().positive().max(10_000),
  platform: z.enum(['windows', 'macos', 'linux']),
  appVersion: z.string().min(1).max(32),
});

const bearer = (header: string | undefined): string => {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new UnauthorizedException({ code: 'missing_token' });
  return token;
};

/** Endpoints the desktop/browser app and the website call. */
@Controller()
export class LicensingController {
  constructor(private readonly licensing: LicensingService) {}

  @Post('licences/activate')
  @HttpCode(200)
  @RateLimit(20)
  activate(@Body(new ZodPipe(activateSchema)) body: z.infer<typeof activateSchema>) {
    return this.licensing.activate(body.key, body.deviceId, body.platform, body.label);
  }

  @Post('licences/refresh')
  @HttpCode(200)
  @RateLimit(60)
  refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    return this.licensing.refresh(body.token);
  }

  @Get('licences/notices')
  @RateLimit(60)
  notices(@Headers('authorization') authorization: string | undefined) {
    return this.licensing.noticesFor(bearer(authorization));
  }

  @Post('downloads')
  @HttpCode(204)
  @RateLimit(10)
  async download(
    @Body(new ZodPipe(downloadSchema)) body: z.infer<typeof downloadSchema>,
  ): Promise<void> {
    await this.licensing.recordDownload(body);
  }
}
