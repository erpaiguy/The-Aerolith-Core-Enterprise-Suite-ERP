// Master document list (docs/wave7-plan.md step 7d.3): what a project expects, from whom and by when; marked received
// with its date (and the file, from the project's documents). Late: still to come after its planned date.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export interface ExpectedInput {
  code: string;
  title: string;
  category: string;
  fromParty: string;
  plannedOn: string;
}

@Injectable()
export class MdlService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  private async mayWrite(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team keeps its document list.",
      });
    return db;
  }

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    const rows = await db`
      SELECT e.id, e.code, e.title, e.category, e.from_party AS "fromParty",
        to_char(e.planned_on, 'YYYY-MM-DD') AS "plannedOn", to_char(e.received_on, 'YYYY-MM-DD') AS "receivedOn",
        e.document_id AS "documentId", d.name AS document, e.note,
        CASE WHEN e.received_on IS NOT NULL THEN e.received_on - e.planned_on
          ELSE (now() AT TIME ZONE 'Asia/Kolkata')::date - e.planned_on END AS "daysLate",
        e.received_on IS NULL AND e.planned_on < (now() AT TIME ZONE 'Asia/Kolkata')::date AS late
      FROM proj.expected_document e LEFT JOIN doc.document d ON d.id = e.document_id
      WHERE e.project_id = ${projectId} ORDER BY e.planned_on, e.code`;
    const n = (p: (r: (typeof rows)[number]) => boolean) => rows.filter(p).length;
    return {
      rows,
      totals: {
        expected: rows.length,
        received: n((r) => r.receivedOn !== null),
        late: n((r) => r.late === true),
        receivedLate: n((r) => r.receivedOn !== null && Number(r.daysLate) > 0),
      },
      mayWrite: a.canEdit || a.role === 'member',
    };
  }

  /** One or many expected documents at once (a list pasted from the contract's schedule). */
  async add(claims: TenantClaims, projectId: string, items: ExpectedInput[]) {
    const db = await this.mayWrite(claims, projectId);
    if (new Set(items.map((i) => i.code.toLowerCase())).size !== items.length)
      throw new BadRequestException({
        code: 'duplicate_code',
        message: 'Each document code once.',
      });
    await db
      .begin(async (tx) => {
        for (const i of items)
          await tx`
            INSERT INTO proj.expected_document (project_id, code, title, category, from_party, planned_on, created_by)
            VALUES (${projectId}, ${i.code}, ${i.title}, ${i.category}, ${i.fromParty}, ${i.plannedOn}, ${claims.sub})`;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'code_taken',
            message: 'A document with that code is already listed.',
          });
        throw err;
      });
    return this.list(claims, projectId);
  }

  async receive(
    claims: TenantClaims,
    id: string,
    b: { receivedOn: string; documentId: string | null; note: string },
  ) {
    const db0 = await this.tenants.forTenant(claims.ten);
    const [e] = await db0<
      { project_id: string }[]
    >`SELECT project_id FROM proj.expected_document WHERE id = ${id}`;
    if (!e) throw new NotFoundException({ code: 'not_found' });
    const db = await this.mayWrite(claims, e.project_id);
    if (b.documentId) {
      const [d] =
        await db`SELECT 1 FROM doc.document WHERE id = ${b.documentId} AND project_id = ${e.project_id}`;
      if (!d) throw new BadRequestException({ code: 'not_this_project' });
    }
    await db`
      UPDATE proj.expected_document SET received_on = ${b.receivedOn}, document_id = ${b.documentId}, note = ${b.note}
      WHERE id = ${id}`;
    return this.list(claims, e.project_id);
  }
}
