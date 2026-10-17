// Projects (docs/04-features.md J1, docs/wave2a-plan.md step 1): the register, a project's details, sites and team,
// its status, and a project made from a won tender. A project is visible to its team; admins and roles with
// `projects.all` see every one. Its lead, admins, and roles with `projects.edit` change it.
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
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { nextNumber } from '../tender/numbering.js';
import { audit, event as tenderEvent } from '../tender/tender-records.js';
import type { Patch } from '../tender/tender.service.js';
import {
  LIVE_STATUSES,
  PROJECT_REASON_REQUIRED,
  allowedProjectMoves,
  type ProjectRole,
  type ProjectStatus,
} from './project-rules.js';

export interface ProjectInput {
  name: string;
  clientId: string | null;
  clientRef: string | null;
  contractValue: string | null;
  startOn: string | null;
  plannedFinishOn: string | null;
  actualFinishOn: string | null;
  location: string | null;
  description: string;
}

export interface SiteInput {
  name: string;
  address: string | null;
  stateCode: string | null;
  active: boolean;
}

const COLUMN: Record<keyof ProjectInput, string> = {
  name: 'name',
  clientId: 'client_id',
  clientRef: 'client_ref',
  contractValue: 'contract_value',
  startOn: 'start_on',
  plannedFinishOn: 'planned_finish_on',
  actualFinishOn: 'actual_finish_on',
  location: 'location',
  description: 'description',
};

const SUMMARY = `p.id, p.number, p.name, p.status, p.client_ref AS "clientRef", p.location,
  p.contract_value::text AS "contractValue", to_char(p.start_on, 'YYYY-MM-DD') AS "startOn",
  to_char(p.planned_finish_on, 'YYYY-MM-DD') AS "plannedFinishOn", p.updated_at AS "updatedAt",
  CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'name', c.name) END AS client,
  (SELECT json_build_object('id', u.id, 'displayName', u.display_name) FROM proj.member m
     JOIN platform."user" u ON u.id = m.user_id WHERE m.project_id = p.id AND m.role = 'lead'
     ORDER BY m.added_at LIMIT 1) AS lead`;

const toColumns = (input: Patch<ProjectInput>) =>
  Object.fromEntries(
    Object.entries(input)
      .filter(([k, v]) => v !== undefined && k in COLUMN)
      .map(([k, v]) => [COLUMN[k as keyof ProjectInput], v]),
  );

const notFound = () => new NotFoundException({ code: 'project_not_found' });
const stale = () =>
  new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this project. Reload to see their changes.',
  });

