// The basic approval engine (docs/04-features.md P5, docs/wave2b-plan.md step 1). Documents register a type with it
// and submit themselves inside their own transaction; the engine keeps the levels a request was submitted under,
// decides who may act at each level (the project's lead, any manager, any admin, a named person, whoever holds a
// designation (docs/wave3-plan.md step 11), or someone standing in for them while away), and tells the document when
// it is approved, rejected or withdrawn, inside the same transaction as the decision. Nobody approves their own
// request.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
export type Approver = 'project_lead' | 'manager' | 'admin' | 'user' | 'designation';
export type Outcome = 'approved' | 'rejected' | 'withdrawn';

/** What the engine needs from a document type. */
export interface ApprovalDocType {
  /** "Purchase requisition". */
  label: string;
  /** Rules may name the project's lead only for documents of a project. */
  projectScoped: boolean;
  /** The app's page for the document. */
  link(docId: string): string;
  /** Called in the deciding transaction: the document follows the request. */
  decided(
    tx: TransactionSql,
    docId: string,
    outcome: Outcome,
    claims: TenantClaims,
    comment: string | null,
  ): Promise<void>;
  /** What the approver sees of the document (they may not be on its project). */
  summary(db: Db, docId: string): Promise<unknown>;
  /** Whether this person sees the document anyway (its project's team, say). */
  canSee(db: Db, claims: TenantClaims, docId: string): Promise<boolean>;
}

export interface RuleInput {
  minAmount: string;
  approver: Approver;
  userId: string | null;
  designationId: string | null;
  label: string;
}

interface RequestRow {
  id: string;
  doc_type: string;
  doc_id: string;
  project_id: string | null;
  title: string;
  amount: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  level: number | null;
  submitted_by: string;
  row_version: number;
}

interface StepRow {
  level: number;
  approver: Approver;
  user_id: string | null;
  designation_id: string | null;
  to_admins: boolean;
  status: string;
}

export const APPROVER_LABEL: Record<Approver, string> = {
  project_lead: "The project's lead",
  manager: 'Any manager (or admin)',
  admin: 'Any admin',
  user: 'A named person',
  designation: 'Whoever holds a designation',
};

/** Today in India: delegations run on Indian dates. */
export const indiaToday = (now = new Date()) =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * People who match a level directly: active, not the submitter, and not someone who approved an earlier level of the
 * same request (each level is another pair of eyes). Whom it goes to.
 */
function matching(
  db: Db,
  step: StepRow,
  projectId: string | null,
  submittedBy: string,
  requestId: string | null,
) {
  return db<{ id: string }[]>`
    SELECT u.id FROM platform."user" u
    WHERE u.status = 'active' AND u.id <> ${submittedBy}
      AND NOT EXISTS (SELECT 1 FROM platform.approval_step e WHERE e.request_id = ${requestId}
        AND e.level < ${step.level} AND (e.acted_by = u.id OR e.on_behalf_of = u.id))
      AND CASE ${step.approver}
      WHEN 'user' THEN u.id = ${step.user_id}
      WHEN 'manager' THEN u.role IN ('manager', 'admin')
      WHEN 'admin' THEN u.role = 'admin'
      WHEN 'designation' THEN EXISTS (SELECT 1 FROM hr.employee e WHERE e.user_id = u.id
        AND e.designation_id = ${step.designation_id} AND (e.left_on IS NULL OR e.left_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date))
      ELSE EXISTS (SELECT 1 FROM proj.member m WHERE m.project_id = ${projectId} AND m.user_id = u.id
        AND m.role = 'lead') END`;
}

const admins = (db: Db, except: string) =>
  db<{ id: string }[]>`
    SELECT id FROM platform."user" WHERE status = 'active' AND role = 'admin' AND id <> ${except}`;

/**
 * The ids of the pending requests waiting on this person now: at their level they match the approver themselves, or
 * stand in today for someone who does (never for the submitter), or the level went to the admins and they are one.
 */
