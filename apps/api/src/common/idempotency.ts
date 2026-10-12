// Idempotent writes (docs/wave6-plan.md step 4): a phone that lost signal sends a saved form again with the key it
// made. Routes marked @Idempotent() take an `Idempotency-Key`; the first success's status and body are kept per person
// for 7 days and returned to every repeat, so a receipt is never posted twice. A refusal is not kept: the person fixes
// it and sends again with the same key. Two copies in flight at once: the second is told to wait.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, lastValueFrom, of, type Observable } from 'rxjs';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

const IDEMPOTENT = 'aerolith:idempotent';
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);
const KEY = /^[A-Za-z0-9_-]{16,80}$/;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantConnections,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(IDEMPOTENT, context.getHandler())) return next.handle();
    const req = context.switchToHttp().getRequest<FastifyRequest & { auth?: TenantClaims }>();
    const header = req.headers['idempotency-key'];
    if (header === undefined || !req.auth || req.auth.kind !== 'tenant') return next.handle();
    if (typeof header !== 'string' || !KEY.test(header))
      throw new BadRequestException({
        code: 'bad_idempotency_key',
        message: 'The idempotency key is not valid.',
      });
    return from(this.run(context, next, req, header, req.auth));
  }

  private async run(
    context: ExecutionContext,
    next: CallHandler,
    req: FastifyRequest,
    key: string,
    claims: TenantClaims,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const route = `${req.method} ${req.url.split('?')[0]}`.slice(0, 200);
    await db`DELETE FROM platform.idempotency WHERE created_at < now() - interval '7 days'`;
    const [claimed] = await db<{ key: string }[]>`
      INSERT INTO platform.idempotency (key, user_id, route, status) VALUES (${key}, ${claims.sub}, ${route}, 0)
      ON CONFLICT (user_id, key) DO NOTHING RETURNING key`;
    if (!claimed) {
      const [had] = await db<{ route: string; status: number; body: unknown }[]>`
        SELECT route, status, body FROM platform.idempotency WHERE user_id = ${claims.sub} AND key = ${key}`;
      if (!had || had.route !== route)
        throw new ConflictException({
          code: 'idempotency_key_reused',
          message: 'This key was used for something else.',
        });
      if (had.status === 0)
        throw new ConflictException({
          code: 'in_progress',
          message: 'The same request is being handled; try again in a moment.',
        });
      context
        .switchToHttp()
        .getResponse<FastifyReply>()
        .status(had.status)
        .header('idempotent-replay', 'true');
      return lastValueFrom(of(had.body));
    }
    try {
      const body = await lastValueFrom(next.handle(), { defaultValue: null });
      // The status Nest will send: the route's @HttpCode, else 201 for a POST.
      const status =
        (Reflect.getMetadata('__httpCode__', context.getHandler()) as number | undefined) ??
        (req.method === 'POST' ? 201 : 200);
      await db`
        UPDATE platform.idempotency SET status = ${status}, body = ${db.json((body ?? null) as never)}
        WHERE user_id = ${claims.sub} AND key = ${key}`;
      return body;
    } catch (err) {
      await db`DELETE FROM platform.idempotency WHERE user_id = ${claims.sub} AND key = ${key}`;
      throw err;
    }
  }
}
