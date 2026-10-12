// Portal routes admit only portal tokens (docs/wave6-plan.md step 5), and staff routes only staff tokens
// (TenantAuthGuard), so neither side can reach the other's. A deactivated user or ended session is refused at once,
// not when the token expires; a lapsed licence leaves the portal read-only.
import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { verifyAccessToken } from '../auth/tokens.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { featuresUnlocked } from '../licensing/licence-rules.js';
import { PortalAuthService, type PortalClaims } from './portal-auth.service.js';

type Req = { headers: Record<string, string | undefined>; method: string; auth?: PortalClaims };

@Injectable()
export class PortalGuard implements CanActivate {
  constructor(
    private readonly auth: PortalAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Req>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException({ code: 'missing_token' });
    const claims = verifyAccessToken(
      header.slice(7),
      this.config.sessionKey,
      Math.floor(Date.now() / 1000),
    );
    if (!claims || claims.kind !== 'portal')
      throw new UnauthorizedException({ code: 'invalid_token' });
    if (!(await this.auth.live(claims)))
      throw new UnauthorizedException({ code: 'session_revoked' });
    if (req.method !== 'GET' && !featuresUnlocked(claims.lic))
      throw new ForbiddenException({
        code: 'licence_read_only',
        message: 'The portal is read-only at the moment.',
      });
    req.auth = claims;
    return true;
  }
}
