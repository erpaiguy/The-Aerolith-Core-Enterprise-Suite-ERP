// Fixed-window rate limiter keyed by client IP and route (docs/09-security.md §3.3). In-memory, so it is per API
// process; that matches the single-server trial deployment. Move the counters to Valkey when the API scales out.
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

export interface RateLimitRule {
  /** Requests allowed per window; multiplied by the configured scale (tests raise it). */
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT = 'aerolith:rate-limit';
export const RateLimit = (limit: number, windowSeconds = 60) =>
  SetMetadata(RATE_LIMIT, { limit, windowSeconds });

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rule) return true;
    const req = context
      .switchToHttp()
      .getRequest<{ ip?: string; routeOptions?: { url?: string }; url: string }>();
    const now = Date.now();
    this.sweep(now);
    const key = `${req.ip ?? 'unknown'}|${req.routeOptions?.url ?? req.url}`;
    const entry = this.hits.get(key);
    const limit = Math.ceil(rule.limit * this.config.rateLimitScale);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1000 });
      return true;
    }
    entry.count++;
    if (entry.count > limit) {
      throw new HttpException(
        { code: 'rate_limited', retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
