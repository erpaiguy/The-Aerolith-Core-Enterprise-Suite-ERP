// Document review workflows (docs/wave5-plan.md step 1), on their own engine: the company's status codes, workflow
// templates of stages, and reviews of a document version stage by stage. Each stage's reviewers are found when it
// starts (named people, the project's leads or members, holders of a designation), notified, and reminded before and
// on the due day; a stage closes by its mode and its worst effect moves the review on, back to the author, or ends it.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { stageOutcome, type Effect, type Stage } from './review-rules.js';

type Db = Sql | TransactionSql;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface ReviewRow {
  id: string;
  project_id: string;
  number: string;
  title: string;
  document_id: string;
  version_no: number;
  workflow_id: string;
  stages: Stage[];
  stage: number;
  status: string;
  with_comments: boolean;
  started_by: string;
}

/** Open review tasks waiting on this person (for "waiting on me"). */
export async function waitingReviews(db: Db, claims: TenantClaims) {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM dms.review_task t JOIN dms.review r ON r.id = t.review_id
    WHERE t.user_id = ${claims.sub} AND t.status = 'waiting' AND r.status = 'in_review' AND t.stage = r.stage`;
  return r?.n ?? 0;
}

@Injectable()
export class ReviewService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
  ) {}

  /** Codes and company workflows: whoever edits projects. A project's own workflows: also its lead. */
  private async manager(db: Db, claims: TenantClaims, projectId: string | null) {
    if (projectId) {
      const a = await this.projects.access(db, claims, projectId);
      if (a.canEdit || a.role === 'lead') return;
    } else if (await this.permissions.can(claims, 'projects.edit')) return;
    throw new ForbiddenException({
      code: 'forbidden',
      permission: 'projects.edit',
      message: projectId
        ? "Only the project's lead or a project editor sets its review workflows."
        : 'This needs the projects permission.',
    });
  }

  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team starts reviews.",
      });
    return a;
  }

  // --- status codes ---

  async codes(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT code, label, effect, position, active FROM dms.status_code ORDER BY position, code`;
  }

  async setCode(
    claims: TenantClaims,
    input: { code: string; label: string; effect: Effect; active: boolean },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.manager(db, claims, null);
    await db`
      INSERT INTO dms.status_code (code, label, effect, position, active)
      VALUES (${input.code}, ${input.label}, ${input.effect},
        (SELECT coalesce(max(position), 0) + 1 FROM dms.status_code), ${input.active})
      ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, effect = EXCLUDED.effect, active = EXCLUDED.active`;
    return this.codes(claims);
  }

  // --- workflow templates ---

  async workflows(claims: TenantClaims, projectId: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    if (projectId) await this.projects.access(db, claims, projectId);
    return db`
      SELECT id, project_id AS "projectId", name, stages, active, row_version AS "rowVersion" FROM dms.workflow
      WHERE active AND (project_id IS NULL OR project_id = ${projectId}) ORDER BY project_id NULLS FIRST, name`;
  }

  async saveWorkflow(
    claims: TenantClaims,
    input: {
      id: string | null;
      projectId: string | null;
      name: string;
      stages: Stage[];
      active: boolean;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (input.id) {
      // A workflow keeps its scope: company-wide stays company-wide.
      const [old] = await db<{ project_id: string | null }[]>`
        SELECT project_id FROM dms.workflow WHERE id = ${input.id}`;
      if (!old || old.project_id !== input.projectId)
        throw new NotFoundException({ code: 'not_found', message: 'No such workflow.' });
    }
    await this.manager(db, claims, input.projectId);
    for (const [i, s] of input.stages.entries()) {
      if (!s.reviewers.length)
        throw new BadRequestException({
          code: 'no_reviewers',
          message: `Stage ${i + 1}: who reviews.`,
        });
      for (const r of s.reviewers) {
        if ((r.kind === 'user' || r.kind === 'designation') && !r.id)
          throw new BadRequestException({
            code: 'who',
            message: `Stage ${i + 1}: name the person or designation.`,
          });
        if (r.kind === 'user') {
          const [u] = await db`SELECT 1 FROM platform."user" WHERE id = ${r.id!}`;
          if (!u)
            throw new BadRequestException({
              code: 'no_such_user',
              message: `Stage ${i + 1}: no such person.`,
            });
        }
        if (r.kind === 'designation') {
          const [d] = await db`SELECT 1 FROM hr.designation WHERE id = ${r.id!}`;
          if (!d)
            throw new BadRequestException({
              code: 'no_such_designation',
              message: `Stage ${i + 1}: no such designation.`,
            });
        }
      }
    }
    const [w] = input.id
      ? await db<{ id: string }[]>`
          UPDATE dms.workflow SET name = ${input.name}, stages = ${db.json(input.stages as never)}, active = ${input.active},
            row_version = row_version + 1
          WHERE id = ${input.id} RETURNING id`
      : await db<{ id: string }[]>`
          INSERT INTO dms.workflow (project_id, name, stages, active, created_by)
          VALUES (${input.projectId}, ${input.name}, ${db.json(input.stages as never)}, ${input.active}, ${claims.sub})
          RETURNING id`;
    if (!w) throw new NotFoundException({ code: 'not_found', message: 'No such workflow.' });
    return { id: w.id, workflows: await this.workflows(claims, input.projectId) };
  }

  // --- reviews ---

  /** The people a stage asks, found now. */
  private async resolve(tx: Db, projectId: string, s: Stage) {
    const ids = new Set<string>();
    for (const r of s.reviewers) {
      const rows =
        r.kind === 'user'
          ? await tx<
              { id: string }[]
            >`SELECT id FROM platform."user" WHERE id = ${r.id!} AND status = 'active'`
          : r.kind === 'designation'
            ? await tx<{ id: string }[]>`
                SELECT e.user_id AS id FROM hr.employee e WHERE e.designation_id = ${r.id!} AND e.user_id IS NOT NULL
                  AND (e.left_on IS NULL OR e.left_on >= current_date)`
            : await tx<{ id: string }[]>`
                SELECT m.user_id AS id FROM proj.member m JOIN platform."user" u ON u.id = m.user_id
                WHERE m.project_id = ${projectId} AND m.role = ${r.kind} AND u.status = 'active'`;
      for (const x of rows) ids.add(x.id);
    }
    return [...ids];
  }

  /** Starts a stage: its tasks, due its days from today, with a notice now and reminders before and on the day. */
  private async activate(tx: TransactionSql, r: ReviewRow, stage: number) {
    const s = r.stages[stage]!;
    const users = await this.resolve(tx, r.project_id, s);
    if (!users.length)
      throw new ConflictException({
        code: 'no_reviewers',
        message: `Nobody to review at "${s.name}".`,
      });
    const due = addDays(today(), s.dueDays);
    for (const u of users) {
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO dms.review_task (review_id, stage, user_id, due_on) VALUES (${r.id}, ${stage}, ${u}, ${due})
        RETURNING id`;
      const source = `review-task:${t!.id}`;
      const link = `/reviews/${r.id}`;
      const title = `${r.number} ${r.title}: your review (${s.name}), due ${due}`;
      await tx`INSERT INTO platform.notification (user_id, kind, title, link, source)
        VALUES (${u}, 'review', ${title}, ${link}, ${source})`;
      for (const [day, when] of [
        [addDays(due, -1), 'tomorrow'],
        [due, 'today'],
      ] as const)
        if (day > today())
          await tx`INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
            VALUES (${u}, 'review_due', ${`${r.number} ${r.title}: your review is due ${when}`}, ${link},
              ${new Date(`${day}T09:00:00+05:30`)}, ${source})`;
    }
    await tx`UPDATE dms.review SET stage = ${stage} WHERE id = ${r.id}`;
  }

  /** A material submittal's approval (Wave 3) follows its review's decision. */
  private async decideMaterial(
    tx: TransactionSql,
    claims: TenantClaims,
    reviewId: string,
    status: 'approved' | 'rejected',
    comment: string,
  ) {
    await tx`
      UPDATE qa.material_approval m SET status = ${status}, decided_on = ${today()}, decided_by = ${claims.sub},
        comments = left(concat_ws(' · ', nullif(m.comments, ''),
          'Submittal ' || s.number || coalesce(': ' || nullif(${comment.trim()}, ''), '')), 1000)
      FROM dms.submittal s
      WHERE s.review_id = ${reviewId} AND m.id = s.material_approval_id AND m.status = 'submitted'`;
  }

  private async closeTasks(tx: TransactionSql, reviewId: string) {
    const left = await tx<{ id: string }[]>`
      UPDATE dms.review_task SET status = 'skipped' WHERE review_id = ${reviewId} AND status = 'waiting' RETURNING id`;
    for (const t of left)
      await tx`DELETE FROM platform.notification WHERE source = ${`review-task:${t.id}`} AND read_at IS NULL`;
  }

  async start(
    claims: TenantClaims,
    projectId: string,
    input: { documentId: string; versionNo: number | null; workflowId: string; title: string },
    resubmits: string | null = null,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const [d] = await db<{ version_no: number }[]>`
      SELECT version_no FROM doc.document WHERE id = ${input.documentId} AND project_id = ${projectId} AND deleted_at IS NULL`;
    if (!d)
      throw new NotFoundException({
        code: 'not_found',
        message: "No such document in this project's documents.",
      });
    const version = input.versionNo ?? d.version_no;
    const [v] =
      await db`SELECT 1 FROM doc.document_version WHERE document_id = ${input.documentId} AND version_no = ${version}`;
    if (!v)
      throw new NotFoundException({ code: 'no_such_version', message: `No version ${version}.` });
    const [w] = await db<{ stages: Stage[] }[]>`
      SELECT stages FROM dms.workflow WHERE id = ${input.workflowId} AND active AND (project_id IS NULL OR project_id = ${projectId})`;
    if (!w)
      throw new NotFoundException({
        code: 'no_such_workflow',
        message: 'No such workflow for this project.',
      });
    const id = await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const [open] = await tx`
        SELECT 1 FROM dms.review WHERE document_id = ${input.documentId} AND version_no = ${version} AND status = 'in_review'`;
      if (open)
        throw new ConflictException({
          code: 'in_review',
          message: 'This version is already in review.',
        });
      const [n] = await tx<
        { n: number }[]
      >`SELECT count(*)::int + 1 AS n FROM dms.review WHERE project_id = ${projectId}`;
      const [r] = await tx<ReviewRow[]>`
        INSERT INTO dms.review (project_id, number, title, document_id, version_no, workflow_id, stages, resubmits, started_by)
        VALUES (${projectId}, ${`RV-${String(n!.n).padStart(3, '0')}`}, ${input.title}, ${input.documentId}, ${version},
          ${input.workflowId}, ${tx.json(w.stages as never)}, ${resubmits}, ${claims.sub})
        RETURNING *`;
      // Every stage must have someone now, so a review never stalls halfway for want of a reviewer.
      for (const s of w.stages)
        if (!(await this.resolve(tx, projectId, s)).length)
          throw new ConflictException({
            code: 'no_reviewers',
            message: `Nobody to review at "${s.name}".`,
          });
      await this.activate(tx, r!, 0);
      // A submittal follows its document's resubmission.
      if (resubmits)
        await tx`UPDATE dms.submittal SET review_id = ${r!.id} WHERE review_id = ${resubmits}`;
      await audit(tx, claims.sub, 'review.start', 'review', r!.id, { number: r!.number, version });
      return r!.id;
    });
    return this.get(claims, id);
  }

  /** A reviewer's code and comment; the stage closes by its mode and moves the review on. */
  async respond(claims: TenantClaims, taskId: string, input: { code: string; comment: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t0] = await db<
      { review_id: string }[]
    >`SELECT review_id FROM dms.review_task WHERE id = ${taskId}`;
    if (!t0) throw new NotFoundException({ code: 'not_found', message: 'No such review task.' });
    await db.begin(async (tx) => {
      const [r] = await tx<
        ReviewRow[]
      >`SELECT * FROM dms.review WHERE id = ${t0.review_id} FOR UPDATE`;
      const [t] = await tx<{ user_id: string; stage: number; status: string }[]>`
        SELECT user_id, stage, status FROM dms.review_task WHERE id = ${taskId}`;
      if (t!.user_id !== claims.sub)
        throw new ForbiddenException({
          code: 'not_yours',
          message: 'This review is waiting on someone else.',
        });
      if (t!.status !== 'waiting' || r!.status !== 'in_review' || t!.stage !== r!.stage)
        throw new ConflictException({ code: 'answered', message: 'This review task is closed.' });
      const [c] = await tx<
        { effect: Effect }[]
      >`SELECT effect FROM dms.status_code WHERE code = ${input.code} AND active`;
      if (!c) throw new BadRequestException({ code: 'bad_code', message: 'Choose a status code.' });
      if (
        (c.effect === 'return' || c.effect === 'reject' || c.effect === 'approve_comments') &&
        !input.comment.trim()
      )
        throw new BadRequestException({
          code: 'comment_needed',
          message: 'Say why, or what to change.',
        });
      await tx`UPDATE dms.review_task SET status = 'done', code = ${input.code}, comment = ${input.comment},
          responded_at = now() WHERE id = ${taskId}`;
      await tx`DELETE FROM platform.notification WHERE source = ${`review-task:${taskId}`} AND read_at IS NULL`;
      const tasks = await tx<{ effect: Effect | null }[]>`
        SELECT s.effect FROM dms.review_task k LEFT JOIN dms.status_code s ON s.code = k.code
        WHERE k.review_id = ${r!.id} AND k.stage = ${r!.stage}
        ORDER BY k.responded_at NULLS LAST, k.id`;
      const stage = r!.stages[r!.stage]!;
      const outcome = stageOutcome(
        stage.mode,
        tasks.map((x) => x.effect),
      );
      if (outcome === null) return;
      await this.closeTasks(tx, r!.id);
      const notifyAuthor = async (title: string) =>
        tx`INSERT INTO platform.notification (user_id, kind, title, link)
          VALUES (${r!.started_by}, 'review_result', ${title}, ${`/reviews/${r!.id}`})`;
      if (outcome === 'return' || outcome === 'reject') {
        await tx`UPDATE dms.review SET status = ${outcome === 'return' ? 'returned' : 'rejected'}, closed_at = now(),
            row_version = row_version + 1 WHERE id = ${r!.id}`;
        if (outcome === 'reject')
          await this.decideMaterial(tx, claims, r!.id, 'rejected', input.comment);
        await notifyAuthor(
          `${r!.number} ${r!.title}: ${outcome === 'return' ? 'returned for revision' : 'rejected'} at ${stage.name}`,
        );
      } else {
        const comments = r!.with_comments || outcome === 'approve_comments';
        if (r!.stage + 1 >= r!.stages.length) {
          await tx`UPDATE dms.review SET status = 'approved', with_comments = ${comments}, closed_at = now(),
              row_version = row_version + 1 WHERE id = ${r!.id}`;
          await this.decideMaterial(tx, claims, r!.id, 'approved', input.comment);
          await notifyAuthor(
            `${r!.number} ${r!.title}: approved${comments ? ' with comments' : ''}`,
          );
        } else {
          await tx`UPDATE dms.review SET with_comments = ${comments}, row_version = row_version + 1 WHERE id = ${r!.id}`;
          await this.activate(tx, r!, r!.stage + 1);
        }
      }
      await audit(tx, claims.sub, 'review.respond', 'review', r!.id, {
        code: input.code,
        stage: r!.stage,
      });
    });
    return this.get(claims, t0.review_id);
  }

  async withdraw(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.row(db, id);
    const a = await this.projects.access(db, claims, r.project_id);
    if (r.started_by !== claims.sub && a.role !== 'lead' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Whoever started the review (or the lead) withdraws it.',
      });
    await db.begin(async (tx) => {
      const [x] = await tx<
        { status: string }[]
      >`SELECT status FROM dms.review WHERE id = ${id} FOR UPDATE`;
      if (x!.status !== 'in_review')
        throw new ConflictException({
          code: 'closed',
          message: 'Only a review in progress is withdrawn.',
        });
      await this.closeTasks(tx, id);
      await tx`UPDATE dms.review SET status = 'withdrawn', closed_at = now(), row_version = row_version + 1 WHERE id = ${id}`;
    });
    return this.get(claims, id);
  }

  /** A returned review sent round again on a newer version: a new review of the same workflow, linked to this one. */
  async resubmit(claims: TenantClaims, id: string, versionNo: number | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.row(db, id);
    if (r.status !== 'returned')
      throw new ConflictException({
        code: 'not_returned',
        message: 'Only a returned review is resubmitted.',
      });
    const [d] = await db<
      { version_no: number }[]
    >`SELECT version_no FROM doc.document WHERE id = ${r.document_id}`;
    const version = versionNo ?? d!.version_no;
    if (version <= r.version_no)
      throw new BadRequestException({
        code: 'same_version',
        message: 'Upload the revised version first.',
      });
    return this.start(
      claims,
      r.project_id,
      { documentId: r.document_id, versionNo: version, workflowId: r.workflow_id, title: r.title },
      id,
    );
  }

  private async row(db: Db, id: string) {
    const [r] = await db<ReviewRow[]>`SELECT * FROM dms.review WHERE id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'not_found', message: 'No such review.' });
    return r;
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.row(db, id);
    await this.projects.access(db, claims, r.project_id);
    const [doc] = await db<
      { name: string }[]
    >`SELECT name FROM doc.document WHERE id = ${r.document_id}`;
    const tasks = await db`
      SELECT t.id, t.stage, u.display_name AS reviewer, t.user_id AS "userId", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn",
        t.status, t.code, t.comment, t.responded_at AS "respondedAt",
        t.status = 'waiting' AND t.due_on < ${today()}::date AS overdue
      FROM dms.review_task t JOIN platform."user" u ON u.id = t.user_id
      WHERE t.review_id = ${id} ORDER BY t.stage, t.responded_at NULLS LAST, u.display_name`;
    return {
      id: r.id,
      projectId: r.project_id,
      number: r.number,
      title: r.title,
      document: { id: r.document_id, name: doc?.name ?? '', versionNo: r.version_no },
      stages: r.stages.map((s) => ({ name: s.name, mode: s.mode, dueDays: s.dueDays })),
      stage: r.stage,
      status: r.status,
      withComments: r.with_comments,
      tasks,
      mine: tasks
        .filter((t) => t.userId === claims.sub && t.status === 'waiting' && t.stage === r.stage)
        .map((t) => t.id),
      mayWithdraw: r.status === 'in_review' && r.started_by === claims.sub,
    };
  }

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return db`
      SELECT r.id, r.number, r.title, d.name AS document, r.version_no AS "versionNo", r.status, r.with_comments AS "withComments",
        r.stage, r.stages -> r.stage ->> 'name' AS "stageName", to_char(r.started_at, 'YYYY-MM-DD') AS "startedOn",
        (SELECT string_agg(u.display_name, ', ' ORDER BY u.display_name) FROM dms.review_task t
          JOIN platform."user" u ON u.id = t.user_id WHERE t.review_id = r.id AND t.status = 'waiting') AS "waitingOn"
      FROM dms.review r JOIN doc.document d ON d.id = r.document_id
      WHERE r.project_id = ${projectId} ORDER BY r.started_at DESC`;
  }

  /** The reviews waiting on me, across projects. */
  async mine(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT t.id AS "taskId", r.id AS "reviewId", r.number, r.title, p.number AS project, d.name AS document,
        r.version_no AS "versionNo", r.stages -> r.stage ->> 'name' AS "stageName", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn",
        t.due_on < ${today()}::date AS overdue
      FROM dms.review_task t JOIN dms.review r ON r.id = t.review_id AND t.stage = r.stage
      JOIN doc.document d ON d.id = r.document_id JOIN proj.project p ON p.id = r.project_id
      WHERE t.user_id = ${claims.sub} AND t.status = 'waiting' AND r.status = 'in_review'
      ORDER BY t.due_on, r.number`;
  }
}
