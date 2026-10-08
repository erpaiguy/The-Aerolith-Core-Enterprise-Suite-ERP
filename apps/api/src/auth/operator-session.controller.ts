import { Body, Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { clearedOperatorRefreshCookie } from './cookie.js';
import { AllowWhilePasswordChangeRequired, Auth, OperatorGuard, SelfService } from './guards.js';
import { OperatorAuthService } from './operator-auth.service.js';
import { RateLimit } from './rate-limit.js';
import type { AccessClaims } from './tokens.js';

type OperatorClaims = Extract<AccessClaims, { kind: 'operator' }>;
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

/** Signed-in operator actions that must work before the first password change. */
@Controller('owner/auth')
@UseGuards(OperatorGuard)
@AllowWhilePasswordChangeRequired()
@SelfService()
export class OperatorSessionController {
  constructor(private readonly operators: OperatorAuthService) {}

  @Post('change-password')
  @HttpCode(200)
  @RateLimit(10)
  changePassword(
    @Auth() claims: OperatorClaims,
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ) {
    return this.operators.changePassword(
      claims.sub,
      claims.sid,
      body.currentPassword,
      body.newPassword,
    );
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Auth() claims: OperatorClaims,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.operators.logout(claims.sid);
    reply.header('set-cookie', clearedOperatorRefreshCookie());
  }
}