export function waitingOn(db: Db, claims: TenantClaims, today = indiaToday()) {
  return db`
    WITH acting AS (
      SELECT u.id, u.role FROM platform."user" u WHERE u.id = ${claims.sub} AND u.status = 'active'
      UNION
      SELECT u.id, u.role FROM platform.approval_delegation d
      JOIN platform."user" u ON u.id = d.from_user AND u.status = 'active'
      WHERE d.to_user = ${claims.sub} AND d.cancelled_at IS NULL AND ${today}::date BETWEEN d.starts_on AND d.ends_on
    )
    SELECT r.id FROM platform.approval_request r
    JOIN platform.approval_step s ON s.request_id = r.id AND s.level = r.level
    WHERE r.status = 'pending' AND r.submitted_by <> ${claims.sub} AND (
      (s.to_admins AND ${claims.role} = 'admin')
      OR (NOT s.to_admins AND EXISTS (SELECT 1 FROM acting a WHERE a.id <> r.submitted_by
        AND NOT EXISTS (SELECT 1 FROM platform.approval_step e WHERE e.request_id = r.id AND e.level < s.level
          AND (e.acted_by = a.id OR e.on_behalf_of = a.id))
        AND (
        (s.approver = 'user' AND s.user_id = a.id)
        OR (s.approver = 'manager' AND a.role IN ('manager', 'admin'))
        OR (s.approver = 'admin' AND a.role = 'admin')
        OR (s.approver = 'designation' AND EXISTS (SELECT 1 FROM hr.employee e WHERE e.user_id = a.id
          AND e.designation_id = s.designation_id AND (e.left_on IS NULL OR e.left_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date)))
        OR (s.approver = 'project_lead' AND EXISTS (SELECT 1 FROM proj.member m
          WHERE m.project_id = r.project_id AND m.user_id = a.id AND m.role = 'lead'))))))`;
}

