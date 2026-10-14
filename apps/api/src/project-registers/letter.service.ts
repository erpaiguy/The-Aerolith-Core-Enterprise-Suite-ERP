// Correspondence register (docs/wave7-plan.md step 7d.2): a project's letters in (IN-001…) and out (OUT-001…), with
// the other side's reference, the letter answered, a reply owed by a date, and the scan from the project's documents.
// A letter that needs no more is closed; answering one closes it.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export interface LetterInput {
  direction: 'in' | 'out';
  letterDate: string;
  party: string;
  reference: string;
  subject: string;
  summary: string;
  replyTo: string | null;
  replyBy: string | null;
  documentId: string | null;
}

@Injectable()
export class LetterService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  async list(claims: TenantClaims, projectId: string, direction?: 'in' | 'out') {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    const letters = await db`
      SELECT l.id, l.direction, l.number, to_char(l.letter_date, 'YYYY-MM-DD') AS "letterDate", l.party, l.reference,
        l.subject, l.summary, l.status, to_char(l.reply_by, 'YYYY-MM-DD') AS "replyBy",
        l.status = 'open' AND l.reply_by < (now() AT TIME ZONE 'Asia/Kolkata')::date AS overdue,
        r.number AS "replyToNumber", d.name AS document, l.document_id AS "documentId",
        (SELECT x.number FROM proj.letter x WHERE x.reply_to = l.id ORDER BY x.letter_date LIMIT 1) AS "answeredBy"
      FROM proj.letter l LEFT JOIN proj.letter r ON r.id = l.reply_to LEFT JOIN doc.document d ON d.id = l.document_id
      WHERE l.project_id = ${projectId} ${direction ? db`AND l.direction = ${direction}` : db``}
      ORDER BY l.letter_date DESC, l.number DESC`;
    return { letters, mayWrite: a.canEdit || a.role === 'member' };
  }

  async create(claims: TenantClaims, projectId: string, b: LetterInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team keeps its letters.",
      });
    if (b.replyTo) {
      const [r] =
        await db`SELECT 1 FROM proj.letter WHERE id = ${b.replyTo} AND project_id = ${projectId}`;
      if (!r)
        throw new BadRequestException({
          code: 'not_this_project',
          message: 'Answer a letter of this project.',
        });
    }
    if (b.documentId) {
      const [d] =
        await db`SELECT 1 FROM doc.document WHERE id = ${b.documentId} AND project_id = ${projectId}`;
      if (!d)
        throw new BadRequestException({
          code: 'not_this_project',
          message: "Attach one of the project's documents.",
        });
    }
    await db.begin(async (tx) => {
      const [c] = await tx<{ n: number }[]>`
        SELECT count(*)::int + 1 AS n FROM proj.letter WHERE project_id = ${projectId} AND direction = ${b.direction}`;
      const number = `${b.direction === 'in' ? 'IN' : 'OUT'}-${String(c!.n).padStart(3, '0')}`;
      await tx`
        INSERT INTO proj.letter (project_id, direction, number, letter_date, party, reference, subject, summary,
          reply_to, reply_by, document_id, created_by)
        VALUES (${projectId}, ${b.direction}, ${number}, ${b.letterDate}, ${b.party}, ${b.reference}, ${b.subject},
          ${b.summary}, ${b.replyTo}, ${b.replyBy}, ${b.documentId}, ${claims.sub})`;
      // Answering a letter settles it.
      if (b.replyTo) await tx`UPDATE proj.letter SET status = 'closed' WHERE id = ${b.replyTo}`;
    });
    return this.list(claims, projectId);
  }

  async close(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [l] = await db<
      { project_id: string }[]
    >`SELECT project_id FROM proj.letter WHERE id = ${id}`;
    if (!l) throw new NotFoundException({ code: 'not_found' });
    const a = await this.projects.access(db, claims, l.project_id);
    if (!a.canEdit && a.role !== 'member') throw new ForbiddenException({ code: 'forbidden' });
    await db`UPDATE proj.letter SET status = 'closed' WHERE id = ${id}`;
    return this.list(claims, l.project_id);
  }
}
