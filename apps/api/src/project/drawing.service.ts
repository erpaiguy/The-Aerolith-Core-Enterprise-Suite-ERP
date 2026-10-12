// The drawings register (docs/04-features.md R7, docs/wave2b-plan.md step 8): each drawing of a project by its
// number, and its revisions as they arrive (from whom, when, for information, approval or construction). Each revision's
// file is a version of one document in the project's vault (under Drawings / <discipline>), so the vault's preview,
// search and downloads work on drawings too. A new revision supersedes the one before, which stays readable.
// Controlled revisions (docs/wave5-plan.md step 4): a project's revision series is enforced here, and a new revision is
// distributed by the matrix: a receipt for each person inside, a draft transmittal for each party outside.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Sql, TransactionSql } from 'postgres';
import { indiaToday } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { DocumentsService, projectVault } from '../documents/documents.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { checkLabel, nextLabels, type Construction } from '../dms/revision-rules.js';
import { newTransmittal } from '../dms/transmittal-records.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
export type Discipline =
  | 'architectural'
  | 'structural'
  | 'electrical'
  | 'plumbing'
  | 'hvac'
  | 'fire'
  | 'landscape'
  | 'interiors'
  | 'other';
const FOLDER: Record<Discipline, string> = {
  architectural: 'Architectural',
  structural: 'Structural',
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac: 'HVAC',
  fire: 'Fire',
  landscape: 'Landscape',
  interiors: 'Interiors',
  other: 'Other',
};

interface DrawingRow {
  id: string;
  project_id: string;
  number: string;
  title: string;
  discipline: Discipline;
  document_id: string | null;
}

