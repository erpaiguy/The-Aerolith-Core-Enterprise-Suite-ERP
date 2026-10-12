// The public API and its administration (docs/wave6-plan.md step 6):
// - `/api/v1/*`: called with an API key (`Authorization: Bearer aek1...`), each route needing a scope.
// - `/api/tenant/integrations/*`: admins make keys and webhooks and see what was sent.
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { RateLimit } from '../auth/rate-limit.js';
import { TallyService } from '../accounts/tally.service.js';
import { reportSpec } from '../bi/bi.controller.js';
import { BiService } from '../bi/bi.service.js';
import type { Spec } from '../bi/query.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { featuresUnlocked } from '../licensing/licence-rules.js';
import { ApiKeysService, type KeyPrincipal } from './api-keys.service.js';
import { EVENTS } from './events.js';
import { SCOPES, type Scope } from './integration-rules.js';
import { WebhooksService } from './webhooks.service.js';

const SCOPE = 'aerolith:api-scope';
const NeedsScope = (scope: Scope) => SetMetadata(SCOPE, scope);
const PER_KEY_PER_MINUTE = 120;

type Req = {
  headers: Record<string, string | undefined>;
  method: string;
  auth?: TenantClaims;
  key?: KeyPrincipal;
};

/** API keys only; the route's scope; 120 requests a minute per key; a read-only licence allows reads only. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly keys: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Req>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer aek1.'))
      throw new UnauthorizedException({ code: 'api_key_required' });
    const principal = await this.keys.resolve(header.slice(7));
    const scope = this.reflector.get<Scope | undefined>(SCOPE, context.getHandler());
    if (scope && !principal.scopes.includes(scope))
      throw new ForbiddenException({
        code: 'scope_missing',
        scope,
        message: `This key lacks the ${scope} scope.`,
      });
    const now = Date.now();
    const hit = this.hits.get(principal.keyId);
    if (!hit || hit.resetAt <= now)
      this.hits.set(principal.keyId, { count: 1, resetAt: now + 60_000 });
    else if (++hit.count > PER_KEY_PER_MINUTE)
      throw new HttpException(
        { code: 'rate_limited', retryAfterSeconds: Math.ceil((hit.resetAt - now) / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const writes = this.reflector.get<boolean | undefined>(
      'aerolith:v1-writes',
      context.getHandler(),
    );
    if (writes && !featuresUnlocked(principal.claims.lic))
      throw new ForbiddenException({ code: 'licence_read_only' });
    req.auth = principal.claims;
    req.key = principal;
    return true;
  }
}
const Writes = () => SetMetadata('aerolith:v1-writes', true);

const pendingQuery = z.object({
  entityId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const results = z.object({
  results: z
    .array(
      z.object({
        voucherId: z.uuid(),
        ok: z.boolean(),
        response: z.string().max(4000).default(''),
      }),
    )
    .min(1)
    .max(200),
});

/** The OpenAPI document, from the same zod schemas the routes validate with. */
function openApi() {
  const json = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
  const bearer = [{ apiKey: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Aerolith Core API',
      version: '1',
      description:
        'Read the reporting views with the access of the key’s maker, and run the Tally agent. Keys are made by an admin under Settings › Integrations.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'aek1.<tenant>.<id>.<secret>' },
      },
    },
    security: bearer,
    paths: {
      '/views': {
        get: {
          summary: 'The views this key may read, with their fields',
          'x-scope': 'reports:read',
          responses: { 200: { description: 'Views' } },
        },
      },
      '/views/{view}/query': {
        post: {
          summary: 'Rows of a view: fields, filters, grouping and sums (the report builder’s spec)',
          'x-scope': 'reports:read',
          parameters: [{ name: 'view', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: { 'application/json': { schema: json(reportSpec.omit({ view: true })) } },
          },
          responses: {
            200: { description: 'Columns and rows' },
            400: { description: 'The spec was refused' },
          },
        },
      },
      '/tally/pending': {
        get: {
          summary: 'Vouchers not yet in Tally, each as a Tally XML import',
          'x-scope': 'tally',
          parameters: [
            {
              name: 'entityId',
              in: 'query',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
          ],
          responses: { 200: { description: 'Vouchers' } },
        },
      },
      '/tally/results': {
        post: {
          summary: 'What Tally answered for each voucher',
          'x-scope': 'tally',
          requestBody: { content: { 'application/json': { schema: json(results) } } },
          responses: { 200: { description: 'Recorded' } },
        },
      },
    },
    'x-webhook-events': EVENTS,
  };
}

@Controller('v1')
export class PublicApiController {
  constructor(
    private readonly bi: BiService,
    private readonly tally: TallyService,
  ) {}

  @Get('openapi.json')
  @RateLimit(30)
  openapi() {
    return openApi();
  }

  @Get('views')
  @UseGuards(ApiKeyGuard)
  @NeedsScope('reports:read')
  views(@Auth() c: TenantClaims) {
    return this.bi.views(c);
  }

  @Post('views/:view/query')
  @HttpCode(200)
  @UseGuards(ApiKeyGuard)
  @NeedsScope('reports:read')
  query(
    @Auth() c: TenantClaims,
    @Param('view', new ZodPipe(z.string().regex(/^[a-z_]{1,40}$/))) view: string,
    @Body(new ZodPipe(reportSpec.omit({ view: true }))) b: Omit<Spec, 'view'>,
  ) {
    return this.bi.run(c, { ...b, view } as Spec);
  }

  @Get('tally/pending')
  @UseGuards(ApiKeyGuard)
  @NeedsScope('tally')
  pending(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(pendingQuery)) q: z.infer<typeof pendingQuery>,
  ) {
    return this.tally.pending(c, q);
  }

  @Post('tally/results')
  @HttpCode(200)
  @UseGuards(ApiKeyGuard)
  @NeedsScope('tally')
  @Writes()
  results(@Auth() c: TenantClaims, @Body(new ZodPipe(results)) b: z.infer<typeof results>) {
    return this.tally.results(c, b.results);
  }
}

const keyBody = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
});
const hookBody = z.object({
  url: z.string().trim().max(500),
  events: z.array(z.enum(EVENTS)).min(1),
});

@Controller('tenant/integrations')
@UseGuards(TenantAuthGuard)
export class IntegrationsController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly hooks: WebhooksService,
    private readonly tally: TallyService,
  ) {}

  @Get('api-keys')
  listKeys(@Auth() c: TenantClaims) {
    return this.keys.list(c);
  }

  @Post('api-keys')
  createKey(@Auth() c: TenantClaims, @Body(new ZodPipe(keyBody)) b: z.infer<typeof keyBody>) {
    return this.keys.create(c, b);
  }

  @Post('api-keys/:id/revoke')
  @HttpCode(200)
  revokeKey(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.keys.revoke(c, id);
  }

  @Get('webhooks')
  listHooks(@Auth() c: TenantClaims) {
    return this.hooks.list(c);
  }

  @Post('webhooks')
  createHook(@Auth() c: TenantClaims, @Body(new ZodPipe(hookBody)) b: z.infer<typeof hookBody>) {
    return this.hooks.create(c, b);
  }

  @Post('webhooks/:id/test')
  @HttpCode(200)
  testHook(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.hooks.test(c, id);
  }

  @Post('webhooks/:id/disable')
  @HttpCode(200)
  disableHook(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.hooks.disable(c, id);
  }

  @Get('tally-sync')
  tallySync(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.tally.syncStatus(c, q.entityId);
  }
}
