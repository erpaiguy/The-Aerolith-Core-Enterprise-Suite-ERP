// Quality (docs/wave3-plan.md step 14): inspection requests covering measurement-book entries (holding uninspected
// work from billing when the project says so), checklist templates and filled checklists with photos, test records
// judged against criteria held as data (a failure raises an NCR), NCRs closed by someone other than who acted,
// snag lists, and material approvals a purchase order can require.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FileTooLargeError } from '../documents/file-store.js';
import { imageType, PHOTO_MAX } from '../project/daily-report.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import {
  BadTest,
  judgeBrick,
  judgeChecklist,
  judgeCube,
  judgeSlump,
  judgeSoil,
  judgeSteel,
  type ChecklistItem,
  type Judgement,
  type TestKind,
} from './quality-rules.js';

type Db = Sql | TransactionSql;
const PREFIX = { inspection: 'IR', test: 'QT', ncr: 'NCR' } as const;

@Injectable()
export class QualityService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly documents: DocumentsService,
  ) {}

  // --- who may ---

  /** The project's team (not its viewers) records quality; `quality.manage` decides, closes and approves. */
  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team records its quality.",
      });
  }

  private async manager(db: Db, claims: TenantClaims, projectId: string | null) {
    if (projectId) await this.projects.access(db, claims, projectId);
    if (!(await this.permissions.can(claims, 'quality.manage')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'quality.manage',
        message: 'This needs the quality permission.',
      });
  }

  /** The next number of a kind on a project: IR-001, QT-001, NCR-001. */
  private async next(tx: TransactionSql, projectId: string, kind: keyof typeof PREFIX) {
    await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
    const table = { inspection: tx`qa.inspection`, test: tx`qa.test`, ncr: tx`qa.ncr` }[kind];
    const [r] = await tx<
      { n: number }[]
    >`SELECT count(*)::int + 1 AS n FROM ${table} WHERE project_id = ${projectId}`;
    return `${PREFIX[kind]}-${String(r!.n).padStart(3, '0')}`;
  }

  // --- the project's quality register ---

  async register(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const [p] = await db<{ hold: boolean }[]>`
      SELECT hold_uninspected AS hold FROM proj.project WHERE id = ${projectId}`;
    const [inspections, checklists, tests, ncrs, snags, approvals, required] = await Promise.all([
      db`SELECT i.id, i.number, i.line_key AS "lineKey", n.code AS item, t.description, i.location, i.activity,
           to_char(i.requested_for, 'YYYY-MM-DD') AS "requestedFor", i.status, i.inspector, i.comments,
           to_char(i.decided_on, 'YYYY-MM-DD') AS "decidedOn",
           (SELECT coalesce(sum(m.qty), 0)::text FROM qa.inspection_measurement x
             JOIN proj.measurement m ON m.id = x.measurement_id WHERE x.inspection_id = i.id) AS qty
         FROM qa.inspection i
         LEFT JOIN est.boq_node n ON n.boq_id = i.boq_id AND n.line_key = i.line_key AND n.node_type = 'item'
         LEFT JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
         WHERE i.project_id = ${projectId} ORDER BY i.number DESC`,
      db`SELECT c.id, ct.name AS template, to_char(c.done_on, 'YYYY-MM-DD') AS "doneOn", c.location, c.result,
           (SELECT count(*)::int FROM qa.photo f WHERE f.checklist_id = c.id) AS photos
         FROM qa.checklist c JOIN qa.checklist_template ct ON ct.id = c.template_id
         WHERE c.project_id = ${projectId} ORDER BY c.done_on DESC, c.created_at DESC`,
      db`SELECT id, number, kind, sample_ref AS "sampleRef", location, to_char(tested_on, 'YYYY-MM-DD') AS "testedOn",
           spec, results, outcome, findings
         FROM qa.test WHERE project_id = ${projectId} ORDER BY number DESC`,
      db`SELECT id, number, source, description, responsible, to_char(due_on, 'YYYY-MM-DD') AS "dueOn", status,
           root_cause AS "rootCause", corrective_action AS "correctiveAction", closing_note AS "closingNote"
         FROM qa.ncr WHERE project_id = ${projectId} ORDER BY number DESC`,
      db`SELECT s.id, s.area, s.description, s.status, s.row_version AS "rowVersion",
           (SELECT count(*)::int FROM qa.photo f WHERE f.snag_id = s.id) AS photos
         FROM qa.snag s WHERE s.project_id = ${projectId} ORDER BY s.area, s.created_at`,
      db`SELECT a.id, r.code, r.name AS item, a.make, a.sample_ref AS "sampleRef", a.status, a.comments,
           to_char(a.decided_on, 'YYYY-MM-DD') AS "decidedOn"
         FROM qa.material_approval a JOIN est.resource r ON r.id = a.resource_id
         WHERE a.project_id = ${projectId} ORDER BY a.created_at DESC`,
      db`SELECT r.id, r.code, r.name FROM qa.make_required m JOIN est.resource r ON r.id = m.resource_id
         WHERE m.project_id = ${projectId} ORDER BY r.code`,
    ]);
    // Contract BOQ lines with measured work no standing request covers: what the site can ask to have inspected.
    const waiting = await db`
      SELECT m.line_key AS "lineKey", n.code, t.description, n.unit, sum(m.qty)::text AS qty
      FROM proj.measurement m
      JOIN est.boq_node n ON n.boq_id = m.boq_id AND n.line_key = m.line_key AND n.node_type = 'item'
      JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE m.project_id = ${projectId} AND NOT EXISTS (SELECT 1 FROM qa.inspection_measurement x
        JOIN qa.inspection i ON i.id = x.inspection_id WHERE x.measurement_id = m.id AND i.status <> 'rejected')
      GROUP BY m.line_key, n.code, t.description, n.unit HAVING sum(m.qty) <> 0 ORDER BY n.code`;
    return {
      holdUninspected: p!.hold,
      waiting,
      inspections,
      checklists,
      tests,
      ncrs,
      snags,
      materialApprovals: approvals,
      makeRequired: required,
      mayManage: await this.permissions.can(claims, 'quality.manage'),
    };
  }

  async setHold(claims: TenantClaims, projectId: string, hold: boolean) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.manager(db, claims, projectId);
    await db.begin(async (tx) => {
      await tx`UPDATE proj.project SET hold_uninspected = ${hold} WHERE id = ${projectId}`;
      await audit(tx, claims.sub, 'quality.hold', 'project', projectId, { hold });
    });
    return this.register(claims, projectId);
  }

  // --- inspection requests ---

  /** The site asks for an inspection of a contract BOQ line's work: it covers that line's entries not yet covered. */
  async requestInspection(
    claims: TenantClaims,
    projectId: string,
    input: {
      lineKey: string;
      siteId: string | null;
      location: string;
      activity: string;
      requestedFor: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const id = await db.begin(async (tx) => {
      const [boq] = await tx<{ id: string }[]>`
        SELECT b.id FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id
        WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
          AND n.line_key = ${input.lineKey} AND n.node_type = 'item' LIMIT 1`;
      if (!boq)
        throw new BadRequestException({
          code: 'line_not_found',
          message: "Not a line of the project's contract BOQ.",
        });
      const open = await tx<{ id: string }[]>`
        SELECT m.id FROM proj.measurement m
        WHERE m.project_id = ${projectId} AND m.line_key = ${input.lineKey} AND m.measured_on <= ${input.requestedFor}
          AND NOT EXISTS (SELECT 1 FROM qa.inspection_measurement x JOIN qa.inspection i ON i.id = x.inspection_id
            WHERE x.measurement_id = m.id AND i.status <> 'rejected')`;
      if (!open.length)
        throw new BadRequestException({
          code: 'nothing_to_inspect',
          message: 'No measured work on that line waits for inspection.',
        });
      const number = await this.next(tx, projectId, 'inspection');
      const [i] = await tx<{ id: string }[]>`
        INSERT INTO qa.inspection (project_id, number, site_id, boq_id, line_key, location, activity, requested_for,
          created_by)
        VALUES (${projectId}, ${number}, ${input.siteId}, ${boq.id}, ${input.lineKey}, ${input.location},
          ${input.activity}, ${input.requestedFor}, ${claims.sub})
        RETURNING id`;
      for (const m of open)
        await tx`INSERT INTO qa.inspection_measurement (inspection_id, measurement_id) VALUES (${i!.id}, ${m.id})`;
      await audit(tx, claims.sub, 'quality.inspection', 'inspection', i!.id, {
        number,
        entries: open.length,
      });
      return i!.id;
    });
    return this.inspection(claims, id);
  }

  async inspection(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<
      { project_id: string }[]
    >`SELECT project_id FROM qa.inspection WHERE id = ${id}`;
    if (!i) throw new NotFoundException({ code: 'inspection_not_found' });
    await this.projects.access(db, claims, i.project_id);
    const [row] = await db`
      SELECT i.id, i.number, i.project_id AS "projectId", i.line_key AS "lineKey", i.location, i.activity,
        to_char(i.requested_for, 'YYYY-MM-DD') AS "requestedFor", i.status, i.inspector, i.comments,
        to_char(i.decided_on, 'YYYY-MM-DD') AS "decidedOn",
        coalesce((SELECT json_agg(json_build_object('id', m.id, 'measuredOn', to_char(m.measured_on, 'YYYY-MM-DD'),
          'qty', m.qty::text, 'description', m.description) ORDER BY m.measured_on)
          FROM qa.inspection_measurement x JOIN proj.measurement m ON m.id = x.measurement_id
          WHERE x.inspection_id = i.id), '[]') AS entries
      FROM qa.inspection i WHERE i.id = ${id}`;
    return row;
  }

  /** The inspector's decision, recorded by whoever manages quality. A rejection frees the entries for a new request. */
  async decideInspection(
    claims: TenantClaims,
    id: string,
    input: {
      status: 'approved' | 'approved_with_comments' | 'rejected';
      inspector: string;
      comments: string;
      decidedOn: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<{ project_id: string; status: string }[]>`
      SELECT project_id, status FROM qa.inspection WHERE id = ${id}`;
    if (!i) throw new NotFoundException({ code: 'inspection_not_found' });
    await this.manager(db, claims, i.project_id);
    if (i.status !== 'requested')
      throw new ConflictException({
        code: 'decided',
        message: 'This inspection is already decided.',
      });
    if (input.status === 'rejected' && input.comments.trim().length < 3)
      throw new BadRequestException({ code: 'reason_needed', message: 'Say why it was rejected.' });
    await db.begin(async (tx) => {
      await tx`UPDATE qa.inspection SET status = ${input.status}, inspector = ${input.inspector},
        comments = ${input.comments}, decided_on = ${input.decidedOn}, decided_by = ${claims.sub},
        row_version = row_version + 1 WHERE id = ${id}`;
      if (input.status === 'rejected') {
        const number = await this.next(tx, i.project_id, 'ncr');
        await tx`INSERT INTO qa.ncr (project_id, number, source, inspection_id, description, created_by)
          VALUES (${i.project_id}, ${number}, 'inspection', ${id}, ${`Inspection rejected: ${input.comments}`},
            ${claims.sub})`;
      }
      await audit(tx, claims.sub, 'quality.inspection_decide', 'inspection', id, {
        status: input.status,
      });
    });
    return this.inspection(claims, id);
  }

  // --- checklists ---

  async templates(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT id, name, work_type AS "workType", items, active FROM qa.checklist_template
      ORDER BY NOT active, lower(name)`;
  }

  async addTemplate(
    claims: TenantClaims,
    input: { name: string; workType: string; items: ChecklistItem[] },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.manager(db, claims, null);
    await db
      .begin(async (tx) => {
        await tx`INSERT INTO qa.checklist_template (name, work_type, items, created_by)
          VALUES (${input.name}, ${input.workType}, ${tx.json(JSON.parse(JSON.stringify(input.items)))}, ${claims.sub})`;
        await audit(tx, claims.sub, 'quality.template', 'checklist_template', input.name, {});
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'template_exists',
            message: `There is already "${input.name}".`,
          });
        throw err;
      });
    return this.templates(claims);
  }

  async fillChecklist(
    claims: TenantClaims,
    projectId: string,
    input: {
      templateId: string;
      siteId: string | null;
      inspectionId: string | null;
      doneOn: string;
      location: string;
      answers: { answer: unknown; note: string }[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const [t] = await db<{ items: ChecklistItem[]; active: boolean }[]>`
      SELECT items, active FROM qa.checklist_template WHERE id = ${input.templateId}`;
    if (!t?.active)
      throw new BadRequestException({ code: 'template_not_found', message: 'No such checklist.' });
    let judged: ReturnType<typeof judgeChecklist>;
    try {
      judged = judgeChecklist(t.items, input.answers);
    } catch (e) {
      if (e instanceof BadTest)
        throw new BadRequestException({ code: 'bad_answers', message: e.message });
      throw e;
    }
    const id = await db.begin(async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO qa.checklist (project_id, site_id, template_id, inspection_id, items, answers, result, done_on,
          location, created_by)
        VALUES (${projectId}, ${input.siteId}, ${input.templateId}, ${input.inspectionId},
          ${tx.json(JSON.parse(JSON.stringify(t.items)))}, ${tx.json(JSON.parse(JSON.stringify(input.answers)))},
          ${judged.result}, ${input.doneOn}, ${input.location}, ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'quality.checklist', 'checklist', c!.id, {
        result: judged.result,
      });
      return c!.id;
    });
    return { id, ...judged };
  }

  async checklist(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [c] = await db<Record<string, unknown> & { projectId: string }[]>`
      SELECT c.id, c.project_id AS "projectId", ct.name AS template, c.items, c.answers, c.result,
        to_char(c.done_on, 'YYYY-MM-DD') AS "doneOn", c.location,
        coalesce((SELECT json_agg(json_build_object('id', f.id, 'caption', f.caption) ORDER BY f.created_at)
          FROM qa.photo f WHERE f.checklist_id = c.id), '[]') AS photos
      FROM qa.checklist c JOIN qa.checklist_template ct ON ct.id = c.template_id WHERE c.id = ${id}`;
    if (!c) throw new NotFoundException({ code: 'checklist_not_found' });
    await this.projects.access(db, claims, c.projectId);
    return c;
  }

  // --- photos (checklists and snags) ---

  async addPhoto(
    claims: TenantClaims,
    target: { checklistId: string } | { snagId: string },
    caption: string,
    file: { stream: Readable; truncated: () => boolean },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [owner] =
      'checklistId' in target
        ? await db<
            { project_id: string }[]
          >`SELECT project_id FROM qa.checklist WHERE id = ${target.checklistId}`
        : await db<
            { project_id: string }[]
          >`SELECT project_id FROM qa.snag WHERE id = ${target.snagId}`;
    if (!owner) throw new NotFoundException({ code: 'not_found' });
    await this.team(db, claims, owner.project_id);
    const store = await this.documents.store(claims.ten);
    const tooLarge = () =>
      new BadRequestException({ code: 'too_large', message: 'A photo is at most 8 MB.' });
    const staged = await store.stage(file.stream, PHOTO_MAX).catch((e: unknown) => {
      throw e instanceof FileTooLargeError ? tooLarge() : e;
    });
    if (file.truncated()) {
      await store.discard(staged);
      throw tooLarge();
    }
    const mime = imageType(staged.head);
    if (!mime) {
      await store.discard(staged);
      throw new BadRequestException({
        code: 'not_a_photo',
        message: 'Send a JPEG, PNG or WebP picture.',
      });
    }
    const key = await store.commit(staged);
    const [p] = await db<{ id: string }[]>`
      INSERT INTO qa.photo (checklist_id, snag_id, storage_key, mime, bytes, caption, created_by)
      VALUES (${'checklistId' in target ? target.checklistId : null}, ${'snagId' in target ? target.snagId : null},
        ${key}, ${mime}, ${staged.size}, ${caption}, ${claims.sub})
      RETURNING id`;
    return { id: p!.id };
  }

  async photo(claims: TenantClaims, photoId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<
      { storage_key: string; mime: string; bytes: number; project_id: string }[]
    >`
      SELECT f.storage_key, f.mime, f.bytes, coalesce(c.project_id, s.project_id) AS project_id FROM qa.photo f
      LEFT JOIN qa.checklist c ON c.id = f.checklist_id LEFT JOIN qa.snag s ON s.id = f.snag_id
      WHERE f.id = ${photoId}`;
    if (!p) throw new NotFoundException({ code: 'photo_not_found' });
    await this.projects.access(db, claims, p.project_id);
    const store = await this.documents.store(claims.ten);
    return { stream: await store.open(p.storage_key), mime: p.mime, size: p.bytes };
  }

  // --- tests ---

  async criteria(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT kind, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom", data, note
      FROM qa.test_criteria ORDER BY kind, effective_from DESC`;
  }

  async addCriteria(
    claims: TenantClaims,
    input: { kind: TestKind; effectiveFrom: string; data: object; note: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.manager(db, claims, null);
    await db
      .begin(async (tx) => {
        await tx`INSERT INTO qa.test_criteria (kind, effective_from, data, note, created_by)
          VALUES (${input.kind}, ${input.effectiveFrom}, ${tx.json(JSON.parse(JSON.stringify(input.data)))},
            ${input.note}, ${claims.sub})`;
        await audit(tx, claims.sub, 'quality.criteria', 'test_criteria', input.kind, { ...input });
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'criteria_exists',
            message: 'Criteria from that date are already in.',
          });
        throw err;
      });
    return this.criteria(claims);
  }

  /** A test recorded, judged by the criteria in force on the day it was tested; a failure raises an NCR. */
  async recordTest(
    claims: TenantClaims,
    projectId: string,
    input: {
      kind: TestKind;
      sampleRef: string;
      location: string;
      sampledOn: string;
      testedOn: string;
      spec: Record<string, unknown>;
      results: Record<string, unknown>;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const [c] = await db<{ data: Record<string, unknown> }[]>`
      SELECT data FROM qa.test_criteria WHERE kind = ${input.kind} AND effective_from <= ${input.testedOn}
      ORDER BY effective_from DESC LIMIT 1`;
    if (!c)
      throw new ConflictException({
        code: 'no_criteria',
        message: `No ${input.kind} criteria in force.`,
      });
    let j: Judgement;
    try {
      const d = c.data as never;
      j =
        input.kind === 'cube'
          ? judgeCube(input.spec as never, input.results as never, d)
          : input.kind === 'slump'
            ? judgeSlump(input.spec as never, input.results as never, d)
            : input.kind === 'steel'
              ? judgeSteel(input.spec as never, input.results as never, d)
              : input.kind === 'soil'
                ? judgeSoil(input.spec as never, input.results as never, d)
                : judgeBrick(input.spec as never, input.results as never, d);
    } catch (e) {
      if (e instanceof BadTest)
        throw new BadRequestException({ code: 'bad_test', message: e.message });
      throw e;
    }
    const { outcome, findings, ...measured } = j as Judgement & Record<string, unknown>;
    const out = await db.begin(async (tx) => {
      const number = await this.next(tx, projectId, 'test');
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO qa.test (project_id, number, kind, sample_ref, location, sampled_on, tested_on, spec, results,
          outcome, findings, created_by)
        VALUES (${projectId}, ${number}, ${input.kind}, ${input.sampleRef}, ${input.location}, ${input.sampledOn},
          ${input.testedOn}, ${tx.json(JSON.parse(JSON.stringify(input.spec)))},
          ${tx.json(JSON.parse(JSON.stringify({ ...input.results, ...measured })))}, ${outcome}, ${tx.json(findings)},
          ${claims.sub})
        RETURNING id`;
      let ncr: string | null = null;
      if (outcome === 'failed') {
        ncr = await this.next(tx, projectId, 'ncr');
        await tx`INSERT INTO qa.ncr (project_id, number, source, test_id, description, created_by)
          VALUES (${projectId}, ${ncr}, 'test', ${t!.id},
            ${`${number} (${input.kind}${input.sampleRef ? `, ${input.sampleRef}` : ''}) failed: ${findings.join(' ')}`.slice(0, 2000)},
            ${claims.sub})`;
      }
      await audit(tx, claims.sub, 'quality.test', 'test', t!.id, { number, outcome });
      return { id: t!.id, number, ncr };
    });
    return { ...out, outcome, findings };
  }

  // --- NCRs ---

  async raiseNcr(
    claims: TenantClaims,
    projectId: string,
    input: { description: string; responsible: string; dueOn: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const id = await db.begin(async (tx) => {
      const number = await this.next(tx, projectId, 'ncr');
      const [n] = await tx<{ id: string }[]>`
        INSERT INTO qa.ncr (project_id, number, source, description, responsible, due_on, created_by)
        VALUES (${projectId}, ${number}, 'manual', ${input.description}, ${input.responsible}, ${input.dueOn},
          ${claims.sub})
        RETURNING id`;
      return n!.id;
    });
    return this.ncr(claims, id);
  }

  async ncr(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [n] = await db<Record<string, unknown> & { projectId: string }[]>`
      SELECT n.id, n.project_id AS "projectId", n.number, n.source, n.description, n.root_cause AS "rootCause",
        n.corrective_action AS "correctiveAction", n.responsible, to_char(n.due_on, 'YYYY-MM-DD') AS "dueOn",
        n.status, a.display_name AS "actionBy", to_char(n.action_on, 'YYYY-MM-DD') AS "actionOn",
        c.display_name AS "closedBy", to_char(n.closed_on, 'YYYY-MM-DD') AS "closedOn", n.closing_note AS "closingNote",
        t.number AS test, i.number AS inspection, n.row_version AS "rowVersion"
      FROM qa.ncr n LEFT JOIN platform."user" a ON a.id = n.action_by LEFT JOIN platform."user" c ON c.id = n.closed_by
      LEFT JOIN qa.test t ON t.id = n.test_id LEFT JOIN qa.inspection i ON i.id = n.inspection_id
      WHERE n.id = ${id}`;
    if (!n) throw new NotFoundException({ code: 'ncr_not_found' });
    await this.projects.access(db, claims, n.projectId);
    return n;
  }

  /** The cause and the action taken, recorded by the project's team. */
  async actOnNcr(
    claims: TenantClaims,
    id: string,
    input: {
      rootCause: string;
      correctiveAction: string;
      responsible: string;
      dueOn: string | null;
      done: boolean;
      rowVersion: number;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [n] = await db<{ project_id: string; status: string; row_version: number }[]>`
      SELECT project_id, status, row_version FROM qa.ncr WHERE id = ${id}`;
    if (!n) throw new NotFoundException({ code: 'ncr_not_found' });
    await this.team(db, claims, n.project_id);
    if (n.status === 'closed')
      throw new ConflictException({ code: 'closed', message: 'The NCR is closed.' });
    if (n.row_version !== input.rowVersion)
      throw new ConflictException({
        code: 'stale',
        message: 'Someone else changed this NCR. Reload.',
      });
    if (input.done && (!input.rootCause.trim() || !input.correctiveAction.trim()))
      throw new BadRequestException({
        code: 'action_needed',
        message: 'Record the root cause and the corrective action taken.',
      });
    await db.begin(async (tx) => {
      await tx`UPDATE qa.ncr SET root_cause = ${input.rootCause}, corrective_action = ${input.correctiveAction},
        responsible = ${input.responsible}, due_on = ${input.dueOn},
        status = ${input.done ? 'action_taken' : 'open'}, action_by = ${input.done ? claims.sub : null},
        action_on = ${input.done ? new Date() : null}, row_version = row_version + 1 WHERE id = ${id}`;
      await audit(tx, claims.sub, 'quality.ncr_action', 'ncr', id, { done: input.done });
    });
    return this.ncr(claims, id);
  }

  /** Closed after the action is verified, by someone other than whoever took it. */
  async closeNcr(claims: TenantClaims, id: string, input: { note: string; reopen: boolean }) {
    const db = await this.tenants.forTenant(claims.ten);
    const [n] = await db<{ project_id: string; status: string; action_by: string | null }[]>`
      SELECT project_id, status, action_by FROM qa.ncr WHERE id = ${id}`;
    if (!n) throw new NotFoundException({ code: 'ncr_not_found' });
    await this.manager(db, claims, n.project_id);
    if (n.status !== 'action_taken')
      throw new ConflictException({
        code: 'no_action',
        message: 'Nothing has been done about it yet.',
      });
    if (!input.reopen && n.action_by === claims.sub)
      throw new ForbiddenException({
        code: 'own_action',
        message: 'Someone other than whoever took the action verifies and closes it.',
      });
    await db.begin(async (tx) => {
      if (input.reopen)
        await tx`UPDATE qa.ncr SET status = 'open', closing_note = ${input.note}, row_version = row_version + 1
          WHERE id = ${id}`;
      else
        await tx`UPDATE qa.ncr SET status = 'closed', closed_by = ${claims.sub}, closed_on = now(),
          closing_note = ${input.note}, row_version = row_version + 1 WHERE id = ${id}`;
      await audit(tx, claims.sub, 'quality.ncr_close', 'ncr', id, { reopen: input.reopen });
    });
    return this.ncr(claims, id);
  }

  // --- snags ---

  async addSnag(
    claims: TenantClaims,
    projectId: string,
    input: { area: string; description: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const [s] = await db<{ id: string }[]>`
      INSERT INTO qa.snag (project_id, area, description, created_by)
      VALUES (${projectId}, ${input.area}, ${input.description}, ${claims.sub}) RETURNING id`;
    return { id: s!.id };
  }

  async setSnag(
    claims: TenantClaims,
    id: string,
    input: { status: 'open' | 'fixed' | 'closed'; rowVersion: number },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<{ project_id: string; status: string; row_version: number }[]>`
      SELECT project_id, status, row_version FROM qa.snag WHERE id = ${id}`;
    if (!s) throw new NotFoundException({ code: 'snag_not_found' });
    await this.team(db, claims, s.project_id);
    if (s.row_version !== input.rowVersion)
      throw new ConflictException({
        code: 'stale',
        message: 'Someone else changed this snag. Reload.',
      });
    if (input.status === 'closed' && s.status !== 'fixed')
      throw new ConflictException({
        code: 'not_fixed',
        message: 'A snag is fixed before it is closed.',
      });
    await db`UPDATE qa.snag SET status = ${input.status},
      fixed_on = CASE WHEN ${input.status} = 'fixed' THEN current_date ELSE fixed_on END,
      closed_on = CASE WHEN ${input.status} = 'closed' THEN current_date ELSE NULL END,
      row_version = row_version + 1 WHERE id = ${id}`;
    return this.register(claims, s.project_id);
  }

  // --- material approvals ---

  async requireMake(
    claims: TenantClaims,
    projectId: string,
    resourceId: string,
    required: boolean,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.manager(db, claims, projectId);
    if (required)
      await db`INSERT INTO qa.make_required (project_id, resource_id) VALUES (${projectId}, ${resourceId})
        ON CONFLICT DO NOTHING`;
    else
      await db`DELETE FROM qa.make_required WHERE project_id = ${projectId} AND resource_id = ${resourceId}`;
    return this.register(claims, projectId);
  }

  async submitMake(
    claims: TenantClaims,
    projectId: string,
    input: { resourceId: string; make: string; sampleRef: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    const [r] = await db`SELECT 1 FROM est.resource WHERE id = ${input.resourceId}`;
    if (!r) throw new BadRequestException({ code: 'resource_not_found', message: 'No such item.' });
    const [a] = await db<{ id: string }[]>`
      INSERT INTO qa.material_approval (project_id, resource_id, make, sample_ref, created_by)
      VALUES (${projectId}, ${input.resourceId}, ${input.make}, ${input.sampleRef}, ${claims.sub}) RETURNING id`;
    return { id: a!.id };
  }

  async decideMake(
    claims: TenantClaims,
    id: string,
    input: { status: 'approved' | 'rejected'; comments: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [a] = await db<{ project_id: string; status: string }[]>`
      SELECT project_id, status FROM qa.material_approval WHERE id = ${id}`;
    if (!a) throw new NotFoundException({ code: 'approval_not_found' });
    await this.manager(db, claims, a.project_id);
    if (a.status !== 'submitted')
      throw new ConflictException({ code: 'decided', message: 'Already decided.' });
    await db.begin(async (tx) => {
      await tx`UPDATE qa.material_approval SET status = ${input.status}, comments = ${input.comments},
        decided_on = current_date, decided_by = ${claims.sub} WHERE id = ${id}`;
      await audit(tx, claims.sub, 'quality.make', 'material_approval', id, {
        status: input.status,
      });
    });
    return this.register(claims, a.project_id);
  }

  /** The order's items that need an approved make on the project and have none (a purchase order is refused). */
  static async unapprovedMakes(db: Db, projectId: string, revisionId: string) {
    return db<{ code: string; name: string }[]>`
      SELECT DISTINCT r.code, r.name FROM proc.po_line l JOIN est.resource r ON r.id = l.resource_id
      JOIN qa.make_required m ON m.project_id = ${projectId} AND m.resource_id = l.resource_id
      WHERE l.revision_id = ${revisionId} AND NOT EXISTS (SELECT 1 FROM qa.material_approval a
        WHERE a.project_id = ${projectId} AND a.resource_id = l.resource_id AND a.status = 'approved')
      ORDER BY r.code`;
  }
}
