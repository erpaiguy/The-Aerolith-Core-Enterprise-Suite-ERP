// Safety (docs/wave3-plan.md step 15): incidents investigated to closure, permits to work issued by someone other than
// who asked with their precautions confirmed, toolbox talks with attendance, and the project's injury rates worked
// from the hours its people were recorded on site (employees' attendance, contract workers' musters).
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
import { DAY_HOURS, PRECAUTIONS, rates, type PermitKind } from './safety-rules.js';

type Db = Sql | TransactionSql;

@Injectable()
export class SafetyService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
  ) {}

  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team records its safety.",
      });
  }

  private async manager(db: Db, claims: TenantClaims, projectId: string) {
    await this.projects.access(db, claims, projectId);
    if (!(await this.permissions.can(claims, 'safety.manage')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'safety.manage',
        message: 'This needs the safety permission.',
      });
  }

  private async next(tx: TransactionSql, projectId: string, kind: 'incident' | 'permit') {
    await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
    const [r] =
      kind === 'incident'
        ? await tx<
            { n: number }[]
          >`SELECT count(*)::int + 1 AS n FROM hse.incident WHERE project_id = ${projectId}`
        : await tx<
            { n: number }[]
          >`SELECT count(*)::int + 1 AS n FROM hse.permit WHERE project_id = ${projectId}`;
    return `${kind === 'incident' ? 'INC' : 'PTW'}-${String(r!.n).padStart(3, '0')}`;
  }

  // --- the register ---

  async register(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const [incidents, permits, talks, inspections] = await Promise.all([
      db`SELECT i.id, i.number, i.kind, to_char(i.occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS "occurredAt",
           i.location, i.description, coalesce(e.name, w.name, nullif(i.injured_name, '')) AS injured, i.days_lost AS "daysLost",
           i.status, (SELECT count(*)::int FROM hse.incident_action a WHERE a.incident_id = i.id AND a.done_on IS NULL) AS "openActions"
         FROM hse.incident i LEFT JOIN hr.employee e ON e.id = i.employee_id LEFT JOIN lab.worker w ON w.id = i.worker_id
         WHERE i.project_id = ${projectId} ORDER BY i.occurred_at DESC`,
      db`SELECT p.id, p.number, p.kind, p.location, p.work,
           to_char(p.valid_from AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS "validFrom",
           to_char(p.valid_to AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS "validTo",
           CASE WHEN p.status = 'issued' AND p.valid_to < now() THEN 'expired' ELSE p.status END AS status,
           p.precautions, u.display_name AS "requestedBy", p.row_version AS "rowVersion"
         FROM hse.permit p JOIN platform."user" u ON u.id = p.requested_by
         WHERE p.project_id = ${projectId} ORDER BY p.valid_from DESC`,
      db`SELECT id, to_char(held_on, 'YYYY-MM-DD') AS "heldOn", topic, speaker,
           cardinality(employee_ids) + cardinality(worker_ids) + others AS attendance
         FROM hse.toolbox_talk WHERE project_id = ${projectId} ORDER BY held_on DESC`,
      db`SELECT c.id, ct.name AS template, to_char(c.done_on, 'YYYY-MM-DD') AS "doneOn", c.location, c.result
         FROM qa.checklist c JOIN qa.checklist_template ct ON ct.id = c.template_id
         WHERE c.project_id = ${projectId} AND lower(ct.work_type) = 'safety' ORDER BY c.done_on DESC`,
    ]);
    return {
      incidents,
      permits,
      toolboxTalks: talks,
      inspections,
      precautions: PRECAUTIONS,
      mayManage: await this.permissions.can(claims, 'safety.manage'),
    };
  }

  // --- incidents ---

  async report(
    claims: TenantClaims,
    projectId: string,
    input: {
      siteId: string | null;
      occurredAt: string;
      kind: string;
      location: string;
      description: string;
      employeeId: string | null;
      workerId: string | null;
      injuredName: string;
      daysLost: number;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    if (input.daysLost > 0 && input.kind !== 'lost_time' && input.kind !== 'fatal')
      throw new BadRequestException({
        code: 'days_lost',
        message: 'Only a lost-time injury loses days.',
      });
    const id = await db.begin(async (tx) => {
      const number = await this.next(tx, projectId, 'incident');
      const [i] = await tx<{ id: string }[]>`
        INSERT INTO hse.incident (project_id, number, site_id, occurred_at, kind, location, description, employee_id,
          worker_id, injured_name, days_lost, created_by)
        VALUES (${projectId}, ${number}, ${input.siteId}, ${input.occurredAt}, ${input.kind}, ${input.location},
          ${input.description}, ${input.employeeId}, ${input.workerId}, ${input.injuredName}, ${input.daysLost},
          ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'safety.incident', 'incident', i!.id, {
        number,
        kind: input.kind,
      });
      return i!.id;
    });
    return this.incident(claims, id);
  }

  async incident(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<Record<string, unknown> & { projectId: string }[]>`
      SELECT i.id, i.project_id AS "projectId", i.number, i.kind, i.description, i.location, i.days_lost AS "daysLost",
        i.root_cause AS "rootCause", i.status, to_char(i.closed_on, 'YYYY-MM-DD') AS "closedOn", i.row_version AS "rowVersion",
        coalesce((SELECT json_agg(json_build_object('id', a.id, 'action', a.action, 'owner', a.owner,
          'dueOn', to_char(a.due_on, 'YYYY-MM-DD'), 'doneOn', to_char(a.done_on, 'YYYY-MM-DD')) ORDER BY a.created_at)
          FROM hse.incident_action a WHERE a.incident_id = i.id), '[]') AS actions
      FROM hse.incident i WHERE i.id = ${id}`;
    if (!i) throw new NotFoundException({ code: 'incident_not_found' });
    await this.projects.access(db, claims, i.projectId);
    return i;
  }

  /** The investigation: the root cause and the actions to take. */
  async investigate(
    claims: TenantClaims,
    id: string,
    input: {
      rootCause: string;
      daysLost: number | null;
      actions: { action: string; owner: string; dueOn: string | null }[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<{ project_id: string; status: string; kind: string }[]>`
      SELECT project_id, status, kind FROM hse.incident WHERE id = ${id}`;
    if (!i) throw new NotFoundException({ code: 'incident_not_found' });
    await this.team(db, claims, i.project_id);
    if (i.status === 'closed')
      throw new ConflictException({ code: 'closed', message: 'The incident is closed.' });
    if (
      input.daysLost !== null &&
      input.daysLost > 0 &&
      i.kind !== 'lost_time' &&
      i.kind !== 'fatal'
    )
      throw new BadRequestException({
        code: 'days_lost',
        message: 'Only a lost-time injury loses days.',
      });
    await db.begin(async (tx) => {
      await tx`UPDATE hse.incident SET root_cause = ${input.rootCause}, status = 'investigated',
        days_lost = coalesce(${input.daysLost}, days_lost), row_version = row_version + 1 WHERE id = ${id}`;
      for (const a of input.actions)
        await tx`INSERT INTO hse.incident_action (incident_id, action, owner, due_on, created_by)
          VALUES (${id}, ${a.action}, ${a.owner}, ${a.dueOn}, ${claims.sub})`;
      await audit(tx, claims.sub, 'safety.investigate', 'incident', id, {
        actions: input.actions.length,
      });
    });
    return this.incident(claims, id);
  }

  async actionDone(claims: TenantClaims, actionId: string, doneOn: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [a] = await db<{ incident_id: string; project_id: string }[]>`
      SELECT a.incident_id, i.project_id FROM hse.incident_action a JOIN hse.incident i ON i.id = a.incident_id
      WHERE a.id = ${actionId}`;
    if (!a) throw new NotFoundException({ code: 'action_not_found' });
    await this.team(db, claims, a.project_id);
    await db`UPDATE hse.incident_action SET done_on = ${doneOn} WHERE id = ${actionId}`;
    return this.incident(claims, a.incident_id);
  }

  async close(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<{ project_id: string; status: string; kind: string }[]>`
      SELECT project_id, status, kind FROM hse.incident WHERE id = ${id}`;
    if (!i) throw new NotFoundException({ code: 'incident_not_found' });
    await this.manager(db, claims, i.project_id);
    if (i.status !== 'investigated' && i.kind !== 'near_miss' && i.kind !== 'first_aid')
      throw new ConflictException({
        code: 'not_investigated',
        message: 'Investigate it before closing it.',
      });
    const [open] =
      await db`SELECT 1 FROM hse.incident_action WHERE incident_id = ${id} AND done_on IS NULL`;
    if (open)
      throw new ConflictException({ code: 'actions_open', message: 'An action is still open.' });
    await db.begin(async (tx) => {
      await tx`UPDATE hse.incident SET status = 'closed', closed_by = ${claims.sub}, closed_on = (now() AT TIME ZONE 'Asia/Kolkata')::date,
        row_version = row_version + 1 WHERE id = ${id}`;
      await audit(tx, claims.sub, 'safety.close', 'incident', id, {});
    });
    return this.incident(claims, id);
  }

  // --- permits to work ---

  async requestPermit(
    claims: TenantClaims,
    projectId: string,
    input: {
      siteId: string | null;
      kind: PermitKind;
      location: string;
      work: string;
      validFrom: string;
      validTo: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const from = Date.parse(input.validFrom);
    const to = Date.parse(input.validTo);
    if (!(to > from) || to - from > 12 * 3_600_000)
      throw new BadRequestException({
        code: 'bad_validity',
        message: 'A permit runs for up to 12 hours.',
      });
    const id = await db.begin(async (tx) => {
      const number = await this.next(tx, projectId, 'permit');
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO hse.permit (project_id, number, site_id, kind, location, work, valid_from, valid_to, precautions,
          requested_by)
        VALUES (${projectId}, ${number}, ${input.siteId}, ${input.kind}, ${input.location}, ${input.work},
          ${input.validFrom}, ${input.validTo},
          ${tx.json(PRECAUTIONS[input.kind].map((text) => ({ text, confirmed: false })))}, ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'safety.permit', 'permit', p!.id, { number, kind: input.kind });
      return p!.id;
    });
    return this.permit(claims, id);
  }

  async permit(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<Record<string, unknown> & { projectId: string }[]>`
      SELECT p.id, p.project_id AS "projectId", p.number, p.kind, p.location, p.work, p.precautions,
        to_char(p.valid_from AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS "validFrom",
        to_char(p.valid_to AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS "validTo",
        CASE WHEN p.status = 'issued' AND p.valid_to < now() THEN 'expired' ELSE p.status END AS status,
        p.row_version AS "rowVersion"
      FROM hse.permit p WHERE p.id = ${id}`;
    if (!p) throw new NotFoundException({ code: 'permit_not_found' });
    await this.projects.access(db, claims, p.projectId);
    return p;
  }

  /** Issued with every precaution confirmed, by someone with `safety.manage` other than whoever asked. */
  async issue(claims: TenantClaims, id: string, confirmed: boolean[]) {
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<
      {
        project_id: string;
        status: string;
        requested_by: string;
        precautions: { text: string }[];
        valid_to: Date;
      }[]
    >`
      SELECT project_id, status, requested_by, precautions, valid_to FROM hse.permit WHERE id = ${id}`;
    if (!p) throw new NotFoundException({ code: 'permit_not_found' });
    await this.manager(db, claims, p.project_id);
    if (p.status !== 'requested')
      throw new ConflictException({ code: 'not_requested', message: 'Already dealt with.' });
    if (p.requested_by === claims.sub)
      throw new ForbiddenException({
        code: 'own_request',
        message: 'Someone other than whoever asked issues a permit.',
      });
    if (new Date(p.valid_to).getTime() < Date.now())
      throw new ConflictException({
        code: 'expired',
        message: 'The permit’s time has passed: ask again.',
      });
    if (confirmed.length !== p.precautions.length || confirmed.some((c) => !c))
      throw new BadRequestException({
        code: 'precautions',
        message: 'Confirm every precaution first.',
      });
    await db.begin(async (tx) => {
      await tx`UPDATE hse.permit SET status = 'issued', issued_by = ${claims.sub}, issued_at = now(),
        precautions = ${tx.json(p.precautions.map((x) => ({ text: x.text, confirmed: true })))},
        row_version = row_version + 1 WHERE id = ${id}`;
      await audit(tx, claims.sub, 'safety.permit_issue', 'permit', id, {});
    });
    return this.permit(claims, id);
  }

  async closePermit(claims: TenantClaims, id: string, input: { note: string; cancel: boolean }) {
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<{ project_id: string; status: string }[]>`
      SELECT project_id, status FROM hse.permit WHERE id = ${id}`;
    if (!p) throw new NotFoundException({ code: 'permit_not_found' });
    await this.team(db, claims, p.project_id);
    if (input.cancel ? p.status !== 'requested' : p.status !== 'issued')
      throw new ConflictException({
        code: 'wrong_state',
        message: input.cancel ? 'Only a request is cancelled.' : 'Only an issued permit is closed.',
      });
    await db`UPDATE hse.permit SET status = ${input.cancel ? 'cancelled' : 'closed'}, closed_by = ${claims.sub},
      closed_at = now(), closing_note = ${input.note}, row_version = row_version + 1 WHERE id = ${id}`;
    return this.permit(claims, id);
  }

  // --- toolbox talks ---

  async talk(
    claims: TenantClaims,
    projectId: string,
    input: {
      siteId: string | null;
      heldOn: string;
      topic: string;
      speaker: string;
      employeeIds: string[];
      workerIds: string[];
      others: number;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const [t] = await db<{ id: string }[]>`
      INSERT INTO hse.toolbox_talk (project_id, site_id, held_on, topic, speaker, employee_ids, worker_ids, others,
        created_by)
      VALUES (${projectId}, ${input.siteId}, ${input.heldOn}, ${input.topic}, ${input.speaker},
        ${input.employeeIds}::uuid[], ${input.workerIds}::uuid[], ${input.others}, ${claims.sub})
      RETURNING id`;
    return { id: t!.id };
  }

  // --- statistics ---

  /** Man-hours recorded on the project in the period, and its injury rates. */
  async statistics(claims: TenantClaims, projectId: string, from: string, to: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const [staff] = await db<{ h: string }[]>`
      SELECT coalesce(sum(CASE WHEN status IN ('present', 'on_duty') THEN ${DAY_HOURS}
        WHEN status = 'half_day' THEN ${DAY_HOURS / 2} ELSE 0 END), 0)::text AS h
      FROM hr.attendance WHERE project_id = ${projectId} AND day BETWEEN ${from} AND ${to}`;
    const [labour] = await db<{ h: string }[]>`
      SELECT coalesce(sum(CASE WHEN m.status = 'present' THEN ${DAY_HOURS} WHEN m.status = 'half_day' THEN ${DAY_HOURS / 2}
        ELSE 0 END + m.overtime_hours), 0)::text AS h
      FROM lab.muster m JOIN proj.site s ON s.id = m.site_id
      WHERE s.project_id = ${projectId} AND m.day BETWEEN ${from} AND ${to}`;
    const incidents = await db<{ kind: string; days_lost: number }[]>`
      SELECT kind, days_lost FROM hse.incident WHERE project_id = ${projectId}
        AND (occurred_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from} AND ${to}`;
    const byKind: Record<string, number> = {};
    for (const i of incidents) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    const staffHours = Number(staff!.h);
    const labourHours = Number(labour!.h);
    return {
      from,
      to,
      staffHours,
      labourHours,
      ...rates(
        staffHours + labourHours,
        incidents.map((i) => ({ kind: i.kind, daysLost: i.days_lost })),
      ),
      byKind,
    };
  }
}
