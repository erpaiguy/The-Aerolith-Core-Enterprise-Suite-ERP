// RFIs and submittals (docs/wave5-plan.md step 3). An RFI is a question from site with its references, assigned to one
// person with a due day (noticed and reminded), answered, and what came of it: a variation or a revised drawing.
// A submittal is sent for approval through a review (step 1) and takes its status from it; a material submittal's
// material approval (Wave 3) follows the review's decision (ReviewService).
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { ReviewService } from './review.service.js';

type Db = Sql | TransactionSql;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Kind = 'shop_drawing' | 'method_statement' | 'material' | 'sample' | 'other';

@Injectable()
export class RfiService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly reviews: ReviewService,
  ) {}

  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team raises RFIs and submittals.",
      });
    return a;
  }

  /** A version of a document in this project's vault (the latest when none is named). */
  private async version(db: Db, projectId: string, documentId: string, versionNo: number | null) {
    const [d] = await db<{ version_no: number }[]>`
      SELECT version_no FROM doc.document WHERE id = ${documentId} AND project_id = ${projectId} AND deleted_at IS NULL`;
    if (!d)
      throw new NotFoundException({
        code: 'no_such_document',
        message: "No such document in this project's documents.",
      });
    const v = versionNo ?? d.version_no;
    const [x] =
      await db`SELECT 1 FROM doc.document_version WHERE document_id = ${documentId} AND version_no = ${v}`;
    if (!x) throw new NotFoundException({ code: 'no_such_version', message: `No version ${v}.` });
    return v;
  }

  // --- RFIs ---

  async rfis(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return this.rfiRows(db, db`r.project_id = ${projectId}`);
  }

  private rfiRows(db: Db, where: ReturnType<Db>) {
    return db`
      SELECT r.id, r.project_id AS "projectId", r.number, r.subject, r.question, r.document_id AS "documentId",
        d.name AS document, r.version_no AS "versionNo", r.location, r.reference,
        r.assigned_to AS "assignedToId", a.display_name AS "assignedTo", to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn",
        r.status, r.answer, r.answer_document_id AS "answerDocumentId", ad.name AS "answerDocument",
        r.answered_at AS "answeredAt", an.display_name AS "answeredBy", r.outcome, r.variation_id AS "variationId",
        v.number AS variation, r.revised_document_id AS "revisedDocumentId", rd.name AS "revisedDocument",
        r.revised_version_no AS "revisedVersionNo", to_char(r.raised_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "raisedOn",
        rb.display_name AS "raisedBy", r.status = 'open' AND r.due_on < ${today()}::date AS overdue, r.row_version AS "rowVersion"
      FROM dms.rfi r JOIN platform."user" a ON a.id = r.assigned_to JOIN platform."user" rb ON rb.id = r.raised_by
      LEFT JOIN platform."user" an ON an.id = r.answered_by
      LEFT JOIN doc.document d ON d.id = r.document_id LEFT JOIN doc.document ad ON ad.id = r.answer_document_id
      LEFT JOIN doc.document rd ON rd.id = r.revised_document_id LEFT JOIN ctl.variation v ON v.id = r.variation_id
      WHERE ${where} ORDER BY r.number DESC`;
  }

  private async rfi(db: Db, id: string) {
    const [r] = await this.rfiRows(db, db`r.id = ${id}`);
    if (!r) throw new NotFoundException({ code: 'not_found', message: 'No such RFI.' });
    return r as typeof r & {
      projectId: string;
      status: string;
      assignedToId: string;
      raisedBy: string;
    };
  }

  async raise(
    claims: TenantClaims,
    projectId: string,
    input: {
      subject: string;
      question: string;
      documentId: string | null;
      versionNo: number | null;
      location: string;
      reference: string;
      assignedTo: string;
      dueDays: number;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const versionNo = input.documentId
      ? await this.version(db, projectId, input.documentId, input.versionNo)
      : null;
    const [u] = await db`
      SELECT 1 FROM proj.member m JOIN platform."user" u ON u.id = m.user_id
      WHERE m.project_id = ${projectId} AND m.user_id = ${input.assignedTo} AND u.status = 'active'`;
    if (!u)
      throw new BadRequestException({
        code: 'not_on_project',
        message: 'Assign the RFI to someone on the project.',
      });
    const due = addDays(today(), input.dueDays);
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`rfi:${projectId}`}))`;
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int + 1 AS n FROM dms.rfi WHERE project_id = ${projectId}`;
      const number = `RFI-${String(n!.n).padStart(3, '0')}`;
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO dms.rfi ${tx({
          project_id: projectId,
          number,
          subject: input.subject,
          question: input.question,
          document_id: input.documentId,
          version_no: versionNo,
          location: input.location,
          reference: input.reference,
          assigned_to: input.assignedTo,
          due_on: due,
          raised_by: claims.sub,
        })} RETURNING id`;
      const source = `rfi:${r!.id}`;
      const link = `/transmittals?project=${projectId}&tab=rfis`;
      await tx`INSERT INTO platform.notification (user_id, kind, title, link, source)
        VALUES (${input.assignedTo}, 'rfi', ${`${number} ${input.subject}: an RFI for you, due ${due}`}, ${link}, ${source})`;
      for (const [day, when] of [
        [addDays(due, -1), 'tomorrow'],
        [due, 'today'],
      ] as const)
        if (new Date(`${day}T09:00:00+05:30`) > new Date())
          await tx`INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
            VALUES (${input.assignedTo}, 'rfi_due', ${`${number} ${input.subject}: the answer is due ${when}`}, ${link},
              ${new Date(`${day}T09:00:00+05:30`)}, ${source})`;
      await audit(tx, claims.sub, 'rfi.raise', 'rfi', r!.id, { number });
      return r!.id;
    });
    return this.rfi(db, id);
  }

  /** The answer, by the assignee or the project's lead; an attachment from the vault. */
  async answer(
    claims: TenantClaims,
    id: string,
    input: { answer: string; documentId: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.rfi(db, id);
    const a = await this.projects.access(db, claims, r.projectId);
    if (r.assignedToId !== claims.sub && a.role !== 'lead' && !a.canEdit)
      throw new ForbiddenException({
        code: 'not_yours',
        message: "The RFI's assignee or the project's lead answers it.",
      });
    if (r.status !== 'open')
      throw new ConflictException({ code: 'answered', message: 'This RFI is already answered.' });
    if (input.documentId) await this.version(db, r.projectId, input.documentId, null);
    await db.begin(async (tx) => {
      await tx`
        UPDATE dms.rfi SET status = 'answered', answer = ${input.answer}, answer_document_id = ${input.documentId},
          answered_at = now(), answered_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id}`;
      await tx`DELETE FROM platform.notification WHERE source = ${`rfi:${id}`} AND read_at IS NULL`;
      const [raiser] = await tx<
        { raised_by: string }[]
      >`SELECT raised_by FROM dms.rfi WHERE id = ${id}`;
      await tx`INSERT INTO platform.notification (user_id, kind, title, link)
        VALUES (${raiser!.raised_by}, 'rfi_answered', ${`${r.number as string} answered`},
          ${`/transmittals?project=${r.projectId}&tab=rfis`})`;
      await audit(tx, claims.sub, 'rfi.answer', 'rfi', id, {});
    });
    return this.rfi(db, id);
  }

  /** What came of it (a variation of this project, or a newer version of a drawing), and closing it. */
  async outcome(
    claims: TenantClaims,
    id: string,
    input: {
      outcome: 'none' | 'variation' | 'revision';
      variationId: string | null;
      documentId: string | null;
      versionNo: number | null;
      close: boolean;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.rfi(db, id);
    await this.team(db, claims, r.projectId);
    if (r.status === 'open' && input.close)
      throw new ConflictException({ code: 'not_answered', message: 'Answer the RFI first.' });
    if (r.status === 'closed')
      throw new ConflictException({ code: 'closed', message: 'This RFI is closed.' });
    let variationId: string | null = null;
    let revised: { id: string; v: number } | null = null;
    if (input.outcome === 'variation') {
      const [v] = await db`
        SELECT 1 FROM ctl.variation WHERE id = ${input.variationId ?? '00000000-0000-0000-0000-000000000000'}
          AND project_id = ${r.projectId}`;
      if (!v)
        throw new NotFoundException({
          code: 'no_such_variation',
          message: 'No such variation on this project.',
        });
      variationId = input.variationId;
    }
    if (input.outcome === 'revision') {
      if (!input.documentId)
        throw new BadRequestException({
          code: 'which_drawing',
          message: 'Name the revised drawing.',
        });
      revised = {
        id: input.documentId,
        v: await this.version(db, r.projectId, input.documentId, input.versionNo),
      };
    }
    await db.begin(async (tx) => {
      await tx`
        UPDATE dms.rfi SET outcome = ${input.outcome}, variation_id = ${variationId},
          revised_document_id = ${revised?.id ?? null}, revised_version_no = ${revised?.v ?? null},
          status = CASE WHEN ${input.close} THEN 'closed' ELSE status END,
          closed_at = CASE WHEN ${input.close} THEN now() ELSE closed_at END, row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'rfi.outcome', 'rfi', id, {
        outcome: input.outcome,
        close: input.close,
      });
    });
    return this.rfi(db, id);
  }

  // --- submittals ---

  async submittals(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return this.submittalRows(db, db`s.project_id = ${projectId}`);
  }

  private submittalRows(db: Db, where: ReturnType<Db>) {
    return db`
      SELECT s.id, s.number, s.kind, s.title, s.review_id AS "reviewId", r.number AS review, r.status,
        r.with_comments AS "withComments", d.name AS document, r.version_no AS "versionNo",
        s.material_approval_id AS "materialApprovalId", ma.make AS "materialMake", ma.status AS "materialStatus",
        to_char(s.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "submittedOn",
        (SELECT min(t.due_on) FROM dms.review_task t WHERE t.review_id = r.id AND t.status = 'waiting') < ${today()}::date
          AS overdue
      FROM dms.submittal s JOIN dms.review r ON r.id = s.review_id JOIN doc.document d ON d.id = r.document_id
      LEFT JOIN qa.material_approval ma ON ma.id = s.material_approval_id
      WHERE ${where} ORDER BY s.number DESC`;
  }

  /** A submittal: its review started on the document version, numbered SUB-001… */
  async submit(
    claims: TenantClaims,
    projectId: string,
    input: {
      kind: Kind;
      title: string;
      documentId: string;
      versionNo: number | null;
      workflowId: string;
      materialApprovalId: string | null;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    if (input.materialApprovalId) {
      if (input.kind !== 'material')
        throw new BadRequestException({
          code: 'not_material',
          message: 'Only a material submittal carries a material approval.',
        });
      const [m] = await db<{ status: string }[]>`
        SELECT status FROM qa.material_approval WHERE id = ${input.materialApprovalId} AND project_id = ${projectId}`;
      if (!m)
        throw new NotFoundException({
          code: 'no_such_material_approval',
          message: 'No such material approval on this project.',
        });
      if (m.status !== 'submitted')
        throw new ConflictException({
          code: 'decided',
          message: 'That material approval is already decided.',
        });
    }
    const review = await this.reviews.start(claims, projectId, {
      documentId: input.documentId,
      versionNo: input.versionNo,
      workflowId: input.workflowId,
      title: input.title,
    });
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`submittal:${projectId}`}))`;
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int + 1 AS n FROM dms.submittal WHERE project_id = ${projectId}`;
      const number = `SUB-${String(n!.n).padStart(3, '0')}`;
      const [s] = await tx<{ id: string }[]>`
        INSERT INTO dms.submittal ${tx({
          project_id: projectId,
          number,
          kind: input.kind,
          title: input.title,
          review_id: review.id,
          material_approval_id: input.materialApprovalId,
          created_by: claims.sub,
        })} RETURNING id`;
      await audit(tx, claims.sub, 'submittal.create', 'submittal', s!.id, {
        number,
        review: review.number,
      });
      return s!.id;
    });
    const [row] = await this.submittalRows(db, db`s.id = ${id}`);
    return row!;
  }
}
