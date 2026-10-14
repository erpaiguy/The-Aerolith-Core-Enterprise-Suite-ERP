// Safety inspections (docs/wave7-plan.md step 7d.5): site walks, numbered SW-001…, each with where and who walked,
// the safety checklist filled on it (if any), and its findings: what was seen, how serious, what is to be done, by
// whom (on the project's team) and by when. The owner or a safety manager closes a finding with what was done; a
// walk stands open until all its findings are closed. Open findings wait in their owner's work.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export interface WalkInput {
  walkedOn: string;
  area: string;
  walkedBy: string;
  checklistId: string | null;
  note: string;
  findings: {
    observation: string;
    severity: 'low' | 'medium' | 'high';
    action: string;
    ownerId: string;
    dueOn: string;
  }[];
}

@Injectable()
export class SiteWalkService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
  ) {}

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    const walks = await db`
      SELECT w.id, w.number, to_char(w.walked_on, 'YYYY-MM-DD') AS "walkedOn", w.area, w.walked_by AS "walkedBy",
        (SELECT count(*)::int FROM hse.walk_finding f WHERE f.walk_id = w.id) AS findings,
        (SELECT count(*)::int FROM hse.walk_finding f WHERE f.walk_id = w.id AND f.status = 'open') AS open,
        (SELECT count(*)::int FROM hse.walk_finding f WHERE f.walk_id = w.id AND f.status = 'open'
          AND f.severity = 'high') AS "openHigh"
      FROM hse.site_walk w WHERE w.project_id = ${projectId} ORDER BY w.walked_on DESC, w.number DESC`;
    // The safety checklists filled on the project, to tie a walk to.
    const checklists = await db`
      SELECT c.id, ct.name AS template, to_char(c.done_on, 'YYYY-MM-DD') AS "doneOn", c.location, c.result
      FROM qa.checklist c JOIN qa.checklist_template ct ON ct.id = c.template_id
      WHERE c.project_id = ${projectId} AND lower(ct.work_type) = 'safety' ORDER BY c.done_on DESC LIMIT 50`;
    const team = await db`
      SELECT u.id, u.display_name AS name FROM proj.member m JOIN platform."user" u ON u.id = m.user_id
      WHERE m.project_id = ${projectId} ORDER BY u.display_name`;
    return {
      walks,
      checklists,
      team,
      mayWrite: a.canEdit || a.role === 'member',
      me: claims.sub,
    };
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [w] = await db<
      { project_id: string }[]
    >`SELECT project_id FROM hse.site_walk WHERE id = ${id}`;
    if (!w) throw new NotFoundException({ code: 'not_found' });
    const a = await this.projects.access(db, claims, w.project_id);
    const [head] = await db`
      SELECT w.id, w.number, to_char(w.walked_on, 'YYYY-MM-DD') AS "walkedOn", w.area, w.walked_by AS "walkedBy",
        w.note, w.project_id AS "projectId", p.name AS project, w.checklist_id AS "checklistId",
        ct.name AS checklist, c.result AS "checklistResult", u.display_name AS "recordedBy"
      FROM hse.site_walk w JOIN proj.project p ON p.id = w.project_id
      LEFT JOIN qa.checklist c ON c.id = w.checklist_id
      LEFT JOIN qa.checklist_template ct ON ct.id = c.template_id
      LEFT JOIN platform."user" u ON u.id = w.created_by WHERE w.id = ${id}`;
    const findings = await db`
      SELECT f.id, f.position, f.observation, f.severity, f.action, f.owner_id AS "ownerId", u.display_name AS owner,
        to_char(f.due_on, 'YYYY-MM-DD') AS "dueOn", f.status, to_char(f.closed_on, 'YYYY-MM-DD') AS "closedOn",
        f.closure, f.status = 'open' AND f.due_on < (now() AT TIME ZONE 'Asia/Kolkata')::date AS overdue
      FROM hse.walk_finding f JOIN platform."user" u ON u.id = f.owner_id
      WHERE f.walk_id = ${id} ORDER BY f.position`;
    return {
      ...head,
      findings,
      status: findings.some((f) => f.status === 'open') ? 'open' : 'closed',
      mayManage: a.canEdit || (await this.permissions.can(claims, 'safety.manage')),
      me: claims.sub,
    };
  }

  async create(claims: TenantClaims, projectId: string, b: WalkInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team records its site walks.",
      });
    const team = new Set(
      (
        await db<
          { user_id: string }[]
        >`SELECT user_id FROM proj.member WHERE project_id = ${projectId}`
      ).map((m) => m.user_id),
    );
    for (const f of b.findings)
      if (!team.has(f.ownerId) && f.ownerId !== claims.sub)
        throw new BadRequestException({
          code: 'not_on_project',
          message: "A finding's owner must be on the project's team.",
        });
    if (b.checklistId) {
      const [c] =
        await db`SELECT 1 FROM qa.checklist WHERE id = ${b.checklistId} AND project_id = ${projectId}`;
      if (!c) throw new BadRequestException({ code: 'not_this_project' });
    }
    const id = await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const [c] = await tx<{ n: number }[]>`
        SELECT count(*)::int + 1 AS n FROM hse.site_walk WHERE project_id = ${projectId}`;
      const [w] = await tx<{ id: string }[]>`
        INSERT INTO hse.site_walk (project_id, number, walked_on, area, walked_by, checklist_id, note, created_by)
        VALUES (${projectId}, ${`SW-${String(c!.n).padStart(3, '0')}`}, ${b.walkedOn}, ${b.area}, ${b.walkedBy},
          ${b.checklistId}, ${b.note}, ${claims.sub})
        RETURNING id`;
      for (const [i, f] of b.findings.entries())
        await tx`
          INSERT INTO hse.walk_finding (walk_id, position, observation, severity, action, owner_id, due_on)
          VALUES (${w!.id}, ${i + 1}, ${f.observation}, ${f.severity}, ${f.action}, ${f.ownerId}, ${f.dueOn})`;
      return w!.id;
    });
    return this.get(claims, id);
  }

  /** A finding put right: by its owner, the project's lead, or a safety manager. */
  async close(claims: TenantClaims, findingId: string, b: { closedOn: string; closure: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    const [f] = await db<{ walk_id: string; owner_id: string; project_id: string }[]>`
      SELECT f.walk_id, f.owner_id, w.project_id FROM hse.walk_finding f
      JOIN hse.site_walk w ON w.id = f.walk_id WHERE f.id = ${findingId}`;
    if (!f) throw new NotFoundException({ code: 'not_found' });
    const a = await this.projects.access(db, claims, f.project_id);
    if (
      f.owner_id !== claims.sub &&
      !a.canEdit &&
      !(await this.permissions.can(claims, 'safety.manage'))
    )
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Its owner, the project lead or a safety manager closes a finding.',
      });
    await db`
      UPDATE hse.walk_finding SET status = 'closed', closed_on = ${b.closedOn}, closed_by = ${claims.sub},
        closure = ${b.closure}
      WHERE id = ${findingId} AND status = 'open'`;
    return this.get(claims, f.walk_id);
  }
}
