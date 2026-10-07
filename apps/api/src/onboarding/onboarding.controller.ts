import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RateLimit } from '../auth/rate-limit.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { OnboardingService } from './onboarding.service.js';

const tokenQuery = z.object({ token: z.string().min(20).max(200) });
const callbackQuery = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(),
});
const chooseOrgBody = z.object({
  token: z.string().min(20).max(200),
  organisationId: z.string().min(1).max(200),
});

/** Browser-facing onboarding routes. Results are shown by the website, so redirects never carry secrets. */
@Controller('onboarding')
@RateLimit(30)
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('supabase/authorize')
  async authorize(
    @Query(new ZodPipe(tokenQuery)) q: z.infer<typeof tokenQuery>,
    @Res() res: FastifyReply,
  ) {
    return res.redirect(await this.onboarding.authorizeUrl(q.token), 302);
  }

  @Get('supabase/callback')
  async callback(
    @Query(new ZodPipe(callbackQuery)) q: z.infer<typeof callbackQuery>,
    @Res() res: FastifyReply,
  ) {
    const target = new URL('/onboarding/status', this.config.websiteUrl);
    if (q.error || !q.code || !q.state) {
      target.searchParams.set('error', q.error ? 'consent_denied' : 'invalid_callback');
      return res.redirect(target.toString(), 302);
    }
    try {
      await this.onboarding.callback(q.code, q.state);
    } catch (err) {
      const code = (err as { response?: { code?: string } }).response?.code ?? 'connect_failed';
      target.searchParams.set('error', code);
    }
    return res.redirect(target.toString(), 302);
  }

  @Get('status')
  status(@Query(new ZodPipe(tokenQuery)) q: z.infer<typeof tokenQuery>) {
    return this.onboarding.status(q.token);
  }

  @Post('supabase/organisation')
  @HttpCode(200)
  chooseOrganisation(@Body(new ZodPipe(chooseOrgBody)) body: z.infer<typeof chooseOrgBody>) {
    return this.onboarding.chooseOrganisation(body.token, body.organisationId);
  }
}
