// Inspection and test plans (docs/wave7-plan.md step 7d.4): a project's activities with the checklist and the test
// each needs, how often, and the hold points; beside each, the checklists filled and tests run on the project so far
// (passed and failed), from the quality records.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export interface ItpInput {
  activity: string;
  stage: 'before' | 'during' | 'after';
  checklistTemplateId: string | null;
  testKind: string | null;
  frequency: string;
  holdPoint: boolean;
  responsible: string;
}

@Injectable()
export class ItpService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    const lines = await db`
      SELECT l.id, l.position, l.activity, l.stage, l.frequency, l.hold_point AS "holdPoint", l.responsible,
        l.checklist_template_id AS "checklistTemplateId", t.name AS checklist, l.test_kind AS "testKind",
        (SELECT count(*)::int FROM qa.checklist c WHERE c.project_id = l.project_id
          AND c.template_id = l.checklist_template_id) AS "checklistsDone",
        (SELECT count(*)::int FROM qa.checklist c WHERE c.project_id = l.project_id
          AND c.template_id = l.checklist_template_id AND c.result = 'failed') AS "checklistsFailed",
        (SELECT count(*)::int FROM qa.test x WHERE x.project_id = l.project_id AND x.kind = l.test_kind) AS "testsDone"
      FROM qa.itp_line l LEFT JOIN qa.checklist_template t ON t.id = l.checklist_template_id
      WHERE l.project_id = ${projectId} ORDER BY l.position`;
    const templates = await db`SELECT id, name FROM qa.checklist_template ORDER BY name`;
    return { lines, templates, mayEdit: a.canEdit };
  }

  async add(claims: TenantClaims, projectId: string, b: ItpInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "The project's lead sets its ITP.",
      });
    if (!b.checklistTemplateId && !b.testKind)
      throw new BadRequestException({
        code: 'nothing_to_check',
        message: 'Name a checklist, a test, or both.',
      });
    await db`
      INSERT INTO qa.itp_line (project_id, position, activity, stage, checklist_template_id, test_kind, frequency,
        hold_point, responsible, created_by)
      VALUES (${projectId},
        (SELECT coalesce(max(position), 0) + 1 FROM qa.itp_line WHERE project_id = ${projectId}),
        ${b.activity}, ${b.stage}, ${b.checklistTemplateId}, ${b.testKind}, ${b.frequency}, ${b.holdPoint},
        ${b.responsible}, ${claims.sub})`;
    return this.list(claims, projectId);
  }

  async remove(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [l] = await db<
      { project_id: string }[]
    >`SELECT project_id FROM qa.itp_line WHERE id = ${id}`;
    if (!l) throw new NotFoundException({ code: 'not_found' });
    const a = await this.projects.access(db, claims, l.project_id);
    if (!a.canEdit) throw new ForbiddenException({ code: 'forbidden' });
    await db`DELETE FROM qa.itp_line WHERE id = ${id}`;
    return this.list(claims, l.project_id);
  }
}
