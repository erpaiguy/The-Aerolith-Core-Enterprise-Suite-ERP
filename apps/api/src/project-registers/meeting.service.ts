// Meetings and actions (docs/wave7-plan.md step 7d.1): a project's minutes, numbered MOM-001…, with who came, what was
// decided, and the actions agreed (an owner on the project's team, a date). An action is closed by its owner or the
// project's lead; open ones wait in the owner's work.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

type Db = Sql | TransactionSql;

export interface MeetingInput {
  title: string;
  heldOn: string;
  place: string;
  attendees: string;
  minutes: string;
  decisions: string;
  actions: { description: string; ownerId: string; dueOn: string }[];
}

@Injectable()
export class MeetingService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  private async mayWrite(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team records meetings.",
      });
    return a;
  }

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    const meetings = await db`
      SELECT m.id, m.number, m.title, to_char(m.held_on, 'YYYY-MM-DD') AS "heldOn", m.place,
        (SELECT count(*)::int FROM proj.meeting_action x WHERE x.meeting_id = m.id) AS actions,
        (SELECT count(*)::int FROM proj.meeting_action x WHERE x.meeting_id = m.id AND x.status = 'open') AS open
      FROM proj.meeting m WHERE m.project_id = ${projectId} ORDER BY m.held_on DESC, m.number DESC`;
    return { meetings, mayWrite: a.canEdit || a.role === 'member' };
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [m] = await db<
      { project_id: string }[]
    >`SELECT project_id FROM proj.meeting WHERE id = ${id}`;
    if (!m) throw new NotFoundException({ code: 'not_found' });
    const a = await this.projects.access(db, claims, m.project_id);
    const [head] = await db`
      SELECT m.id, m.number, m.title, to_char(m.held_on, 'YYYY-MM-DD') AS "heldOn", m.place, m.attendees, m.minutes,
        m.decisions, m.project_id AS "projectId", p.name AS project, u.display_name AS "recordedBy"
      FROM proj.meeting m JOIN proj.project p ON p.id = m.project_id
      LEFT JOIN platform."user" u ON u.id = m.created_by WHERE m.id = ${id}`;
    const actions = await db`
      SELECT x.id, x.position, x.description, x.owner_id AS "ownerId", u.display_name AS owner,
        to_char(x.due_on, 'YYYY-MM-DD') AS "dueOn", x.status, x.note,
        x.status = 'open' AND x.due_on < (now() AT TIME ZONE 'Asia/Kolkata')::date AS overdue
      FROM proj.meeting_action x JOIN platform."user" u ON u.id = x.owner_id
      WHERE x.meeting_id = ${id} ORDER BY x.position`;
    return { ...head, actions, mayLead: a.canEdit, me: claims.sub };
  }

  async create(claims: TenantClaims, projectId: string, b: MeetingInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayWrite(db, claims, projectId);
    const team = new Set(
      (
        await db<
          { user_id: string }[]
        >`SELECT user_id FROM proj.member WHERE project_id = ${projectId}`
      ).map((m) => m.user_id),
    );
    for (const x of b.actions)
      if (!team.has(x.ownerId) && x.ownerId !== claims.sub)
        throw new BadRequestException({
          code: 'not_on_project',
          message: "An action's owner must be on the project's team.",
        });
    const id = await db.begin(async (tx) => {
      const [c] = await tx<{ n: number }[]>`
        SELECT count(*)::int + 1 AS n FROM proj.meeting WHERE project_id = ${projectId}`;
      const n = c!.n;
      const [m] = await tx<{ id: string }[]>`
        INSERT INTO proj.meeting (project_id, number, title, held_on, place, attendees, minutes, decisions, created_by)
        VALUES (${projectId}, ${`MOM-${String(n).padStart(3, '0')}`}, ${b.title}, ${b.heldOn}, ${b.place},
          ${b.attendees}, ${b.minutes}, ${b.decisions}, ${claims.sub})
        RETURNING id`;
      for (const [i, x] of b.actions.entries())
        await tx`INSERT INTO proj.meeting_action (meeting_id, position, description, owner_id, due_on)
          VALUES (${m!.id}, ${i + 1}, ${x.description}, ${x.ownerId}, ${x.dueOn})`;
      return m!.id;
    });
    return this.get(claims, id);
  }

  /** An action done: by its owner, or the project's lead. */
  async done(claims: TenantClaims, actionId: string, note: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [x] = await db<
      { meeting_id: string; owner_id: string; project_id: string; status: string }[]
    >`
      SELECT x.meeting_id, x.owner_id, m.project_id, x.status FROM proj.meeting_action x
      JOIN proj.meeting m ON m.id = x.meeting_id WHERE x.id = ${actionId}`;
    if (!x) throw new NotFoundException({ code: 'not_found' });
    const a = await this.projects.access(db, claims, x.project_id);
    if (x.owner_id !== claims.sub && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Its owner or the project lead closes an action.',
      });
    await db`
      UPDATE proj.meeting_action SET status = 'done', done_at = now(), done_by = ${claims.sub}, note = ${note}
      WHERE id = ${actionId} AND status = 'open'`;
    return this.get(claims, x.meeting_id);
  }
}
