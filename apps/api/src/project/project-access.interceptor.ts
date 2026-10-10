// A project's BOQs and schedules follow its visibility (docs/wave2a-plan.md steps 2 and 4). Every route that acts on
// one BOQ (`/boqs/:id/...`, an import job's `/imports/:id/...`, a pricing scenario's `/scenarios/:id/...`) or one plan
// (`/programmes/:id/...`) passes here after authentication: one of a project the caller may not see does not exist
// for them; changing one needs a lead or member of the team (or someone who edits projects); bid pricing is for
// tender BOQs only. A tender's BOQs and programmes pass untouched. One place, so no such route can be added without it.
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { TenantClaims } from '../auth/auth.service.js';
import type { AccessClaims } from '../auth/tokens.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { ProjectService } from './project.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOQ_ROUTE = /\/tenant\/boqs\/:id(\/|$)/;
const IMPORT_ROUTE = /\/tenant\/imports\/:id(\/|$)/;
const SCENARIO_ROUTE = /\/tenant\/scenarios\/:id(\/|$)/;
const PLAN_ROUTE = /\/tenant\/programmes\/:id(\/|$)/;
/** Bid pricing belongs to tenders: a contract BOQ's rates are the client's, a budget's are our costs. */
const TENDER_ONLY = /\/tenant\/(boqs\/:id\/(pricing|scenarios)|scenarios\/:id)(\/|$)/;

interface Req {
  method: string;
  auth?: AccessClaims;
  params?: Record<string, string>;
  routeOptions?: { url?: string };
}

@Injectable()
export class ProjectAccess implements NestInterceptor {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Req>();
    const claims = req.auth;
    const url = req.routeOptions?.url ?? '';
    const id = req.params?.id;
    if (claims?.kind !== 'tenant' || !id || !UUID.test(id)) return next.handle();
    const kind = BOQ_ROUTE.test(url)
      ? 'boq'
      : IMPORT_ROUTE.test(url)
        ? 'import'
        : SCENARIO_ROUTE.test(url)
          ? 'scenario'
          : PLAN_ROUTE.test(url)
            ? 'plan'
            : null;
    if (!kind) return next.handle();
    await this.check(claims, kind, id, req.method, TENDER_ONLY.test(url));
    return next.handle();
  }

  private async check(
    claims: TenantClaims,
    kind: 'boq' | 'import' | 'scenario' | 'plan',
    id: string,
    method: string,
    tenderOnly: boolean,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] =
      kind === 'plan'
        ? await db<
            { project_id: string | null }[]
          >`SELECT project_id FROM sched.plan WHERE id = ${id}`
        : await db<{ project_id: string | null }[]>`
          SELECT b.project_id FROM est.boq b WHERE b.id = ${
            kind === 'boq'
              ? id
              : kind === 'import'
                ? db`(SELECT j.target_id FROM platform.import_job j WHERE j.id = ${id} AND j.kind = 'boq')`
                : db`(SELECT s.boq_id FROM est.pricing_scenario s WHERE s.id = ${id})`
          }`;
    if (!b?.project_id) return; // a tender's BOQ, or nothing: the route answers as before
    // Not on the team (and not allowed to see every project): not found.
    const access = await this.projects.access(db, claims, b.project_id);
    if (tenderOnly)
      throw new ConflictException({
        code: 'not_for_project_boq',
        message: "Bid pricing is for a tender's BOQ, not a project's.",
      });
    const writes = method !== 'GET' && method !== 'HEAD';
    if (writes && !access.canEdit && access.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) changes its BOQs and schedules.",
      });
  }
}