@Injectable()
export class DrawingService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly documents: DocumentsService,
    private readonly permissions: PermissionsService,
  ) {}

  /** The project's team with `documents.edit` keeps its register. */
  private async mustEdit(db: Db, claims: TenantClaims, projectId: string) {
    await this.documents.mustSee(db, claims, projectVault(projectId), true);
    if (!(await this.permissions.can(claims, 'documents.edit')))
      throw new ForbiddenException({ code: 'permission_denied', permission: 'documents.edit' });
  }

  private async drawing(db: Db, id: string) {
    const [d] = await db<DrawingRow[]>`SELECT * FROM proj.drawing WHERE id = ${id}`;
    if (!d) throw new NotFoundException({ code: 'drawing_not_found' });
    return d;
  }

  async create(
    claims: TenantClaims,
    projectId: string,
    input: { number: string; title: string; discipline: Discipline },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustEdit(db, claims, projectId);
    const id = await db.begin(async (tx) => {
      const [d] = await tx<{ id: string }[]>`
        INSERT INTO proj.drawing (project_id, number, title, discipline, created_by, updated_by)
        VALUES (${projectId}, ${input.number}, ${input.title}, ${input.discipline}, ${claims.sub}, ${claims.sub})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!d)
        throw new ConflictException({
          code: 'drawing_exists',
          message: `Drawing ${input.number} is already in the register.`,
        });
      await audit(tx, claims.sub, 'drawing.create', 'drawing', d.id, input);
      return d.id;
    });
    return this.get(claims, id);
  }

  /**
   * A revision as received, with its file: the drawing's document in the vault gets it as a new version (the first
   * makes the document). The revision before is superseded.
   */
  async addRevision(
    claims: TenantClaims,
    drawingId: string,
    input: {
      revision: string;
      purpose: 'information' | 'approval' | 'construction';
      receivedFrom: string;
      receivedOn: string;
      note: string;
    },
    file: { name: string; stream: Readable; truncated: () => boolean },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const d = await this.drawing(db, drawingId);
    await this.mustEdit(db, claims, d.project_id);
    if (input.receivedOn > indiaToday())
      throw new BadRequestException({ code: 'in_future', message: 'Not a date in the future.' });
    const [rule] = await db<{ enabled: boolean; construction: Construction }[]>`
      SELECT enabled, construction FROM dms.revision_rule WHERE project_id = ${d.project_id}`;
    if (rule?.enabled) {
      const so = await db<{ revision: string }[]>`
        SELECT revision FROM proj.drawing_revision WHERE drawing_id = ${drawingId} ORDER BY created_at, id`;
      const v = checkLabel(
        rule,
        so.map((r) => r.revision),
        input.revision,
        input.purpose,
      );
      if (!v.ok) throw new BadRequestException({ code: v.code, message: v.message });
      input = { ...input, revision: v.label };
    }
    const [dup] = await db`SELECT 1 FROM proj.drawing_revision
      WHERE drawing_id = ${drawingId} AND lower(revision) = lower(${input.revision})`;
    if (dup)
      throw new ConflictException({
        code: 'revision_exists',
        message: `Revision ${input.revision} of ${d.number} is already in the register.`,
      });
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(file.name)?.[0] ?? '';
    const name = `${d.number} ${d.title}`.replace(/[/\\]/g, '-').slice(0, 240) + ext;
    const up = await this.documents.upload(
      claims,
      projectVault(d.project_id),
      {
        folderId: null,
        path: d.document_id ? null : `Drawings/${FOLDER[d.discipline]}`,
        note: `Revision ${input.revision}`,
        documentId: d.document_id,
      },
      { ...file, name: d.document_id ? file.name : name },
    );
    if (up.outcome === 'unchanged')
      throw new ConflictException({
        code: 'same_file',
        message: 'That file is the revision already in the register.',
      });
    await db.begin(async (tx) => {
      if (!d.document_id)
        await tx`UPDATE proj.drawing SET document_id = ${up.document.id} WHERE id = ${drawingId}`;
      const [prev] = await tx<{ revision: string }[]>`
        UPDATE proj.drawing_revision SET superseded_at = now()
        WHERE drawing_id = ${drawingId} AND superseded_at IS NULL RETURNING revision`;
      const [rev] = await tx<{ id: string }[]>`
        INSERT INTO proj.drawing_revision (drawing_id, revision, purpose, received_from, received_on, note,
          version_no, created_by)
        VALUES (${drawingId}, ${input.revision}, ${input.purpose}, ${input.receivedFrom}, ${input.receivedOn},
          ${input.note}, ${up.document.versionNo}, ${claims.sub}) RETURNING id`;
      await this.distribute(tx, claims, d, {
        revisionId: rev!.id,
        label: input.revision,
        purpose: input.purpose,
        previous: prev?.revision ?? null,
        documentId: up.document.id,
        versionNo: up.document.versionNo,
      });
      await tx`UPDATE proj.drawing SET updated_at = now(), updated_by = ${claims.sub},
        row_version = row_version + 1 WHERE id = ${drawingId}`;
      await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
        VALUES (${d.project_id}, 'drawing_revision',
          ${tx.json({ number: d.number, revision: input.revision, purpose: input.purpose })}, ${claims.sub})`;
      await audit(tx, claims.sub, 'drawing.revision', 'drawing', drawingId, input);
    });
    return this.get(claims, drawingId);
  }

  /**
   * The distribution matrix (step 4): the project's rows for this discipline (construction revisions only, unless a
   * row takes every purpose). People inside get a notice and a receipt to acknowledge; parties outside a draft
   * transmittal of this revision, ready to issue.
   */
  private async distribute(
    tx: TransactionSql,
    claims: TenantClaims,
    d: DrawingRow,
    r: {
      revisionId: string;
      label: string;
      purpose: 'information' | 'approval' | 'construction';
      previous: string | null;
      documentId: string;
      versionNo: number;
    },
  ) {
    const rows = await tx<
      {
        user_id: string | null;
        party_id: string | null;
        name: string | null;
        email: string | null;
      }[]
    >`
      SELECT x.user_id, x.party_id, x.name, x.email FROM dms.distribution x
      LEFT JOIN platform."user" u ON u.id = x.user_id
      WHERE x.project_id = ${d.project_id} AND (x.discipline IS NULL OR x.discipline = ${d.discipline})
        AND (x.every_purpose OR ${r.purpose} = 'construction') AND (x.user_id IS NULL OR u.status = 'active')
      ORDER BY x.created_at, x.id`;
    const title = `${d.number} rev ${r.label} for ${r.purpose}${
      r.previous ? `: rev ${r.previous} is superseded; withdraw old prints` : ''
    }`;
    const people = [...new Set(rows.flatMap((x) => (x.user_id ? [x.user_id] : [])))];
    for (const u of people) {
      const [rc] = await tx<{ id: string }[]>`
        INSERT INTO dms.distribution_receipt (revision_id, user_id) VALUES (${r.revisionId}, ${u})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (rc)
        await tx`INSERT INTO platform.notification (user_id, kind, title, link, source)
          VALUES (${u}, 'drawing_issue', ${title}, ${`/drawing-receipts`}, ${`receipt:${rc.id}`})`;
    }
    for (const x of rows.filter((x) => !x.user_id)) {
      const id = await newTransmittal(tx, d.project_id, claims.sub, {
        subject: `${d.number} ${d.title} rev ${r.label}`.slice(0, 300),
        party_id: x.party_id,
        recipient: x.name!,
        email: x.email,
        purpose:
          r.purpose === 'construction'
            ? 'construction'
            : r.purpose === 'approval'
              ? 'review'
              : 'information',
        response_days: r.purpose === 'approval' ? 7 : null,
        notes: r.previous ? `Supersedes rev ${r.previous}.` : '',
      });
      await tx`INSERT INTO dms.transmittal_item (transmittal_id, position, document_id, version_no)
        VALUES (${id}, 1, ${r.documentId}, ${r.versionNo})`;
    }
  }

  async get(claims: TenantClaims, drawingId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const d = await this.drawing(db, drawingId);
    await this.documents.mustSee(db, claims, projectVault(d.project_id));
    const revisions = await db`
      SELECT r.id, r.revision, r.purpose, r.received_from AS "receivedFrom",
        to_char(r.received_on, 'YYYY-MM-DD') AS "receivedOn", r.note, r.version_no AS "versionNo",
        r.superseded_at AS "supersededAt", u.display_name AS "addedBy", r.created_at AS "createdAt",
        ${`/check/${claims.ten}/`} || r.check_code AS "checkPath",
        (SELECT count(*)::int FROM dms.distribution_receipt x WHERE x.revision_id = r.id) AS receipts,
        (SELECT count(*)::int FROM dms.distribution_receipt x WHERE x.revision_id = r.id AND x.acknowledged_at IS NOT NULL)
          AS acknowledged
      FROM proj.drawing_revision r LEFT JOIN platform."user" u ON u.id = r.created_by
      WHERE r.drawing_id = ${drawingId} ORDER BY r.created_at DESC`;
    const [rule] = await db<{ enabled: boolean; construction: Construction }[]>`
      SELECT enabled, construction FROM dms.revision_rule WHERE project_id = ${d.project_id}`;
    const mayEdit = await this.mustEdit(db, claims, d.project_id).then(
      () => true,
      () => false,
    );
    return {
      id: d.id,
      projectId: d.project_id,
      number: d.number,
      title: d.title,
      discipline: d.discipline,
      documentId: d.document_id,
      revisions,
      /** The labels the project's series allows next (null: the series is off). */
      next: rule?.enabled
        ? nextLabels(
            rule,
            [...revisions].reverse().map((r) => r.revision as string),
          )
        : null,
      mayEdit,
    };
  }

  /** The register: every drawing with its current revision, by discipline and number. */
  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.documents.mustSee(db, claims, projectVault(projectId));
    const drawings = await db`
      SELECT d.id, d.number, d.title, d.discipline, d.document_id AS "documentId",
        (SELECT count(*)::int FROM proj.drawing_revision r WHERE r.drawing_id = d.id) AS revisions,
        (SELECT json_build_object('revision', r.revision, 'purpose', r.purpose, 'receivedOn',
            to_char(r.received_on, 'YYYY-MM-DD'), 'receivedFrom', r.received_from, 'versionNo', r.version_no)
          FROM proj.drawing_revision r WHERE r.drawing_id = d.id AND r.superseded_at IS NULL) AS current
      FROM proj.drawing d WHERE d.project_id = ${projectId}
      ORDER BY d.discipline, lower(d.number)`;
    const mayEdit = await this.mustEdit(db, claims, projectId).then(
      () => true,
      () => false,
    );
    return { drawings, mayEdit };
  }
}