/** How many requests wait on this person (the menu's count). */
export async function waitingCount(db: Db, claims: TenantClaims) {
  const [r] = await db<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM (${waitingOn(db, claims)}) w`;
  return r?.n ?? 0;
}

@Injectable()
export class ApprovalService {
  private readonly types = new Map<string, ApprovalDocType>();

  constructor(private readonly tenants: TenantConnections) {}

  register(docType: string, type: ApprovalDocType) {
    this.types.set(docType, type);
  }

  private type(docType: string) {
    const t = this.types.get(docType);
    if (!t) throw new NotFoundException({ code: 'unknown_document_type' });
    return t;
  }

  // --- rules ---

  async rules(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      {
        docType: string;
        level: number;
        minAmount: string;
        approver: Approver;
        userId: string | null;
        userName: string | null;
        designationId: string | null;
        designationName: string | null;
        label: string;
      }[]
    >`
      SELECT r.doc_type AS "docType", r.level, r.min_amount::text AS "minAmount", r.approver, r.user_id AS "userId",
        u.display_name AS "userName", r.designation_id AS "designationId", d.name AS "designationName", r.label
      FROM platform.approval_rule r LEFT JOIN platform."user" u ON u.id = r.user_id
      LEFT JOIN hr.designation d ON d.id = r.designation_id
      ORDER BY r.doc_type, r.level`;
    return {
      types: [...this.types.entries()].map(([docType, t]) => ({
        docType,
        label: t.label,
        projectScoped: t.projectScoped,
        rules: rows.filter((r) => r.docType === docType).map(({ docType: _, ...r }) => r),
      })),
    };
  }

  /** Replaces the rules of a document type (the admin). Levels are numbered in the order given. */
  async setRules(claims: TenantClaims, docType: string, rules: RuleInput[]) {
    const t = this.type(docType);
    const db = await this.tenants.forTenant(claims.ten);
    for (let i = 1; i < rules.length; i++)
      if (Number(rules[i]!.minAmount) < Number(rules[i - 1]!.minAmount))
        throw new BadRequestException({
          code: 'amounts_out_of_order',
          message: 'Each level applies from an amount at least that of the level before it.',
        });
    if (!t.projectScoped && rules.some((r) => r.approver === 'project_lead'))
      throw new BadRequestException({
        code: 'no_project',
        message: `A ${t.label.toLowerCase()} has no project, so no project lead.`,
      });
    const named = rules.filter((r) => r.approver === 'user').map((r) => r.userId!);
    if (named.length) {
      const found = await db<{ id: string }[]>`
        SELECT id FROM platform."user" WHERE id = ANY(${named}::uuid[]) AND status = 'active'`;
      if (found.length !== new Set(named).size)
        throw new BadRequestException({
          code: 'approver_not_found',
          message: 'A named approver is not an active user.',
        });
    }
    const designations = rules
      .filter((r) => r.approver === 'designation')
      .map((r) => r.designationId!);
    if (designations.length) {
      const found = await db<{ id: string }[]>`
        SELECT id FROM hr.designation WHERE id = ANY(${designations}::uuid[])`;
      if (found.length !== new Set(designations).size)
        throw new BadRequestException({
          code: 'designation_not_found',
          message: 'No such designation.',
        });
    }
    await db.begin(async (tx) => {
      await tx`DELETE FROM platform.approval_rule WHERE doc_type = ${docType}`;
      for (const [i, r] of rules.entries())
        await tx`
          INSERT INTO platform.approval_rule (doc_type, level, min_amount, approver, user_id, designation_id, label,
            updated_by)
          VALUES (${docType}, ${i + 1}, ${r.minAmount}, ${r.approver}, ${r.approver === 'user' ? r.userId : null},
            ${r.approver === 'designation' ? r.designationId : null}, ${r.label}, ${claims.sub})`;
      await audit(tx, claims.sub, 'approval.rules', 'approval_rule', docType, { rules });
    });
    return this.rules(claims);
  }

  // --- submitting ---

  /**
   * Submits a document, inside the document's own transaction. With no level applying to its amount it is approved
   * at once (`approved`); otherwise it waits at its first level (`pending`).
   */
  async submit(
    tx: TransactionSql,
    claims: TenantClaims,
    input: {
      docType: string;
      docId: string;
      projectId: string | null;
      title: string;
      amount: string;
    },
  ): Promise<{ requestId: string; status: 'pending' | 'approved' }> {
    this.type(input.docType);
    const rules = await tx<
      {
        level: number;
        approver: Approver;
        user_id: string | null;
        designation_id: string | null;
        label: string;
        min_amount: string;
      }[]
    >`
      SELECT level, approver, user_id, designation_id, label, min_amount::text FROM platform.approval_rule
      WHERE doc_type = ${input.docType} AND min_amount <= ${input.amount} ORDER BY level`;
    const status = rules.length ? 'pending' : 'approved';
    let requestId: string;
    try {
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO platform.approval_request (doc_type, doc_id, project_id, title, amount, status, level,
          submitted_by, decided_at)
        VALUES (${input.docType}, ${input.docId}, ${input.projectId}, ${input.title.slice(0, 300)}, ${input.amount},
          ${status}, ${rules[0]?.level ?? null}, ${claims.sub}, ${rules.length ? null : new Date()})
        RETURNING id`;
      requestId = r!.id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new ConflictException({
          code: 'already_submitted',
          message: 'This is already waiting for approval.',
        });
      throw err;
    }
    await tx`INSERT INTO platform.approval_event (request_id, kind, actor_id) VALUES (${requestId}, 'submitted',
      ${claims.sub})`;
    if (!rules.length) {
      await tx`INSERT INTO platform.approval_event (request_id, kind) VALUES (${requestId}, 'no_approval_needed')`;
      return { requestId, status: 'approved' };
    }
    // Every level needs someone other than the submitter: whoever matches it, or failing them an admin.
    const others = await admins(tx, claims.sub);
    for (const rule of rules) {
      const step = { ...rule, to_admins: false, status: 'waiting' };
      if (!others.length && !(await matching(tx, step, input.projectId, claims.sub, null)).length)
        throw new ConflictException({
          code: 'no_approver',
          message: `No one but you could approve level ${rule.level} (${rule.label || APPROVER_LABEL[rule.approver]}). Ask the admin to change the approval rules.`,
        });
      await tx`
        INSERT INTO platform.approval_step (request_id, level, approver, user_id, designation_id, label, min_amount)
        VALUES (${requestId}, ${rule.level}, ${rule.approver}, ${rule.user_id}, ${rule.designation_id}, ${rule.label},
          ${rule.min_amount})`;
    }
    await this.open(tx, requestId, rules[0]!.level);
    return { requestId, status: 'pending' };
  }

  /** A level comes up: it waits on whoever matches it (else the admins), and they are told. */
  private async open(tx: TransactionSql, requestId: string, level: number) {
    const [r] = await tx<
      RequestRow[]
    >`SELECT * FROM platform.approval_request WHERE id = ${requestId}`;
    const [step] = await tx<StepRow[]>`
      SELECT level, approver, user_id, designation_id, to_admins, status FROM platform.approval_step
      WHERE request_id = ${requestId} AND level = ${level}`;
    let people = (await matching(tx, step!, r!.project_id, r!.submitted_by, r!.id)).map(
      (u) => u.id,
    );
    const toAdmins = people.length === 0;
    if (toAdmins) {
      people = (await admins(tx, r!.submitted_by)).map((u) => u.id);
      await tx`INSERT INTO platform.approval_event (request_id, kind, level) VALUES (${requestId}, 'to_admins',
        ${level})`;
    }
    await tx`UPDATE platform.approval_step SET status = 'pending', to_admins = ${toAdmins}
      WHERE request_id = ${requestId} AND level = ${level}`;
    // Those standing in for them today are told too.
    const today = indiaToday();
    const delegates = people.length
      ? await tx<{ id: string }[]>`
          SELECT DISTINCT d.to_user AS id FROM platform.approval_delegation d
          WHERE d.from_user = ANY(${people}::uuid[]) AND d.to_user <> ${r!.submitted_by}
            AND d.cancelled_at IS NULL AND ${today}::date BETWEEN d.starts_on AND d.ends_on`
      : [];
    const t = this.type(r!.doc_type);
    for (const id of new Set([...people, ...delegates.map((d) => d.id)]))
      await tx`
        INSERT INTO platform.notification (user_id, kind, title, body, link)
        VALUES (${id}, 'approval', ${`To approve: ${r!.title}`.slice(0, 300)},
          ${`${t.label}, ₹${Number(r!.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`},
          ${`/approvals/${requestId}`})`;
  }

  // --- acting ---

  /**
   * Whether this person may act on the request's current level: `self`, the person they stand in for, or `null`
   * when they may not.
   */
  private async actingFor(
    db: Db,
    claims: TenantClaims,
    r: RequestRow,
  ): Promise<{ onBehalfOf: string | null } | null> {
    if (r.status !== 'pending' || claims.sub === r.submitted_by) return null;
    const [step] = await db<StepRow[]>`
      SELECT level, approver, user_id, designation_id, to_admins, status FROM platform.approval_step
      WHERE request_id = ${r.id} AND level = ${r.level}`;
    if (!step) return null;
    if (step.to_admins) return claims.role === 'admin' ? { onBehalfOf: null } : null;
    const ids = (await matching(db, step, r.project_id, r.submitted_by, r.id)).map((u) => u.id);
    if (ids.includes(claims.sub)) return { onBehalfOf: null };
    if (!ids.length) return null;
    const [d] = await db<{ from_user: string }[]>`
      SELECT from_user FROM platform.approval_delegation
      WHERE to_user = ${claims.sub} AND from_user = ANY(${ids}::uuid[]) AND cancelled_at IS NULL
        AND ${indiaToday()}::date BETWEEN starts_on AND ends_on
      ORDER BY created_at LIMIT 1`;
    return d ? { onBehalfOf: d.from_user } : null;
  }

  private async locked(tx: TransactionSql, requestId: string) {
    const [r] = await tx<RequestRow[]>`
      SELECT * FROM platform.approval_request WHERE id = ${requestId} FOR UPDATE`;
    if (!r) throw new NotFoundException({ code: 'approval_not_found' });
    return r;
  }

  private notPending() {
    return new ConflictException({
      code: 'not_pending',
      message: 'This request has already been decided or withdrawn.',
    });
  }

  async approve(claims: TenantClaims, requestId: string, comment: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const r = await this.locked(tx, requestId);
      if (r.status !== 'pending') throw this.notPending();
      const acting = await this.actingFor(tx, claims, r);
      if (!acting)
        throw new ForbiddenException({
          code: 'not_your_approval',
          message: 'This is not waiting on you.',
        });
      await tx`
        UPDATE platform.approval_step SET status = 'approved', acted_by = ${claims.sub},
          on_behalf_of = ${acting.onBehalfOf}, acted_at = now(), comment = ${comment}
        WHERE request_id = ${r.id} AND level = ${r.level}`;
      await tx`INSERT INTO platform.approval_event (request_id, kind, level, actor_id, on_behalf_of, comment)
        VALUES (${r.id}, 'approved', ${r.level}, ${claims.sub}, ${acting.onBehalfOf}, ${comment})`;
      const [next] = await tx<{ level: number }[]>`
        SELECT level FROM platform.approval_step WHERE request_id = ${r.id} AND status = 'waiting'
        ORDER BY level LIMIT 1`;
      if (next) {
        await tx`UPDATE platform.approval_request SET level = ${next.level}, row_version = row_version + 1
          WHERE id = ${r.id}`;
        await this.open(tx, r.id, next.level);
      } else await this.close(tx, claims, r, 'approved', comment);
    });
    return this.detail(claims, requestId);
  }

  async reject(claims: TenantClaims, requestId: string, comment: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const r = await this.locked(tx, requestId);
      if (r.status !== 'pending') throw this.notPending();
      const acting = await this.actingFor(tx, claims, r);
      if (!acting)
        throw new ForbiddenException({
          code: 'not_your_approval',
          message: 'This is not waiting on you.',
        });
      await tx`
        UPDATE platform.approval_step SET status = 'rejected', acted_by = ${claims.sub},
          on_behalf_of = ${acting.onBehalfOf}, acted_at = now(), comment = ${comment}
        WHERE request_id = ${r.id} AND level = ${r.level}`;
      await tx`INSERT INTO platform.approval_event (request_id, kind, level, actor_id, on_behalf_of, comment)
        VALUES (${r.id}, 'rejected', ${r.level}, ${claims.sub}, ${acting.onBehalfOf}, ${comment})`;
      await this.close(tx, claims, r, 'rejected', comment);
    });
    return this.detail(claims, requestId);
  }

  /** The submitter takes the request back while it is pending. */
  async withdraw(claims: TenantClaims, requestId: string, comment: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const r = await this.locked(tx, requestId);
      if (r.status !== 'pending') throw this.notPending();
      if (r.submitted_by !== claims.sub)
        throw new ForbiddenException({
          code: 'not_yours',
          message: 'Only whoever submitted it can withdraw it.',
        });
      await tx`INSERT INTO platform.approval_event (request_id, kind, level, actor_id, comment)
        VALUES (${r.id}, 'withdrawn', ${r.level}, ${claims.sub}, ${comment})`;
      await this.close(tx, claims, r, 'withdrawn', comment);
    });
    return this.detail(claims, requestId);
  }

  /** Withdraws a document's pending request from the document's side (its own transaction), if there is one. */
  async withdrawFor(tx: TransactionSql, claims: TenantClaims, docType: string, docId: string) {
    const [r] = await tx<RequestRow[]>`
      SELECT * FROM platform.approval_request WHERE doc_type = ${docType} AND doc_id = ${docId}
        AND status = 'pending' FOR UPDATE`;
    if (!r) return;
    await tx`INSERT INTO platform.approval_event (request_id, kind, level, actor_id)
      VALUES (${r.id}, 'withdrawn', ${r.level}, ${claims.sub})`;
    await tx`UPDATE platform.approval_request SET status = 'withdrawn', level = NULL, decided_at = now(),
      row_version = row_version + 1 WHERE id = ${r.id}`;
  }

  private async close(
    tx: TransactionSql,
    claims: TenantClaims,
    r: RequestRow,
    outcome: Outcome,
    comment: string | null,
  ) {
    await tx`UPDATE platform.approval_request SET status = ${outcome}, level = NULL, decided_at = now(),
      row_version = row_version + 1 WHERE id = ${r.id}`;
    const t = this.type(r.doc_type);
    await t.decided(tx, r.doc_id, outcome, claims, comment);
    if (outcome !== 'withdrawn')
      await tx`
        INSERT INTO platform.notification (user_id, kind, title, body, link)
        VALUES (${r.submitted_by}, 'approval_decided',
          ${`${outcome === 'approved' ? 'Approved' : 'Rejected'}: ${r.title}`.slice(0, 300)},
          ${comment ?? ''}, ${t.link(r.doc_id)})`;
  }

  async comment(claims: TenantClaims, requestId: string, text: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.visible(db, claims, requestId);
    await db`INSERT INTO platform.approval_event (request_id, kind, level, actor_id, comment)
      VALUES (${r.id}, 'commented', ${r.level}, ${claims.sub}, ${text})`;
    return this.detail(claims, requestId);
  }

  // --- reading ---

  /** The request, if this person may see it: its submitter, its approvers past and present, or the document's own. */
  private async visible(db: Db, claims: TenantClaims, requestId: string) {
    const [r] = await db<
      RequestRow[]
    >`SELECT * FROM platform.approval_request WHERE id = ${requestId}`;
    if (!r) throw new NotFoundException({ code: 'approval_not_found' });
    if (claims.role === 'admin' || r.submitted_by === claims.sub) return r;
    const [acted] = await db`SELECT 1 FROM platform.approval_step WHERE request_id = ${r.id}
      AND (acted_by = ${claims.sub} OR on_behalf_of = ${claims.sub}) LIMIT 1`;
    if (acted || (await this.actingFor(db, claims, r))) return r;
    if (await this.type(r.doc_type).canSee(db, claims, r.doc_id)) return r;
    throw new NotFoundException({ code: 'approval_not_found' });
  }

  async detail(claims: TenantClaims, requestId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.visible(db, claims, requestId);
    const t = this.type(r.doc_type);
    return {
      ...(await this.describe(db, claims, r)),
      document: await t.summary(db, r.doc_id),
    };
  }

  /** The latest request of a document, for the document's own page (null if never submitted). */
  async latestFor(db: Db, claims: TenantClaims, docType: string, docId: string) {
    const [r] = await db<RequestRow[]>`
      SELECT * FROM platform.approval_request WHERE doc_type = ${docType} AND doc_id = ${docId}
      ORDER BY submitted_at DESC, id DESC LIMIT 1`;
    return r ? this.describe(db, claims, r) : null;
  }

  private async describe(db: Db, claims: TenantClaims, r: RequestRow) {
    const t = this.type(r.doc_type);
    const [head] = await db<
      { submittedBy: string; submittedAt: string; decidedAt: string | null; project: unknown }[]
    >`
      SELECT u.display_name AS "submittedBy", r.submitted_at AS "submittedAt", r.decided_at AS "decidedAt",
        CASE WHEN p.id IS NULL THEN NULL
          ELSE json_build_object('id', p.id, 'number', p.number, 'name', p.name) END AS project
      FROM platform.approval_request r JOIN platform."user" u ON u.id = r.submitted_by
      LEFT JOIN proj.project p ON p.id = r.project_id
      WHERE r.id = ${r.id}`;
    const steps = await db<
      {
        level: number;
        approver: Approver;
        approverName: string;
        label: string;
        minAmount: string;
        status: string;
        toAdmins: boolean;
        actedBy: string | null;
        onBehalfOf: string | null;
        actedAt: string | null;
        comment: string | null;
      }[]
    >`
      SELECT s.level, s.approver, coalesce(nu.display_name, nd.name, '') AS "approverName", s.label,
        s.min_amount::text AS "minAmount", s.status, s.to_admins AS "toAdmins", au.display_name AS "actedBy",
        bu.display_name AS "onBehalfOf", s.acted_at AS "actedAt", s.comment
      FROM platform.approval_step s
      LEFT JOIN platform."user" nu ON nu.id = s.user_id
      LEFT JOIN hr.designation nd ON nd.id = s.designation_id
      LEFT JOIN platform."user" au ON au.id = s.acted_by
      LEFT JOIN platform."user" bu ON bu.id = s.on_behalf_of
      WHERE s.request_id = ${r.id} ORDER BY s.level`;
    const events = await db`
      SELECT e.id::text, e.kind, e.level, u.display_name AS actor, b.display_name AS "onBehalfOf", e.comment, e.at
      FROM platform.approval_event e
      LEFT JOIN platform."user" u ON u.id = e.actor_id
      LEFT JOIN platform."user" b ON b.id = e.on_behalf_of
      WHERE e.request_id = ${r.id} ORDER BY e.id`;
    const acting = await this.actingFor(db, claims, r);
    const [standIn] = acting?.onBehalfOf
      ? await db<{ name: string }[]>`
          SELECT display_name AS name FROM platform."user" WHERE id = ${acting.onBehalfOf}`
      : [];
    return {
      id: r.id,
      docType: r.doc_type,
      docLabel: t.label,
      docId: r.doc_id,
      link: t.link(r.doc_id),
      title: r.title,
      amount: r.amount,
      status: r.status,
      level: r.level,
      ...head!,
      steps: steps.map((s) => ({
        ...s,
        approverName:
          s.approver === 'user' || (s.approver === 'designation' && !s.toAdmins)
            ? s.approverName
            : s.toAdmins
              ? 'Any admin'
              : APPROVER_LABEL[s.approver],
      })),
      events,
      mayAct: Boolean(acting),
      actingFor: standIn?.name ?? null,
      mayWithdraw: r.status === 'pending' && r.submitted_by === claims.sub,
    };
  }

  /** Requests waiting on me, submitted by me, or that I acted on. */
  async list(claims: TenantClaims, view: 'waiting' | 'mine' | 'decided') {
    const db = await this.tenants.forTenant(claims.ten);
    const where =
      view === 'waiting'
        ? db`r.id IN (${waitingOn(db, claims)})`
        : view === 'mine'
          ? db`r.submitted_by = ${claims.sub}`
          : db`EXISTS (SELECT 1 FROM platform.approval_step s WHERE s.request_id = r.id
              AND (s.acted_by = ${claims.sub} OR s.on_behalf_of = ${claims.sub}))`;
    const rows = await db<
      {
        id: string;
        docType: string;
        docId: string;
        title: string;
        amount: string;
        status: string;
        level: number | null;
        levels: number;
        submittedBy: string;
        submittedAt: string;
        decidedAt: string | null;
        project: { id: string; number: string; name: string } | null;
      }[]
    >`
      SELECT r.id, r.doc_type AS "docType", r.doc_id AS "docId", r.title, r.amount::text AS amount, r.status,
        r.level, (SELECT count(*)::int FROM platform.approval_step s WHERE s.request_id = r.id) AS levels,
        u.display_name AS "submittedBy", r.submitted_at AS "submittedAt", r.decided_at AS "decidedAt",
        CASE WHEN p.id IS NULL THEN NULL
          ELSE json_build_object('id', p.id, 'number', p.number, 'name', p.name) END AS project
      FROM platform.approval_request r
      JOIN platform."user" u ON u.id = r.submitted_by
      LEFT JOIN proj.project p ON p.id = r.project_id
      WHERE ${where}
      ORDER BY ${view === 'waiting' ? db`r.submitted_at` : db`r.submitted_at DESC`} LIMIT 300`;
    return rows.map((r) => ({
      ...r,
      docLabel: this.types.get(r.docType)?.label ?? r.docType,
      link: this.types.get(r.docType)?.link(r.docId) ?? null,
    }));
  }

  // --- standing in while away ---

  async delegations(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT d.id, d.from_user AS "fromUserId", f.display_name AS "fromName", d.to_user AS "toUserId",
        t.display_name AS "toName", to_char(d.starts_on, 'YYYY-MM-DD') AS "startsOn",
        to_char(d.ends_on, 'YYYY-MM-DD') AS "endsOn", d.reason, d.cancelled_at AS "cancelledAt",
        (d.cancelled_at IS NULL AND ${indiaToday()}::date BETWEEN d.starts_on AND d.ends_on) AS active
      FROM platform.approval_delegation d
      JOIN platform."user" f ON f.id = d.from_user
      JOIN platform."user" t ON t.id = d.to_user
      WHERE ${claims.role === 'admin' ? db`true` : db`(d.from_user = ${claims.sub} OR d.to_user = ${claims.sub})`}
        AND (d.cancelled_at IS NULL AND d.ends_on >= ${indiaToday()}::date)
      ORDER BY d.starts_on, d.created_at LIMIT 200`;
  }

  /** Someone approves for `fromUserId` (oneself, or anyone for an admin) between two days. */
  async delegate(
    claims: TenantClaims,
    input: {
      fromUserId: string | null;
      toUserId: string;
      startsOn: string;
      endsOn: string;
      reason: string;
    },
  ) {
    const from = input.fromUserId ?? claims.sub;
    if (from !== claims.sub && claims.role !== 'admin')
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Only an admin sets up a stand-in for someone else.',
      });
    if (from === input.toUserId)
      throw new BadRequestException({ code: 'same_person', message: 'Choose someone else.' });
    if (input.endsOn < input.startsOn || input.endsOn < indiaToday())
      throw new BadRequestException({
        code: 'bad_dates',
        message: 'The last day is before the first, or already past.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const users = await db<{ id: string }[]>`
      SELECT id FROM platform."user" WHERE id IN (${from}, ${input.toUserId}) AND status = 'active'`;
    if (users.length !== 2)
      throw new BadRequestException({ code: 'user_not_found', message: 'Choose an active user.' });
    await db.begin(async (tx) => {
      const [d] = await tx<{ id: string }[]>`
        INSERT INTO platform.approval_delegation (from_user, to_user, starts_on, ends_on, reason, created_by)
        VALUES (${from}, ${input.toUserId}, ${input.startsOn}, ${input.endsOn}, ${input.reason}, ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'approval.delegate', 'approval_delegation', d!.id, {
        ...input,
        from,
      });
    });
    return this.delegations(claims);
  }

  async cancelDelegation(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [d] = await db<{ from_user: string }[]>`
      SELECT from_user FROM platform.approval_delegation WHERE id = ${id} AND cancelled_at IS NULL`;
    if (!d) throw new NotFoundException({ code: 'delegation_not_found' });
    if (d.from_user !== claims.sub && claims.role !== 'admin')
      throw new ForbiddenException({ code: 'forbidden' });
    await db.begin(async (tx) => {
      await tx`UPDATE platform.approval_delegation SET cancelled_at = now() WHERE id = ${id}`;
      await audit(tx, claims.sub, 'approval.delegate_cancel', 'approval_delegation', id, {});
    });
    return this.delegations(claims);
  }
}
