// Transmittals (docs/wave5-plan.md step 3): document versions issued to a recipient for a purpose, acknowledged and
// answered. Staff record what happened, or the recipient does it themselves through an expiring link: 32 random bytes
// of which only the SHA-256 is kept, so the database holds no working link. Every use of a link is recorded.
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { DocumentsService, projectVault } from '../documents/documents.service.js';
import { featuresUnlocked } from '../licensing/licence-rules.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
type Purpose = 'information' | 'review' | 'construction' | 'record';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const sha256 = (s: string) => createHash('sha256').update(s).digest();

interface Row {
  id: string;
  project_id: string;
  number: string;
  subject: string;
  recipient: string;
  purpose: Purpose;
  status: 'draft' | 'issued' | 'acknowledged' | 'responded' | 'closed';
  issued_by: string | null;
  created_by: string;
}

export interface TransmittalInput {
  subject: string;
  partyId: string | null;
  recipient: string;
  email: string | null;
  purpose: Purpose;
  responseDays: number | null;
  notes: string;
  items: { documentId: string; versionNo: number | null; copies: number; remark: string }[];
}

@Injectable()
export class TransmittalService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly documents: DocumentsService,
    private readonly licensing: LicensingService,
  ) {}

  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team issues transmittals.",
      });
  }

  private async row(db: Db, id: string) {
    const [t] = await db<Row[]>`SELECT * FROM dms.transmittal WHERE id = ${id}`;
    if (!t) throw new NotFoundException({ code: 'not_found', message: 'No such transmittal.' });
    return t;
  }

  /** The items with their documents' names, in order. */
  private items(db: Db, id: string) {
    return db<
      {
        id: string;
        documentId: string;
        name: string;
        versionNo: number;
        latest: number;
        copies: number;
        remark: string;
      }[]
    >`
      SELECT i.id, i.document_id AS "documentId", d.name, i.version_no AS "versionNo", d.version_no AS latest,
        i.copies, i.remark
      FROM dms.transmittal_item i JOIN doc.document d ON d.id = i.document_id
      WHERE i.transmittal_id = ${id} ORDER BY i.position`;
  }

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return db`
      SELECT t.id, t.number, t.subject, t.recipient, t.purpose, t.status, to_char(t.issued_on, 'YYYY-MM-DD') AS "issuedOn",
        to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn", t.response_code AS "responseCode",
        t.status IN ('issued', 'acknowledged') AND t.due_on < ${today()}::date AS overdue,
        (SELECT count(*)::int FROM dms.transmittal_item i WHERE i.transmittal_id = t.id) AS items
      FROM dms.transmittal t WHERE t.project_id = ${projectId} ORDER BY t.number DESC`;
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const t = await this.row(db, id);
    await this.projects.access(db, claims, t.project_id);
    return this.detail(db, id);
  }

  private async detail(db: Db, id: string) {
    const [t] = await db<
      {
        id: string;
        projectId: string;
        number: string;
        subject: string;
        recipient: string;
        purpose: Purpose;
        notes: string;
        status: Row['status'];
        issuedOn: string | null;
        dueOn: string | null;
        acknowledgedAt: Date | null;
        acknowledgedBy: string | null;
        response: string | null;
        responseCode: string | null;
        respondedAt: Date | null;
        respondedBy: string | null;
      }[]
    >`
      SELECT t.id, t.project_id AS "projectId", t.number, t.subject, t.party_id AS "partyId", t.recipient, t.email,
        t.purpose, t.response_days AS "responseDays", t.notes, t.status,
        to_char(t.issued_on, 'YYYY-MM-DD') AS "issuedOn", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn",
        t.acknowledged_at AS "acknowledgedAt", t.acknowledged_by AS "acknowledgedBy", t.response,
        t.response_code AS "responseCode", t.response_document_id AS "responseDocumentId", rd.name AS "responseDocument",
        t.responded_at AS "respondedAt", t.responded_by AS "respondedBy", t.closed_at AS "closedAt",
        t.status IN ('issued', 'acknowledged') AND t.due_on < ${today()}::date AS overdue, t.row_version AS "rowVersion"
      FROM dms.transmittal t LEFT JOIN doc.document rd ON rd.id = t.response_document_id WHERE t.id = ${id}`;
    const links = await db`
      SELECT id, expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt",
        revoked_at IS NULL AND expires_at > now() AS live
      FROM dms.share_link WHERE transmittal_id = ${id} ORDER BY created_at DESC`;
    const events = await db`
      SELECT e.kind, e.detail, e.ip, e.at FROM dms.share_event e JOIN dms.share_link l ON l.id = e.link_id
      WHERE l.transmittal_id = ${id} ORDER BY e.at, e.id`;
    return { ...t!, items: await this.items(db, id), links, events };
  }

  /** A draft, new or changed: its header and items, every item a version in this project's vault. */
  async save(claims: TenantClaims, projectId: string, id: string | null, input: TransmittalInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    if (input.purpose === 'review' && !input.responseDays)
      throw new BadRequestException({
        code: 'response_days',
        message: 'A transmittal for review needs the days allowed for a response.',
      });
    if (input.partyId) {
      const [p] =
        await db`SELECT 1 FROM platform.party WHERE id = ${input.partyId} AND deleted_at IS NULL`;
      if (!p) throw new NotFoundException({ code: 'no_such_party', message: 'No such party.' });
    }
    const items: { documentId: string; versionNo: number; copies: number; remark: string }[] = [];
    for (const it of input.items) {
      const [d] = await db<{ version_no: number }[]>`
        SELECT version_no FROM doc.document WHERE id = ${it.documentId} AND project_id = ${projectId} AND deleted_at IS NULL`;
      if (!d)
        throw new NotFoundException({
          code: 'no_such_document',
          message: "Every item must be in this project's documents.",
        });
      const versionNo = it.versionNo ?? d.version_no;
      const [v] =
        await db`SELECT 1 FROM doc.document_version WHERE document_id = ${it.documentId} AND version_no = ${versionNo}`;
      if (!v)
        throw new NotFoundException({
          code: 'no_such_version',
          message: `No version ${versionNo}.`,
        });
      if (items.some((x) => x.documentId === it.documentId && x.versionNo === versionNo))
        throw new BadRequestException({
          code: 'duplicate_item',
          message: 'A version is listed twice.',
        });
      items.push({ ...it, versionNo });
    }
    const header = {
      subject: input.subject,
      party_id: input.partyId,
      recipient: input.recipient,
      email: input.email,
      purpose: input.purpose,
      response_days: input.purpose === 'information' ? null : input.responseDays,
      notes: input.notes,
    };
    const saved = await db.begin(async (tx) => {
      let tid: string;
      if (id) {
        const t = await this.row(tx, id);
        if (t.project_id !== projectId)
          throw new NotFoundException({ code: 'not_found', message: 'No such transmittal.' });
        if (t.status !== 'draft')
          throw new ConflictException({
            code: 'issued',
            message: 'An issued transmittal cannot be changed.',
          });
        await tx`UPDATE dms.transmittal SET ${tx(header)}, row_version = row_version + 1 WHERE id = ${id}`;
        await tx`DELETE FROM dms.transmittal_item WHERE transmittal_id = ${id}`;
        tid = id;
      } else {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`transmittal:${projectId}`}))`;
        const [n] = await tx<{ n: number }[]>`
          SELECT count(*)::int + 1 AS n FROM dms.transmittal WHERE project_id = ${projectId}`;
        const [t] = await tx<{ id: string }[]>`
          INSERT INTO dms.transmittal ${tx({
            ...header,
            project_id: projectId,
            number: `TR-${String(n!.n).padStart(3, '0')}`,
            created_by: claims.sub,
          })} RETURNING id`;
        tid = t!.id;
      }
      for (const [i, it] of items.entries())
        await tx`
          INSERT INTO dms.transmittal_item (transmittal_id, position, document_id, version_no, copies, remark)
          VALUES (${tid}, ${i + 1}, ${it.documentId}, ${it.versionNo}, ${it.copies}, ${it.remark})`;
      await audit(
        tx,
        claims.sub,
        id ? 'transmittal.update' : 'transmittal.create',
        'transmittal',
        tid,
        {
          items: items.length,
        },
      );
      return tid;
    });
    return this.detail(db, saved);
  }

  /** Issued: the items are frozen and the response clock starts. */
  async issue(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const t = await this.row(db, id);
    await this.team(db, claims, t.project_id);
    if (t.status !== 'draft')
      throw new ConflictException({ code: 'issued', message: 'Already issued.' });
    const [c] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM dms.transmittal_item WHERE transmittal_id = ${id}`;
    if (!c?.n)
      throw new BadRequestException({
        code: 'no_items',
        message: 'Nothing to issue: add a document.',
      });
    await db.begin(async (tx) => {
      const on = today();
      await tx`
        UPDATE dms.transmittal SET status = 'issued', issued_on = ${on}, issued_by = ${claims.sub},
          due_on = CASE WHEN response_days IS NULL THEN NULL ELSE ${on}::date + response_days END,
          row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'transmittal.issue', 'transmittal', id, { number: t.number });
    });
    return this.detail(db, id);
  }

  /** A new link for the recipient; any earlier one stops working. The token is shown once, here. */
  async makeLink(claims: TenantClaims, id: string, days: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const t = await this.row(db, id);
    await this.team(db, claims, t.project_id);
    if (t.status === 'draft' || t.status === 'closed')
      throw new ConflictException({
        code: 'not_issued',
        message: 'Only an issued, open transmittal can be shared.',
      });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    await db.begin(async (tx) => {
      await tx`UPDATE dms.share_link SET revoked_at = now() WHERE transmittal_id = ${id} AND revoked_at IS NULL`;
      const [l] = await tx<{ id: string }[]>`
        INSERT INTO dms.share_link (transmittal_id, token_hash, expires_at, created_by)
        VALUES (${id}, ${sha256(token)}, ${expiresAt}, ${claims.sub}) RETURNING id`;
      await audit(tx, claims.sub, 'transmittal.link', 'transmittal', id, {
        linkId: l!.id,
        expiresAt,
      });
    });
    return { token, path: `/share/${claims.ten}/${token}`, expiresAt };
  }

  async revokeLinks(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const t = await this.row(db, id);
    await this.team(db, claims, t.project_id);
    await db.begin(async (tx) => {
      await tx`UPDATE dms.share_link SET revoked_at = now() WHERE transmittal_id = ${id} AND revoked_at IS NULL`;
      await audit(tx, claims.sub, 'transmittal.unlink', 'transmittal', id, {});
    });
    return this.detail(db, id);
  }

  // --- what happened: recorded by staff or through the link ---

  private async acknowledgeTx(tx: TransactionSql, t: Row, by: string) {
    if (t.status === 'draft' || t.status === 'closed')
      throw new ConflictException({ code: 'not_open', message: 'This transmittal is not open.' });
    await tx`
      UPDATE dms.transmittal SET acknowledged_at = coalesce(acknowledged_at, now()),
        acknowledged_by = coalesce(acknowledged_by, ${by}),
        status = CASE WHEN status = 'issued' THEN 'acknowledged' ELSE status END, row_version = row_version + 1
      WHERE id = ${t.id}`;
  }

  private async respondTx(
    tx: TransactionSql,
    t: Row,
    input: { by: string; response: string; code: string | null; documentId: string | null },
  ) {
    if (t.status === 'draft' || t.status === 'closed')
      throw new ConflictException({ code: 'not_open', message: 'This transmittal is not open.' });
    if (t.status === 'responded')
      throw new ConflictException({
        code: 'responded',
        message: 'A response is already recorded.',
      });
    if (input.code) {
      const [c] = await tx`SELECT 1 FROM dms.status_code WHERE code = ${input.code} AND active`;
      if (!c) throw new BadRequestException({ code: 'no_such_code', message: 'No such code.' });
    }
    await tx`
      UPDATE dms.transmittal SET status = 'responded', response = ${input.response}, response_code = ${input.code},
        response_document_id = ${input.documentId}, responded_at = now(), responded_by = ${input.by},
        acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, ${input.by}),
        row_version = row_version + 1
      WHERE id = ${t.id}`;
    const by = t.issued_by ?? t.created_by;
    await tx`INSERT INTO platform.notification (user_id, kind, title, link)
      VALUES (${by}, 'transmittal', ${`${t.number} ${t.subject}: ${input.by} responded${input.code ? ` (${input.code})` : ''}`},
        ${`/transmittals?project=${t.project_id}&open=${t.id}`})`;
  }

  async acknowledge(claims: TenantClaims, id: string, by: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const t = await this.row(db, id);
    await this.team(db, claims, t.project_id);
    await db.begin(async (tx) => {
      await this.acknowledgeTx(tx, t, by);
      await audit(tx, claims.sub, 'transmittal.acknowledge', 'transmittal', id, { by });
    });
    return this.detail(db, id);
  }

  async respond(
    claims: TenantClaims,
    id: string,
    input: { by: string; response: string; code: string | null; documentId: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const t = await this.row(db, id);
    await this.team(db, claims, t.project_id);
    if (input.documentId) {
      const [d] = await db`
        SELECT 1 FROM doc.document WHERE id = ${input.documentId} AND project_id = ${t.project_id} AND deleted_at IS NULL`;
      if (!d)
        throw new NotFoundException({
          code: 'no_such_document',
          message: "The response must be in this project's documents.",
        });
    }
    await db.begin(async (tx) => {
      await this.respondTx(tx, t, input);
      await audit(tx, claims.sub, 'transmittal.respond', 'transmittal', id, {
        by: input.by,
        code: input.code,
      });
    });
    return this.detail(db, id);
  }

  async close(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const t = await this.row(db, id);
    await this.team(db, claims, t.project_id);
    if (t.status === 'draft' || t.status === 'closed')
      throw new ConflictException({ code: 'not_open', message: 'This transmittal is not open.' });
    await db.begin(async (tx) => {
      await tx`UPDATE dms.transmittal SET status = 'closed', closed_at = now(), row_version = row_version + 1 WHERE id = ${id}`;
      await tx`UPDATE dms.share_link SET revoked_at = now() WHERE transmittal_id = ${id} AND revoked_at IS NULL`;
      await audit(tx, claims.sub, 'transmittal.close', 'transmittal', id, {});
    });
    return this.detail(db, id);
  }

  // --- the outsider's link: no account, only the token ---

  /** The link behind a token, or why not: unknown (404), expired or revoked (410), the tenant's licence lapsed (403). */
  private async open(tenantId: string, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new NotFoundException({ code: 'no_such_link', message: 'This link is not valid.' });
    const db = await this.tenants.forTenant(tenantId);
    const [l] = await db<
      { id: string; transmittal_id: string; expires_at: Date; revoked_at: Date | null }[]
    >`SELECT id, transmittal_id, expires_at, revoked_at FROM dms.share_link WHERE token_hash = ${sha256(token)}`;
    if (!l)
      throw new NotFoundException({ code: 'no_such_link', message: 'This link is not valid.' });
    if (l.revoked_at || l.expires_at <= new Date())
      throw new GoneException({
        code: 'link_expired',
        message: 'This link has expired or was withdrawn. Ask the sender for a new one.',
      });
    const lic = await this.licensing.tenantLicence(tenantId);
    if (!featuresUnlocked(lic.state))
      throw new ForbiddenException({
        code: 'licence_read_only',
        message: 'This link is not available at the moment.',
      });
    const t = await this.row(db, l.transmittal_id);
    return { db, link: l, t, lic: lic.state };
  }

  /** The person the link acts as when it reads or stores a file: whoever issued the transmittal. */
  private async issuer(
    db: Db,
    tenantId: string,
    t: Row,
    lic: TenantClaims['lic'],
  ): Promise<TenantClaims> {
    const sub = t.issued_by ?? t.created_by;
    const [u] = await db<
      { role: TenantClaims['role'] }[]
    >`SELECT role FROM platform."user" WHERE id = ${sub}`;
    const now = Math.floor(Date.now() / 1000);
    return {
      v: 1,
      kind: 'tenant',
      ten: tenantId,
      sub,
      role: u?.role ?? 'worker',
      sid: 'share-link',
      mcp: false,
      lic,
      iat: now,
      exp: now + 60,
    };
  }

  private event(db: Db, linkId: string, kind: string, ip: string | null, detail = '') {
    return db`INSERT INTO dms.share_event (link_id, kind, detail, ip) VALUES (${linkId}, ${kind}, ${detail.slice(0, 300)}, ${ip})`;
  }

  async publicView(tenantId: string, token: string, ip: string | null) {
    const { db, link, t } = await this.open(tenantId, token);
    await this.event(db, link.id, 'open', ip);
    const d = await this.detail(db, t.id);
    const [p] = await db<{ project: string }[]>`
      SELECT number || ' ' || name AS project FROM proj.project WHERE id = ${t.project_id}`;
    const codes =
      t.purpose === 'review'
        ? await db`SELECT code, label FROM dms.status_code WHERE active ORDER BY position, code`
        : [];
    return {
      project: p?.project ?? '',
      number: d.number,
      subject: d.subject,
      recipient: d.recipient,
      purpose: d.purpose,
      notes: d.notes,
      issuedOn: d.issuedOn,
      dueOn: d.dueOn,
      status: d.status,
      acknowledgedAt: d.acknowledgedAt,
      acknowledgedBy: d.acknowledgedBy,
      respondedAt: d.respondedAt,
      respondedBy: d.respondedBy,
      response: d.response,
      responseCode: d.responseCode,
      expiresAt: link.expires_at,
      items: d.items.map(({ id, name, versionNo, copies, remark }) => ({
        id,
        name,
        versionNo,
        copies,
        remark,
      })),
      codes,
    };
  }

  async publicFile(tenantId: string, token: string, itemId: string, ip: string | null) {
    const { db, link, t, lic } = await this.open(tenantId, token);
    const [it] = await db<{ document_id: string; version_no: number; name: string }[]>`
      SELECT i.document_id, i.version_no, d.name FROM dms.transmittal_item i JOIN doc.document d ON d.id = i.document_id
      WHERE i.id = ${itemId} AND i.transmittal_id = ${t.id}`;
    if (!it) throw new NotFoundException({ code: 'not_found', message: 'No such item.' });
    await this.event(db, link.id, 'download', ip, `${it.name} v${it.version_no}`);
    return this.documents.file(
      await this.issuer(db, tenantId, t, lic),
      it.document_id,
      it.version_no,
    );
  }

  async publicAcknowledge(tenantId: string, token: string, name: string, ip: string | null) {
    const { db, link, t } = await this.open(tenantId, token);
    await db.begin(async (tx) => {
      await this.acknowledgeTx(tx, t, name);
      await this.event(tx, link.id, 'acknowledge', ip, name);
    });
    return this.publicView(tenantId, token, ip);
  }

  /** The recipient's response, with one file kept in the project's vault under the transmittal's name. */
  async publicRespond(
    tenantId: string,
    token: string,
    input: { name: string; response: string; code: string | null },
    file: { name: string; stream: Readable; truncated: () => boolean } | null,
    ip: string | null,
  ) {
    const { db, link, t, lic } = await this.open(tenantId, token);
    if (t.purpose !== 'review' && input.code)
      throw new BadRequestException({ code: 'no_code', message: 'Only a review takes a code.' });
    if (t.status === 'responded' || t.status === 'closed' || t.status === 'draft')
      throw new ConflictException({
        code: 'responded',
        message: 'A response is already recorded.',
      });
    let documentId: string | null = null;
    if (file) {
      const up = await this.documents.upload(
        await this.issuer(db, tenantId, t, lic),
        projectVault(t.project_id),
        {
          folderId: null,
          path: `Transmittals/${t.number} response`,
          note: `From ${input.name} through the link`,
        },
        file,
      );
      documentId = up.document.id;
    }
    await db.begin(async (tx) => {
      const fresh = await this.row(tx, t.id);
      await this.respondTx(tx, fresh, {
        by: input.name,
        response: input.response,
        code: input.code,
        documentId,
      });
      await this.event(
        tx,
        link.id,
        'respond',
        ip,
        `${input.name}${input.code ? ` ${input.code}` : ''}`,
      );
    });
    return this.publicView(tenantId, token, ip);
  }
}