async function projectEvent(
  tx: TransactionSql,
  projectId: string,
  kind: string,
  data: Record<string, unknown>,
  actorId: string,
) {
  await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
    VALUES (${projectId}, ${kind}, ${tx.json(JSON.parse(JSON.stringify(data)))}, ${actorId})`;
}

@Injectable()
export class ProjectService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  // --- who may see and change ---

  private async seesAll(claims: TenantClaims) {
    return this.permissions.can(claims, 'projects.all');
  }

  /** The caller's role on the project, or null; throws not-found when they may not see it at all. */
  async access(
    db: Sql | TransactionSql,
    claims: TenantClaims,
    projectId: string,
  ): Promise<{ role: ProjectRole | null; canEdit: boolean }> {
    const [p] = await db<{ role: ProjectRole | null; is_central: boolean }[]>`
      SELECT (SELECT m.role FROM proj.member m WHERE m.project_id = p.id AND m.user_id = ${claims.sub}) AS role,
        p.is_central
      FROM proj.project p WHERE p.id = ${projectId}`;
    if (!p) throw notFound();
    // The company's central stores (docs/wave8-plan.md step 8e.3): all staff are its team; permissions still decide.
    if (p.is_central) p.role ??= 'member';
    const all = await this.seesAll(claims);
    if (!p.role && !all) throw notFound();
    const canEdit =
      claims.role === 'admin' ||
      p.role === 'lead' ||
      (await this.permissions.can(claims, 'projects.edit'));
    return { role: p.role, canEdit };
  }

  private async mustEdit(db: Sql | TransactionSql, claims: TenantClaims, projectId: string) {
    const a = await this.access(db, claims, projectId);
    if (!a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's lead or someone allowed to edit projects can change it.",
      });
    return a;
  }

  // --- the register ---

  async list(
    claims: TenantClaims,
    opts: { status?: string | undefined; q?: string | undefined; mine?: boolean | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const all = await this.seesAll(claims);
    const q = opts.q?.trim();
    const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const visible =
      all && !opts.mine
        ? db``
        : db`AND EXISTS (SELECT 1 FROM proj.member m WHERE m.project_id = p.id AND m.user_id = ${claims.sub})`;
    const status =
      opts.status === 'live'
        ? db`AND p.status IN ${db(LIVE_STATUSES as string[])}`
        : opts.status
          ? db`AND p.status = ${opts.status}`
          : db``;
    const items = await db`
      SELECT ${db.unsafe(SUMMARY)}
      FROM proj.project p LEFT JOIN platform.party c ON c.id = p.client_id
      WHERE NOT p.is_central ${visible} ${status}
        ${
          pattern
            ? db`AND (p.name ILIKE ${pattern} OR p.number ILIKE ${pattern} OR p.client_ref ILIKE ${pattern}
                 OR c.name ILIKE ${pattern} OR p.location ILIKE ${pattern})`
            : db``
        }
      ORDER BY (p.status IN ${db(LIVE_STATUSES as string[])}) DESC, p.start_on DESC NULLS LAST, p.created_at DESC
      LIMIT 500`;
    const counts = await db<{ status: string; n: number }[]>`
      SELECT p.status, count(*)::int AS n FROM proj.project p WHERE true ${visible} GROUP BY p.status`;
    return {
      items,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      canCreate: await this.permissions.can(claims, 'projects.edit'),
    };
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const access = await this.access(db, claims, id);
    const [p] = await db<{ status: ProjectStatus; tenderId: string | null }[]>`
      SELECT ${db.unsafe(SUMMARY)}, p.status_reason AS "statusReason",
        to_char(p.actual_finish_on, 'YYYY-MM-DD') AS "actualFinishOn", p.description, p.row_version AS "rowVersion",
        p.created_at AS "createdAt", p.tender_id AS "tenderId",
        CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id', t.id, 'number', t.number, 'title', t.title) END
          AS tender,
        json_build_object('id', e.id, 'name', e.name) AS entity
      FROM proj.project p
      LEFT JOIN platform.party c ON c.id = p.client_id
      LEFT JOIN tender.tender t ON t.id = p.tender_id
      JOIN platform.entity e ON e.id = p.entity_id
      WHERE p.id = ${id}`;
    const [sites, team, events] = await Promise.all([
      db`SELECT id, name, address, state_code AS "stateCode", active, row_version AS "rowVersion"
        FROM proj.site WHERE project_id = ${id} ORDER BY active DESC, lower(name)`,
      db`SELECT u.id AS "userId", u.display_name AS "displayName", u.username, m.role, m.added_at AS "addedAt"
        FROM proj.member m JOIN platform."user" u ON u.id = m.user_id
        WHERE m.project_id = ${id} ORDER BY m.role = 'lead' DESC, lower(u.display_name)`,
      db`SELECT ev.id::text, ev.kind, ev.data, ev.at, u.display_name AS actor
        FROM proj.project_event ev LEFT JOIN platform."user" u ON u.id = ev.actor_id
        WHERE ev.project_id = ${id} ORDER BY ev.id DESC LIMIT 50`,
    ]);
    return {
      ...p!,
      sites,
      team,
      events,
      myRole: access.role,
      canEdit: access.canEdit,
      allowedMoves: allowedProjectMoves(p!.status),
    };
  }

  // --- creating and changing ---

  private async checkRefs(tx: TransactionSql, input: Patch<ProjectInput>) {
    if (input.clientId) {
      const [c] =
        await tx`SELECT 1 FROM platform.party WHERE id = ${input.clientId} AND deleted_at IS NULL`;
      if (!c) throw new BadRequestException({ code: 'client_not_found' });
    }
  }

  private async insert(
    tx: TransactionSql,
    claims: TenantClaims,
    input: ProjectInput,
    extra: { tenderId?: string },
    now: Date,
  ): Promise<string> {
    await this.checkRefs(tx, input);
    const [entity] = await tx<
      { id: string }[]
    >`SELECT id FROM platform.entity WHERE is_default LIMIT 1`;
    const number = await nextNumber(tx, 'project', entity!.id, 'PRJ', now);
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO proj.project ${tx({
        ...toColumns(input),
        entity_id: entity!.id,
        number,
        tender_id: extra.tenderId ?? null,
        created_by: claims.sub,
        updated_by: claims.sub,
      })} RETURNING id`;
    // Whoever makes the project leads it until they hand it over.
    await tx`INSERT INTO proj.member (project_id, user_id, role, added_by)
      VALUES (${row!.id}, ${claims.sub}, 'lead', ${claims.sub})`;
    await projectEvent(
      tx,
      row!.id,
      'created',
      { number, tenderId: extra.tenderId ?? null },
      claims.sub,
    );
    await audit(tx, claims.sub, 'project.create', 'project', row!.id, { number, name: input.name });
    return row!.id;
  }

  async create(claims: TenantClaims, input: ProjectInput, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db.begin((tx) => this.insert(tx, claims, input, {}, now));
    return this.get(claims, id);
  }

  /**
   * A project from a won tender: its title, client, location and our bid value (as read out at the opening, else as
   * submitted, else the estimate). Once per tender. The tender's estimator joins the team. The contract BOQ and
   * budget come in step 2; the tender programme is never copied (docs/04-features.md).
   */
  async fromTender(
    claims: TenantClaims,
    tenderId: string,
    input: Patch<Pick<ProjectInput, 'name' | 'startOn' | 'plannedFinishOn' | 'clientRef'>>,
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db.begin(async (tx) => {
      const [t] = await tx<
        {
          status: string;
          title: string;
          number: string;
          client_id: string | null;
          location: string | null;
          owner_id: string | null;
          value: string | null;
          project_id: string | null;
        }[]
      >`
        SELECT t.status, t.title, t.number, t.client_id, t.location, t.owner_id,
          coalesce(
            (SELECT b.quoted_value FROM tender.competitor_bid b WHERE b.tender_id = t.id AND b.party_id IS NULL),
            (SELECT s.bid_value FROM tender.submission s WHERE s.tender_id = t.id AND s.bid_value IS NOT NULL
              ORDER BY s.submitted_at DESC LIMIT 1),
            t.estimated_value)::text AS value,
          (SELECT p.id FROM proj.project p WHERE p.tender_id = t.id) AS project_id
        FROM tender.tender t WHERE t.id = ${tenderId} FOR UPDATE OF t`;
      if (!t) throw new NotFoundException({ code: 'tender_not_found' });
      if (t.project_id)
        throw new ConflictException({
          code: 'project_exists',
          projectId: t.project_id,
          message: 'This tender already has a project.',
        });
      if (t.status !== 'won')
        throw new ConflictException({
          code: 'tender_not_won',
          message: 'Only a won tender becomes a project.',
        });
      const pid = await this.insert(
        tx,
        claims,
        {
          name: input.name ?? t.title,
          clientId: t.client_id,
          clientRef: input.clientRef ?? null,
          contractValue: t.value,
          startOn: input.startOn ?? null,
          plannedFinishOn: input.plannedFinishOn ?? null,
          actualFinishOn: null,
          location: t.location,
          description: '',
        },
        { tenderId },
        now,
      );
      if (t.owner_id && t.owner_id !== claims.sub)
        await tx`INSERT INTO proj.member (project_id, user_id, role, added_by)
          VALUES (${pid}, ${t.owner_id}, 'member', ${claims.sub}) ON CONFLICT DO NOTHING`;
      await tenderEvent(tx, tenderId, 'project_created', { projectId: pid }, claims.sub);
      return pid;
    });
    return this.get(claims, id);
  }

  async update(claims: TenantClaims, id: string, rowVersion: number, input: Patch<ProjectInput>) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.mustEdit(tx, claims, id);
      await this.checkRefs(tx, input);
      const cols = toColumns(input);
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      try {
        const [row] = await tx`
          UPDATE proj.project SET ${tx({ ...cols, updated_by: claims.sub })}, updated_at = now(),
            row_version = row_version + 1
          WHERE id = ${id} AND row_version = ${rowVersion} RETURNING id`;
        if (!row) throw stale();
      } catch (err) {
        if ((err as { code?: string }).code === '23514')
          throw new BadRequestException({
            code: 'bad_dates',
            message: 'A finish date cannot be before the start.',
          });
        throw err;
      }
      const fields = Object.keys(input).filter((k) => k in COLUMN);
      await projectEvent(tx, id, 'updated', { fields }, claims.sub);
      await audit(tx, claims.sub, 'project.update', 'project', id, { fields });
    });
    return this.get(claims, id);
  }

  async setStatus(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    to: ProjectStatus,
    reason: string | null,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.mustEdit(tx, claims, id);
      const [p] = await tx<{ status: ProjectStatus; row_version: number }[]>`
        SELECT status, row_version FROM proj.project WHERE id = ${id} FOR UPDATE`;
      if (p!.row_version !== rowVersion) throw stale();
      if (!allowedProjectMoves(p!.status).includes(to))
        throw new ConflictException({
          code: 'bad_move',
          from: p!.status,
          to,
          message: `A project cannot go from ${p!.status.replace('_', ' ')} to ${to.replace('_', ' ')}.`,
        });
      if (PROJECT_REASON_REQUIRED.includes(to) && !reason?.trim())
        throw new BadRequestException({ code: 'reason_required', message: 'Say why.' });
      const [late] = await tx<{ start_on: string }[]>`
        SELECT to_char(start_on, 'YYYY-MM-DD') AS start_on FROM proj.project
        WHERE id = ${id} AND ${to} = 'completed' AND actual_finish_on IS NULL AND start_on > (now() AT TIME ZONE 'Asia/Kolkata')::date`;
      if (late)
        throw new BadRequestException({
          code: 'bad_dates',
          message: `The project starts on ${late.start_on}; set the real start date before completing it.`,
        });
      await tx`UPDATE proj.project SET status = ${to}, status_reason = ${reason?.trim() || null},
          actual_finish_on = CASE WHEN ${to} = 'completed' THEN coalesce(actual_finish_on, (now() AT TIME ZONE 'Asia/Kolkata')::date)
            WHEN ${to} = 'active' THEN NULL ELSE actual_finish_on END,
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id}`;
      await projectEvent(tx, id, 'status', { from: p!.status, to, reason }, claims.sub);
      await audit(tx, claims.sub, 'project.status', 'project', id, { from: p!.status, to });
    });
    return this.get(claims, id);
  }

  // --- sites ---

  async addSite(claims: TenantClaims, projectId: string, input: SiteInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.mustEdit(tx, claims, projectId);
      try {
        await tx`INSERT INTO proj.site (project_id, name, address, state_code, active, created_by)
          VALUES (${projectId}, ${input.name}, ${input.address}, ${input.stateCode}, ${input.active}, ${claims.sub})`;
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'site_exists',
            message: 'A site with this name is already there.',
          });
        throw err;
      }
      await projectEvent(tx, projectId, 'site_added', { name: input.name }, claims.sub);
    });
    return this.get(claims, projectId);
  }

  async updateSite(
    claims: TenantClaims,
    siteId: string,
    rowVersion: number,
    input: Patch<SiteInput>,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const projectId = await db.begin(async (tx) => {
      const [s] = await tx<
        { project_id: string }[]
      >`SELECT project_id FROM proj.site WHERE id = ${siteId}`;
      if (!s) throw new NotFoundException({ code: 'site_not_found' });
      await this.mustEdit(tx, claims, s.project_id);
      const cols = Object.fromEntries(
        Object.entries({
          name: input.name,
          address: input.address,
          state_code: input.stateCode,
          active: input.active,
        }).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      try {
        const [row] = await tx`UPDATE proj.site SET ${tx(cols)}, row_version = row_version + 1
          WHERE id = ${siteId} AND row_version = ${rowVersion} RETURNING id`;
        if (!row) throw stale();
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'site_exists',
            message: 'A site with this name is already there.',
          });
        throw err;
      }
      return s.project_id;
    });
    return this.get(claims, projectId);
  }

  // --- team ---

  async setMember(
    claims: TenantClaims,
    projectId: string,
    userId: string,
    role: ProjectRole | null,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.mustEdit(tx, claims, projectId);
      const [u] = await tx<{ status: string; display_name: string }[]>`
        SELECT status, display_name FROM platform."user" WHERE id = ${userId}`;
      if (!u) throw new NotFoundException({ code: 'user_not_found' });
      if (role && u.status !== 'active')
        throw new ConflictException({
          code: 'user_inactive',
          message: 'That user is deactivated.',
        });
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const [before] = await tx<{ role: ProjectRole }[]>`
        SELECT role FROM proj.member WHERE project_id = ${projectId} AND user_id = ${userId}`;
      if (role)
        await tx`INSERT INTO proj.member (project_id, user_id, role, added_by)
          VALUES (${projectId}, ${userId}, ${role}, ${claims.sub})
          ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`;
      else
        await tx`DELETE FROM proj.member WHERE project_id = ${projectId} AND user_id = ${userId}`;
      // A project always keeps a lead, so someone can always change it from inside the team.
      if (before?.role === 'lead' && role !== 'lead') {
        const [left] =
          await tx`SELECT 1 FROM proj.member WHERE project_id = ${projectId} AND role = 'lead'`;
        if (!left)
          throw new ConflictException({
            code: 'last_lead',
            message: 'Make someone else the lead first: a project always has one.',
          });
      }
      await projectEvent(
        tx,
        projectId,
        'team',
        { user: u.display_name, from: before?.role ?? null, to: role },
        claims.sub,
      );
    });
    return this.get(claims, projectId);
  }

  /** The project made from a tender, if there is one the caller may see (for the tender page). */
  async forTender(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<{ id: string; number: string; name: string }[]>`
      SELECT id, number, name FROM proj.project WHERE tender_id = ${tenderId}`;
    if (!p)
      return { project: null, canCreate: await this.permissions.can(claims, 'projects.edit') };
    try {
      await this.access(db, claims, p.id);
      return { project: p, canCreate: false };
    } catch {
      // It exists, but the caller is not on its team: say so without showing it.
      return { project: { id: null, number: p.number, name: null }, canCreate: false };
    }
  }
}
