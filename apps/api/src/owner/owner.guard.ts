import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * INTERIM owner authentication: a long random bearer token from the server's secrets.
 * Replaced in Wave 0 step 5 by owner login with mandatory MFA (docs/09-security.md §7). Never expose these routes
 * publicly while this guard is in place; bind the API to localhost or the tunnel only.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.expected = digest(config.ownerApiToken);
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !timingSafeEqual(digest(token), this.expected)) {
      throw new UnauthorizedException({ code: 'owner_auth_required' });
    }
    return true;
  }
}
