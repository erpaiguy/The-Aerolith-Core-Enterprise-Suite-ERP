// Request authentication. The tenant always comes from the signed access token (docs/09-security.md §3.5).
import {
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { featuresUnlocked } from '../licensing/licence-rules.js';
import { verifyAccessToken, type AccessClaims } from './tokens.js';

type Req = { headers: Record<string, string | undefined>; method: string; auth?: AccessClaims };

const ROLES = 'aerolith:roles';
const ALLOW_MCP = 'aerolith:allow-mcp';
const FEATURES = 'aerolith:features';
const SELF_SERVICE = 'aerolith:self-service';

/** Only these tenant roles may call the route. */
export const Roles = (...roles: ('admin' | 'manager' | 'worker')[]) => SetMetadata(ROLES, roles);
/** The route stays usable while the user must change a temporary password (change password, logout, me). */
export const AllowWhilePasswordChangeRequired = () => SetMetadata(ALLOW_MCP, true);
/** Operator routes about the caller's own account (change password, log out): allowed for every operator role. */
export const SelfService = () => SetMetadata(SELF_SERVICE, true);
/** The route changes data, so it needs an active or grace-period licence (not read-only). */
export const RequiresFeatures = () => SetMetadata(FEATURES, true);

export const Auth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Req>().auth,
);

function bearer(req: Req): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedException({ code: 'missing_token' });
  return header.slice(7);
}

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Req>();
    const claims = verifyAccessToken(
      bearer(req),
      this.config.sessionKey,
      Math.floor(Date.now() / 1000),
    );
    if (!claims || claims.kind !== 'tenant')
      throw new UnauthorizedException({ code: 'invalid_token' });
    const meta = <T>(key: string) =>
      this.reflector.getAllAndOverride<T | undefined>(key, [
        context.getHandler(),
        context.getClass(),
      ]);
    if (claims.mcp && !meta<boolean>(ALLOW_MCP)) {
      throw new ForbiddenException({
        code: 'password_change_required',
        message: 'Set a new password to continue.',
      });
    }
    const roles = meta<string[]>(ROLES);
    if (roles && !roles.includes(claims.role)) throw new ForbiddenException({ code: 'forbidden' });
    if (meta<boolean>(FEATURES) && !featuresUnlocked(claims.lic)) {
      throw new ForbiddenException({
        code: 'licence_read_only',
        message: 'Your licence has ended. Data can be viewed and exported only.',
      });
    }
    req.auth = claims;
    return true;
  }
}

/** Owner console. Reads are open to every operator role; changes need the `owner` role. */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Req>();
    const claims = verifyAccessToken(
      bearer(req),
      this.config.sessionKey,
      Math.floor(Date.now() / 1000),
    );
    if (!claims || claims.kind !== 'operator')
      throw new UnauthorizedException({ code: 'owner_auth_required' });
    const meta = (key: string) =>
      this.reflector.getAllAndOverride<boolean | undefined>(key, [
        context.getHandler(),
        context.getClass(),
      ]);
    if (claims.mcp && !meta(ALLOW_MCP))
      throw new ForbiddenException({ code: 'password_change_required' });
    if (req.method !== 'GET' && claims.role !== 'owner' && !meta(SELF_SERVICE))
      throw new ForbiddenException({ code: 'forbidden' });
    req.auth = claims;
    return true;
  }
}
