// Controlled revisions (docs/wave5-plan.md step 4): a project's revision series (enforced by the drawings register),
// the distribution matrix, people's receipts for new revisions, the controlled copy (the PDF stamped on every page
// with the revision and a QR) and the check behind the QR, which needs no account and says only current or not.
import { Buffer } from 'node:buffer';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { DocumentsService, projectVault } from '../documents/documents.service.js';
import type { Discipline } from '../project/drawing.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { stampPdf } from './pdf-stamp.js';
import type { Construction } from './revision-rules.js';

type Db = Sql | TransactionSql;

@Injectable()
export class RevisionService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly documents: DocumentsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The project's lead or a project editor. */
  private async manager(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'lead')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's lead or a project editor sets this.",
      });
  }

  // --- the series and the matrix ---

  async settings(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const [rule] = await db<{ enabled: boolean; construction: Construction }[]>`
      SELECT enabled, construction FROM dms.revision_rule WHERE project_id = ${projectId}`;
    const matrix = await db`
      SELECT x.id, x.discipline, x.user_id AS "userId", u.display_name AS "user", x.party_id AS "partyId", x.name,
        x.email, x.every_purpose AS "everyPurpose"
      FROM dms.distribution x LEFT JOIN platform."user" u ON u.id = x.user_id
      WHERE x.project_id = ${projectId} ORDER BY x.discipline NULLS FIRST, x.created_at`;
    return { rule: rule ?? { enabled: false, construction: 'numbers' }, matrix };
  }

  async setRule(
    claims: TenantClaims,
    projectId: string,
    input: { enabled: boolean; construction: Construction },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.manager(db, claims, projectId);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO dms.revision_rule (project_id, enabled, construction, updated_by)
        VALUES (${projectId}, ${input.enabled}, ${input.construction}, ${claims.sub})
        ON CONFLICT (project_id) DO UPDATE SET enabled = EXCLUDED.enabled, construction = EXCLUDED.construction,
          updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'revision_rule.set', 'project', projectId, input);
    });
    return this.settings(claims, projectId);
  }

  async addDistribution(
    claims: TenantClaims,
    projectId: string,
    input: {
      discipline: Discipline | null;
      userId: string | null;
      partyId: string | null;
      name: string | null;
      email: string | null;
      everyPurpose: boolean;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.manager(db, claims, projectId);
    if (!input.userId === !input.name)
      throw new BadRequestException({
        code: 'who',
        message: 'Either a person inside or a party outside (a name).',
      });
    if (input.userId) {
      const [m] = await db`
        SELECT 1 FROM proj.member WHERE project_id = ${projectId} AND user_id = ${input.userId}`;
      if (!m)
        throw new BadRequestException({
          code: 'not_on_project',
          message: 'Only people on the project are on its matrix.',
        });
    }
    if (input.partyId) {
      const [p] =
        await db`SELECT 1 FROM platform.party WHERE id = ${input.partyId} AND deleted_at IS NULL`;
      if (!p) throw new NotFoundException({ code: 'no_such_party', message: 'No such party.' });
    }
    await db.begin(async (tx) => {
      const [x] = await tx<{ id: string }[]>`
        INSERT INTO dms.distribution ${tx({
          project_id: projectId,
          discipline: input.discipline,
          user_id: input.userId,
          party_id: input.userId ? null : input.partyId,
          name: input.userId ? null : input.name,
          email: input.userId ? null : input.email,
          every_purpose: input.everyPurpose,
          created_by: claims.sub,
        })} RETURNING id`;
      await audit(tx, claims.sub, 'distribution.add', 'project', projectId, { id: x!.id });
    });
    return this.settings(claims, projectId);
  }

  async removeDistribution(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [x] = await db<{ project_id: string }[]>`
      SELECT project_id FROM dms.distribution WHERE id = ${id}`;
    if (!x) throw new NotFoundException({ code: 'not_found', message: 'No such row.' });
    await this.manager(db, claims, x.project_id);
    await db.begin(async (tx) => {
      await tx`DELETE FROM dms.distribution WHERE id = ${id}`;
      await audit(tx, claims.sub, 'distribution.remove', 'project', x.project_id, { id });
    });
    return this.settings(claims, x.project_id);
  }

  // --- receipts ---

  /** The revisions sent to me, newest first; the ones I have not acknowledged first of all. */
  async receipts(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT x.id, d.number, d.title, r.revision, r.purpose, p.number AS project, x.created_at AS "sentAt",
        x.acknowledged_at AS "acknowledgedAt",
        (SELECT o.revision FROM proj.drawing_revision o WHERE o.drawing_id = r.drawing_id AND o.created_at < r.created_at
          ORDER BY o.created_at DESC LIMIT 1) AS supersedes
      FROM dms.distribution_receipt x JOIN proj.drawing_revision r ON r.id = x.revision_id
      JOIN proj.drawing d ON d.id = r.drawing_id JOIN proj.project p ON p.id = d.project_id
      WHERE x.user_id = ${claims.sub}
      ORDER BY x.acknowledged_at IS NOT NULL, x.created_at DESC LIMIT 200`;
  }

  async acknowledge(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [x] = await db<{ user_id: string }[]>`
      SELECT user_id FROM dms.distribution_receipt WHERE id = ${id}`;
    if (!x || x.user_id !== claims.sub)
      throw new NotFoundException({ code: 'not_found', message: 'No such receipt.' });
    await db.begin(async (tx) => {
      await tx`UPDATE dms.distribution_receipt SET acknowledged_at = coalesce(acknowledged_at, now()) WHERE id = ${id}`;
      await tx`UPDATE platform.notification SET read_at = coalesce(read_at, now()) WHERE source = ${`receipt:${id}`}`;
      await audit(tx, claims.sub, 'distribution.acknowledge', 'receipt', id, {});
    });
    return this.receipts(claims);
  }

  // --- the controlled copy and its check ---

  /** A revision's PDF with the stamp and the QR on every page. The QR opens the check page on the public site. */
  async print(claims: TenantClaims, revisionId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db<
      {
        revision: string;
        purpose: string;
        version_no: number | null;
        check_code: string;
        superseded_at: Date | null;
        number: string;
        title: string;
        project_id: string;
        document_id: string | null;
      }[]
    >`
      SELECT r.revision, r.purpose, r.version_no, r.check_code, r.superseded_at, d.number, d.title, d.project_id,
        d.document_id
      FROM proj.drawing_revision r JOIN proj.drawing d ON d.id = r.drawing_id WHERE r.id = ${revisionId}`;
    if (!r) throw new NotFoundException({ code: 'not_found', message: 'No such revision.' });
    await this.documents.mustSee(db, claims, projectVault(r.project_id));
    await this.projects.access(db, claims, r.project_id);
    if (!r.document_id || !r.version_no)
      throw new NotFoundException({ code: 'no_file', message: 'This revision has no file.' });
    const f = await this.documents.file(claims, r.document_id, r.version_no);
    if (f.mime !== 'application/pdf')
      throw new BadRequestException({
        code: 'not_pdf',
        message: 'Only a PDF is printed as a controlled copy.',
      });
    const chunks: Buffer[] = [];
    for await (const c of f.stream) chunks.push(Buffer.from(c as Uint8Array));
    const printed = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const bytes = await stampPdf(Buffer.concat(chunks), {
      lines: [
        `${r.number} rev ${r.revision} · for ${r.purpose}`,
        `CONTROLLED COPY · printed ${printed}`,
        r.superseded_at ? 'SUPERSEDED: do not use for construction' : 'Scan to check it is current',
      ],
      qr: `${new URL(this.config.publicApiUrl).origin}/check/${claims.ten}/${r.check_code}`,
      warn: !!r.superseded_at,
    });
    await db.begin((tx) =>
      audit(tx, claims.sub, 'drawing.print', 'drawing_revision', revisionId, {
        number: r.number,
        revision: r.revision,
      }),
    );
    return {
      bytes,
      fileName: `${r.number} rev ${r.revision} controlled copy.pdf`.replace(/[/\\]/g, '-'),
    };
  }

  /** What the QR says, to anyone holding the print: the drawing, this revision, and whether it is current. */
  async check(tenantId: string, code: string) {
    const db = await this.tenants.forTenant(tenantId);
    const [r] = await db<
      {
        drawing_id: string;
        revision: string;
        purpose: string;
        superseded_at: Date | null;
        number: string;
        title: string;
        project: string;
      }[]
    >`
      SELECT r.drawing_id, r.revision, r.purpose, r.superseded_at, d.number, d.title, p.number || ' ' || p.name AS project
      FROM proj.drawing_revision r JOIN proj.drawing d ON d.id = r.drawing_id JOIN proj.project p ON p.id = d.project_id
      WHERE r.check_code = ${code}`;
    if (!r) throw new NotFoundException({ code: 'unknown', message: 'This code is not known.' });
    const [cur] = await db<{ revision: string; purpose: string; received_on: string }[]>`
      SELECT revision, purpose, to_char(received_on, 'YYYY-MM-DD') AS received_on FROM proj.drawing_revision
      WHERE drawing_id = ${r.drawing_id} AND superseded_at IS NULL`;
    return {
      project: r.project,
      number: r.number,
      title: r.title,
      revision: r.revision,
      purpose: r.purpose,
      current: !r.superseded_at,
      supersededOn: r.superseded_at
        ? r.superseded_at.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
        : null,
      latest: cur
        ? { revision: cur.revision, purpose: cur.purpose, receivedOn: cur.received_on }
        : null,
    };
  }
}
