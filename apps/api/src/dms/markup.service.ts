// Mark-up and comments (docs/wave5-plan.md step 2): comments on a project document's version, numbered per version,
// on a page with an optional highlight box kept as fractions of the page; replies in order; resolved and reopened.
// A comment may belong to a review: while it is open new comments join it, once it closes they are frozen (replies
// and resolving go on, that is the author's response). The comment sheet is the review's comments as an Excel file.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { reportXlsx } from '../procurement/procurement-report-excel.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MarkupRow {
  id: string;
  document_id: string;
  version_no: number;
  review_id: string | null;
  author_id: string;
  status: 'open' | 'resolved';
}

@Injectable()
export class MarkupService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  /** The document's project, checked for this person; 404 when it is not a project's or they are not on it. */
  private async project(db: Db, claims: TenantClaims, documentId: string) {
    const [d] = await db<{ project_id: string | null; name: string }[]>`
      SELECT project_id, name FROM doc.document WHERE id = ${documentId} AND deleted_at IS NULL`;
    if (!d?.project_id)
      throw new NotFoundException({ code: 'not_found', message: 'No such project document.' });
    const a = await this.projects.access(db, claims, d.project_id);
    return { projectId: d.project_id, name: d.name, lead: a.canEdit || a.role === 'lead' };
  }

  private async version(db: Db, documentId: string, versionNo: number) {
    const [v] =
      await db`SELECT 1 FROM doc.document_version WHERE document_id = ${documentId} AND version_no = ${versionNo}`;
    if (!v)
      throw new NotFoundException({ code: 'no_such_version', message: `No version ${versionNo}.` });
  }

  /** A version's comments with their replies, numbered in order. */
  async list(claims: TenantClaims, documentId: string, versionNo: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const { lead } = await this.project(db, claims, documentId);
    await this.version(db, documentId, versionNo);
    return this.rows(
      db,
      claims,
      db`m.document_id = ${documentId} AND m.version_no = ${versionNo}`,
      lead,
    );
  }

  /** `lead`: the project's lead or a project editor, who may resolve any comment. */
  private async rows(db: Db, claims: TenantClaims, where: ReturnType<Db>, lead: boolean) {
    const marks = await db<
      {
        id: string;
        number: number;
        reviewId: string | null;
        review: string | null;
        reviewOpen: boolean;
        page: number;
        x: string | null;
        y: string | null;
        w: string | null;
        h: string | null;
        body: string;
        authorId: string;
        author: string;
        createdAt: Date;
        status: string;
        resolvedBy: string | null;
        resolvedAt: Date | null;
        rowVersion: number;
        reviewAuthor: string | null;
      }[]
    >`
      SELECT m.id, m.number, m.review_id AS "reviewId", r.number AS review, coalesce(r.status = 'in_review', false) AS "reviewOpen",
        m.page, m.x, m.y, m.w, m.h, m.body, m.author_id AS "authorId", u.display_name AS author, m.created_at AS "createdAt",
        m.status, ru.display_name AS "resolvedBy", m.resolved_at AS "resolvedAt", m.row_version AS "rowVersion",
        r.started_by AS "reviewAuthor"
      FROM dms.markup m JOIN platform."user" u ON u.id = m.author_id
      LEFT JOIN platform."user" ru ON ru.id = m.resolved_by
      LEFT JOIN dms.review r ON r.id = m.review_id
      WHERE ${where} ORDER BY m.number`;
    const ids = marks.map((m) => m.id);
    const replies = ids.length
      ? await db<{ id: string; markupId: string; body: string; author: string; createdAt: Date }[]>`
          SELECT x.id, x.markup_id AS "markupId", x.body, u.display_name AS author, x.created_at AS "createdAt"
          FROM dms.markup_reply x JOIN platform."user" u ON u.id = x.author_id
          WHERE x.markup_id IN ${db(ids)} ORDER BY x.created_at, x.id`
      : [];
    return marks.map(({ x, y, w, h, reviewAuthor, authorId, ...m }) => ({
      ...m,
      box: x === null ? null : { x: Number(x), y: Number(y), w: Number(w), h: Number(h) },
      mine: authorId === claims.sub,
      mayResolve: lead || authorId === claims.sub || reviewAuthor === claims.sub,
      replies: replies.filter((r) => r.markupId === m.id).map(({ markupId: _, ...r }) => r),
    }));
  }

  async add(
    claims: TenantClaims,
    documentId: string,
    versionNo: number,
    input: { reviewId: string | null; page: number; box: Box | null; body: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const { projectId, lead } = await this.project(db, claims, documentId);
    await this.version(db, documentId, versionNo);
    if (input.box) {
      const b = input.box;
      if (
        input.page < 1 ||
        b.x < 0 ||
        b.y < 0 ||
        b.w <= 0 ||
        b.h <= 0 ||
        b.x + b.w > 1 ||
        b.y + b.h > 1
      )
        throw new BadRequestException({
          code: 'box_outside_page',
          message: 'The box must lie on a page.',
        });
    }
    if (input.reviewId) {
      const [r] = await db<{ status: string; document_id: string; version_no: number }[]>`
        SELECT status, document_id, version_no FROM dms.review WHERE id = ${input.reviewId} AND project_id = ${projectId}`;
      if (!r || r.document_id !== documentId || r.version_no !== versionNo)
        throw new NotFoundException({
          code: 'no_such_review',
          message: 'No such review of this version.',
        });
      if (r.status !== 'in_review')
        throw new ConflictException({
          code: 'review_closed',
          message: 'The review is closed; its comments can be answered, not added to.',
        });
    }
    // Rounded to the column's five places, then kept inside the page.
    const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
    const box = input.box && {
      x: r5(input.box.x),
      y: r5(input.box.y),
      w: Math.min(r5(input.box.w), 1 - r5(input.box.x)),
      h: Math.min(r5(input.box.h), 1 - r5(input.box.y)),
    };
    const id = await db.begin(async (tx) => {
      // Numbers per version, one writer at a time.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`markup:${documentId}:${versionNo}`}))`;
      const [m] = await tx<{ id: string; number: number }[]>`
        INSERT INTO dms.markup (document_id, version_no, number, review_id, page, x, y, w, h, body, author_id)
        VALUES (${documentId}, ${versionNo},
          (SELECT coalesce(max(number), 0) + 1 FROM dms.markup WHERE document_id = ${documentId} AND version_no = ${versionNo}),
          ${input.reviewId}, ${input.page}, ${box?.x ?? null}, ${box?.y ?? null}, ${box?.w ?? null}, ${box?.h ?? null},
          ${input.body}, ${claims.sub})
        RETURNING id, number`;
      await audit(tx, claims.sub, 'markup.add', 'markup', m!.id, {
        documentId,
        versionNo,
        number: m!.number,
      });
      return m!.id;
    });
    return this.one(db, claims, id, lead);
  }

  private async row(db: Db, claims: TenantClaims, id: string) {
    const [m] = await db<MarkupRow[]>`
      SELECT id, document_id, version_no, review_id, author_id, status FROM dms.markup WHERE id = ${id}`;
    if (!m) throw new NotFoundException({ code: 'not_found', message: 'No such comment.' });
    const { lead } = await this.project(db, claims, m.document_id);
    return { ...m, lead };
  }

  private async one(db: Db, claims: TenantClaims, id: string, lead: boolean) {
    const [m] = await this.rows(db, claims, db`m.id = ${id}`, lead);
    return m!;
  }

  async reply(claims: TenantClaims, id: string, body: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const m = await this.row(db, claims, id);
    await db.begin(async (tx) => {
      const [x] = await tx<{ id: string }[]>`
        INSERT INTO dms.markup_reply (markup_id, body, author_id) VALUES (${m.id}, ${body}, ${claims.sub}) RETURNING id`;
      await audit(tx, claims.sub, 'markup.reply', 'markup', m.id, { replyId: x!.id });
    });
    return this.one(db, claims, id, m.lead);
  }

  /** Resolve or reopen: the comment's author, the review's author, the project's lead or a project editor. */
  async setStatus(claims: TenantClaims, id: string, status: 'open' | 'resolved') {
    const db = await this.tenants.forTenant(claims.ten);
    const m = await this.row(db, claims, id);
    const [r] = m.review_id
      ? await db<
          { started_by: string }[]
        >`SELECT started_by FROM dms.review WHERE id = ${m.review_id}`
      : [];
    if (m.author_id !== claims.sub && r?.started_by !== claims.sub && !m.lead)
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          "Only the comment's author, the review's author or the project's lead resolves it.",
      });
    if (m.status !== status)
      await db.begin(async (tx) => {
        await tx`
          UPDATE dms.markup SET status = ${status},
            resolved_by = ${status === 'resolved' ? claims.sub : null},
            resolved_at = ${status === 'resolved' ? tx`now()` : null},
            row_version = row_version + 1
          WHERE id = ${id}`;
        await audit(
          tx,
          claims.sub,
          `markup.${status === 'resolved' ? 'resolve' : 'reopen'}`,
          'markup',
          id,
          {},
        );
      });
    return this.one(db, claims, id, m.lead);
  }

  /** A review's comments, for the comment sheet and the review's count. */
  async forReview(claims: TenantClaims, reviewId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db<
      {
        project_id: string;
        number: string;
        title: string;
        document_id: string;
        version_no: number;
        status: string;
        with_comments: boolean;
      }[]
    >`SELECT project_id, number, title, document_id, version_no, status, with_comments FROM dms.review WHERE id = ${reviewId}`;
    if (!r) throw new NotFoundException({ code: 'not_found', message: 'No such review.' });
    const a = await this.projects.access(db, claims, r.project_id);
    const [d] = await db<{ name: string; project: string }[]>`
      SELECT d.name, p.number || ' ' || p.name AS project FROM doc.document d JOIN proj.project p ON p.id = d.project_id
      WHERE d.id = ${r.document_id}`;
    const codes = await db<{ reviewer: string; code: string }[]>`
      SELECT u.display_name AS reviewer, t.code FROM dms.review_task t JOIN platform."user" u ON u.id = t.user_id
      WHERE t.review_id = ${reviewId} AND t.status = 'done' ORDER BY t.stage, t.responded_at`;
    return {
      review: r,
      document: d!,
      codes,
      comments: await this.rows(
        db,
        claims,
        db`m.review_id = ${reviewId}`,
        a.canEdit || a.role === 'lead',
      ),
    };
  }

  async sheet(claims: TenantClaims, reviewId: string) {
    const s = await this.forReview(claims, reviewId);
    const day = (t: Date) => t.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    type C = (typeof s.comments)[number];
    const status =
      s.review.status === 'approved' && s.review.with_comments
        ? 'approved with comments'
        : s.review.status.replace('_', ' ');
    return {
      fileName: `${s.review.number} comment sheet.xlsx`,
      buffer: await reportXlsx<C>(
        'Comment sheet',
        [
          `Comment sheet ${s.review.number}: ${s.review.title}`,
          `${s.document.project} · ${s.document.name} rev ${s.review.version_no}`,
          `Review ${status}${s.codes.length ? ` · ${s.codes.map((c) => `${c.reviewer} ${c.code}`).join(', ')}` : ''}`,
        ],
        [
          { header: 'No.', value: (c) => c.number, width: 6 },
          { header: 'Page', value: (c) => (c.page === 0 ? 'General' : c.page), width: 8 },
          { header: 'Reviewer', value: (c) => c.author, width: 20 },
          { header: 'Comment', value: (c) => c.body, width: 50 },
          { header: 'Date', value: (c) => day(c.createdAt), width: 12 },
          {
            header: 'Response',
            value: (c) => c.replies.map((x) => `${x.author}: ${x.body}`).join('\n'),
            width: 50,
          },
          { header: 'Status', value: (c) => c.status, width: 10 },
        ],
        s.comments,
      ),
    };
  }
}
