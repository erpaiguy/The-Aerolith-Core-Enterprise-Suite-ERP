// Internal sign-off (docs/wave5-plan.md step 5): drawn signatures only, as the owner decided. Signers sign a PDF
// version in order, each in a field on a page; when the last has signed, the server places every signature, appends
// an audit certificate page (who, when, which session and address, the unsigned file's SHA-256) and keeps the result
// as the document's next version with its own SHA-256, so it can be verified later. Not a qualified electronic
// signature under the IT Act, and the certificate says so.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StandardFonts, rgb } from 'pdf-lib';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { DocumentsService, projectVault } from '../documents/documents.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { latin1, loadPdf } from './pdf-stamp.js';

type Db = Sql | TransactionSql;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();
const MAX_PNG = 200 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ist = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' });

export const NOT_QUALIFIED =
  'Internal sign-off with drawn signatures. Not a digital signature certificate (DSC) or Aadhaar eSign; ' +
  'not a qualified electronic signature under the Second Schedule of the IT Act, 2000.';

/** A drawn signature: a PNG (by its bytes) of at most 200 KB, sent as base64. */
export function signaturePng(base64: string): Buffer {
  const b = Buffer.from(base64.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (b.length < 100 || b.length > MAX_PNG || !b.subarray(0, 8).equals(PNG_MAGIC))
    throw new BadRequestException({
      code: 'bad_signature',
      message: 'The signature must be a drawn picture (PNG) of at most 200 KB.',
    });
  return b;
}

export interface Who {
  ip: string | null;
  userAgent: string | null;
}

interface SignoffRow {
  id: string;
  project_id: string;
  number: string;
  title: string;
  document_id: string;
  version_no: number;
  status: string;
  source_sha256: Buffer;
  signed_version_no: number | null;
  signed_sha256: Buffer | null;
  created_by: string;
}

@Injectable()
export class SignoffService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly documents: DocumentsService,
  ) {}

  private async bytes(claims: TenantClaims, documentId: string, versionNo: number) {
    const f = await this.documents.file(claims, documentId, versionNo);
    const chunks: Buffer[] = [];
    for await (const c of f.stream) chunks.push(Buffer.from(c as Uint8Array));
    return { mime: f.mime, bytes: Buffer.concat(chunks) };
  }

  // --- my saved signature ---

  async mySignature(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<{ png: Buffer; updated_at: Date }[]>`
      SELECT png, updated_at FROM dms.saved_signature WHERE user_id = ${claims.sub}`;
    return s
      ? { png: `data:image/png;base64,${s.png.toString('base64')}`, updatedAt: s.updated_at }
      : null;
  }

  async saveSignature(claims: TenantClaims, base64: string) {
    const png = signaturePng(base64);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO dms.saved_signature (user_id, png) VALUES (${claims.sub}, ${png})
        ON CONFLICT (user_id) DO UPDATE SET png = EXCLUDED.png, updated_at = now()`;
      await audit(tx, claims.sub, 'signature.save', 'user', claims.sub, { bytes: png.length });
    });
    return this.mySignature(claims);
  }

  // --- sign-offs ---

  private async row(db: Db, id: string) {
    const [s] = await db<SignoffRow[]>`SELECT * FROM dms.signoff WHERE id = ${id}`;
    if (!s) throw new NotFoundException({ code: 'not_found', message: 'No such sign-off.' });
    return s;
  }

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return db`
      SELECT s.id, s.number, s.title, d.name AS document, s.version_no AS "versionNo", s.status,
        s.signed_version_no AS "signedVersionNo", to_char(s.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "startedOn",
        (SELECT u.display_name FROM dms.signoff_signer g JOIN platform."user" u ON u.id = g.user_id
          WHERE g.signoff_id = s.id AND g.status = 'waiting' ORDER BY g.position LIMIT 1) AS "waitingOn"
      FROM dms.signoff s JOIN doc.document d ON d.id = s.document_id
      WHERE s.project_id = ${projectId} ORDER BY s.created_at DESC`;
  }

  /** The sign-offs waiting on me (my turn only). */
  async mine(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT s.id, s.number, s.title, p.number AS project, d.name AS document, s.version_no AS "versionNo"
      FROM dms.signoff_signer g JOIN dms.signoff s ON s.id = g.signoff_id
      JOIN doc.document d ON d.id = s.document_id JOIN proj.project p ON p.id = s.project_id
      WHERE g.user_id = ${claims.sub} AND g.status = 'waiting' AND s.status = 'open'
        AND g.position = (SELECT min(position) FROM dms.signoff_signer x WHERE x.signoff_id = s.id AND x.status = 'waiting')
      ORDER BY s.created_at`;
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.row(db, id);
    await this.projects.access(db, claims, s.project_id);
    return this.detail(db, claims, s.id);
  }

  private async detail(db: Db, claims: TenantClaims, id: string) {
    const s = await this.row(db, id);
    const [d] = await db<
      { name: string }[]
    >`SELECT name FROM doc.document WHERE id = ${s.document_id}`;
    const signers = await db<
      {
        id: string;
        position: number;
        userId: string;
        name: string;
        page: number;
        x: string;
        y: string;
        w: string;
        h: string;
        status: string;
        reason: string;
        actedAt: Date | null;
      }[]
    >`
      SELECT g.id, g.position, g.user_id AS "userId", u.display_name AS name, g.page, g.x, g.y, g.w, g.h, g.status,
        g.reason, g.acted_at AS "actedAt"
      FROM dms.signoff_signer g JOIN platform."user" u ON u.id = g.user_id
      WHERE g.signoff_id = ${id} ORDER BY g.position`;
    const turn = signers.find((g) => g.status === 'waiting');
    return {
      id: s.id,
      projectId: s.project_id,
      number: s.number,
      title: s.title,
      document: { id: s.document_id, name: d?.name ?? '', versionNo: s.version_no },
      status: s.status,
      signedVersionNo: s.signed_version_no,
      sourceSha256: s.source_sha256.toString('hex'),
      signedSha256: s.signed_sha256?.toString('hex') ?? null,
      signers: signers.map(({ x, y, w, h, ...g }) => ({
        ...g,
        box: { x: Number(x), y: Number(y), w: Number(w), h: Number(h) },
      })),
      myTurn: s.status === 'open' && turn?.userId === claims.sub,
      notice: NOT_QUALIFIED,
    };
  }

  async start(
    claims: TenantClaims,
    projectId: string,
    input: {
      title: string;
      documentId: string;
      versionNo: number | null;
      reviewId: string | null;
      signers: {
        userId: string;
        page: number;
        box: { x: number; y: number; w: number; h: number };
      }[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team starts a sign-off.",
      });
    const [doc] = await db<{ version_no: number }[]>`
      SELECT version_no FROM doc.document WHERE id = ${input.documentId} AND project_id = ${projectId} AND deleted_at IS NULL`;
    if (!doc)
      throw new NotFoundException({
        code: 'no_such_document',
        message: "No such document in this project's documents.",
      });
    const versionNo = input.versionNo ?? doc.version_no;
    if (input.reviewId) {
      const [r] = await db<{ status: string; document_id: string }[]>`
        SELECT status, document_id FROM dms.review WHERE id = ${input.reviewId} AND project_id = ${projectId}`;
      if (!r || r.document_id !== input.documentId)
        throw new NotFoundException({
          code: 'no_such_review',
          message: 'No such review of this document.',
        });
      if (r.status !== 'approved')
        throw new ConflictException({
          code: 'not_approved',
          message: 'Only an approved review goes to sign-off.',
        });
    }
    const users = new Set(input.signers.map((g) => g.userId));
    if (users.size !== input.signers.length)
      throw new BadRequestException({ code: 'twice', message: 'A signer is listed twice.' });
    for (const g of input.signers) {
      const [m] = await db`
        SELECT 1 FROM proj.member m JOIN platform."user" u ON u.id = m.user_id
        WHERE m.project_id = ${projectId} AND m.user_id = ${g.userId} AND u.status = 'active'`;
      if (!m)
        throw new BadRequestException({
          code: 'not_on_project',
          message: 'Every signer must be on the project.',
        });
      const b = g.box;
      if (b.x + b.w > 1 || b.y + b.h > 1)
        throw new BadRequestException({
          code: 'box_outside_page',
          message: 'A signature field must lie on the page.',
        });
    }
    const { mime, bytes } = await this.bytes(claims, input.documentId, versionNo);
    if (mime !== 'application/pdf')
      throw new BadRequestException({ code: 'not_pdf', message: 'Only a PDF is signed.' });
    const pages = (await loadPdf(bytes)).getPageCount();
    if (input.signers.some((g) => g.page > pages))
      throw new BadRequestException({
        code: 'no_such_page',
        message: `The document has ${pages} page${pages === 1 ? '' : 's'}.`,
      });
    const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`signoff:${projectId}`}))`;
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int + 1 AS n FROM dms.signoff WHERE project_id = ${projectId}`;
      const number = `SO-${String(n!.n).padStart(3, '0')}`;
      const [s] = await tx<{ id: string }[]>`
        INSERT INTO dms.signoff ${tx({
          project_id: projectId,
          number,
          title: input.title,
          document_id: input.documentId,
          version_no: versionNo,
          review_id: input.reviewId,
          source_sha256: sha256(bytes),
          created_by: claims.sub,
        })} RETURNING id`;
      for (const [i, g] of input.signers.entries()) {
        const x = r5(g.box.x);
        const y = r5(g.box.y);
        await tx`
          INSERT INTO dms.signoff_signer (signoff_id, position, user_id, page, x, y, w, h)
          VALUES (${s!.id}, ${i + 1}, ${g.userId}, ${g.page}, ${x}, ${y},
            ${Math.min(r5(g.box.w), 1 - x)}, ${Math.min(r5(g.box.h), 1 - y)})`;
      }
      await this.notifyNext(tx, s!.id, number, input.title, projectId);
      await audit(tx, claims.sub, 'signoff.start', 'signoff', s!.id, { number, versionNo });
      return s!.id;
    });
    return this.detail(db, claims, id);
  }

  private async notifyNext(
    tx: TransactionSql,
    id: string,
    number: string,
    title: string,
    projectId: string,
  ) {
    const [next] = await tx<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM dms.signoff_signer WHERE signoff_id = ${id} AND status = 'waiting'
      ORDER BY position LIMIT 1`;
    if (next)
      await tx`INSERT INTO platform.notification (user_id, kind, title, link, source)
        VALUES (${next.user_id}, 'signoff', ${`${number} ${title}: your signature`},
          ${`/sign-offs?project=${projectId}&open=${id}`}, ${`signer:${next.id}`})`;
  }

  /** My signature on my turn: the saved one or a new drawing. The last signature makes the signed version. */
  async sign(claims: TenantClaims, id: string, input: { png: string | null }, who: Who) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.row(db, id);
    await this.projects.access(db, claims, s.project_id);
    let png: Buffer;
    if (input.png) png = signaturePng(input.png);
    else {
      const [saved] = await db<{ png: Buffer }[]>`
        SELECT png FROM dms.saved_signature WHERE user_id = ${claims.sub}`;
      if (!saved)
        throw new BadRequestException({
          code: 'no_signature',
          message: 'Draw your signature first.',
        });
      png = saved.png;
    }
    const last = await db.begin(async (tx) => {
      const [fresh] = await tx<
        { status: string }[]
      >`SELECT status FROM dms.signoff WHERE id = ${id} FOR UPDATE`;
      if (fresh!.status !== 'open')
        throw new ConflictException({ code: 'closed', message: 'This sign-off is closed.' });
      const [turn] = await tx<{ id: string; user_id: string }[]>`
        SELECT id, user_id FROM dms.signoff_signer WHERE signoff_id = ${id} AND status = 'waiting'
        ORDER BY position LIMIT 1`;
      if (turn?.user_id !== claims.sub)
        throw new ForbiddenException({
          code: 'not_your_turn',
          message: 'It is not your turn to sign.',
        });
      await tx`
        UPDATE dms.signoff_signer SET status = 'signed', png = ${png}, acted_at = now(), session_id = ${claims.sid},
          ip = ${who.ip}, user_agent = ${who.userAgent?.slice(0, 300) ?? null}
        WHERE id = ${turn.id}`;
      await tx`UPDATE platform.notification SET read_at = coalesce(read_at, now()) WHERE source = ${`signer:${turn.id}`}`;
      await audit(tx, claims.sub, 'signoff.sign', 'signoff', id, { signer: turn.id, ip: who.ip });
      const [left] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM dms.signoff_signer WHERE signoff_id = ${id} AND status = 'waiting'`;
      if (left!.n > 0) await this.notifyNext(tx, id, s.number, s.title, s.project_id);
      return left!.n === 0;
    });
    if (last) await this.finish(claims, s);
    return this.detail(db, claims, id);
  }

  async decline(claims: TenantClaims, id: string, reason: string, who: Who) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.row(db, id);
    await this.projects.access(db, claims, s.project_id);
    await db.begin(async (tx) => {
      const [fresh] = await tx<
        { status: string }[]
      >`SELECT status FROM dms.signoff WHERE id = ${id} FOR UPDATE`;
      if (fresh!.status !== 'open')
        throw new ConflictException({ code: 'closed', message: 'This sign-off is closed.' });
      const [turn] = await tx<{ id: string; user_id: string }[]>`
        SELECT id, user_id FROM dms.signoff_signer WHERE signoff_id = ${id} AND status = 'waiting'
        ORDER BY position LIMIT 1`;
      if (turn?.user_id !== claims.sub)
        throw new ForbiddenException({
          code: 'not_your_turn',
          message: 'It is not your turn to sign.',
        });
      await tx`
        UPDATE dms.signoff_signer SET status = 'declined', reason = ${reason}, acted_at = now(),
          session_id = ${claims.sid}, ip = ${who.ip}, user_agent = ${who.userAgent?.slice(0, 300) ?? null}
        WHERE id = ${turn.id}`;
      await tx`UPDATE dms.signoff SET status = 'declined', closed_at = now(), row_version = row_version + 1 WHERE id = ${id}`;
      await tx`INSERT INTO platform.notification (user_id, kind, title, link)
        VALUES (${s.created_by}, 'signoff', ${`${s.number} ${s.title}: declined`},
          ${`/sign-offs?project=${s.project_id}&open=${id}`})`;
      await audit(tx, claims.sub, 'signoff.decline', 'signoff', id, { reason });
    });
    return this.detail(db, claims, id);
  }

  /** Places every signature, appends the certificate, and keeps the result as the document's next version. */
  private async finish(claims: TenantClaims, s: SignoffRow) {
    const db = await this.tenants.forTenant(claims.ten);
    const { bytes } = await this.bytes(claims, s.document_id, s.version_no);
    if (!sha256(bytes).equals(s.source_sha256))
      throw new ConflictException({
        code: 'source_changed',
        message: 'The file being signed no longer matches what the signers saw.',
      });
    const signers = await db<
      {
        position: number;
        name: string;
        username: string;
        page: number;
        x: string;
        y: string;
        w: string;
        h: string;
        png: Buffer;
        acted_at: Date;
        session_id: string | null;
        ip: string | null;
        user_agent: string | null;
      }[]
    >`
      SELECT g.position, u.display_name AS name, u.username, g.page, g.x, g.y, g.w, g.h, g.png, g.acted_at,
        g.session_id, g.ip, g.user_agent
      FROM dms.signoff_signer g JOIN platform."user" u ON u.id = g.user_id
      WHERE g.signoff_id = ${s.id} ORDER BY g.position`;
    const [doc] = await db<{ name: string; project: string }[]>`
      SELECT d.name, p.number || ' ' || p.name AS project FROM doc.document d JOIN proj.project p ON p.id = d.project_id
      WHERE d.id = ${s.document_id}`;
    const pdf = await loadPdf(bytes);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages = pdf.getPages();
    for (const g of signers) {
      const page = pages[g.page - 1]!;
      const { width, height } = page.getSize();
      const box = {
        x: Number(g.x) * width,
        y: height - (Number(g.y) + Number(g.h)) * height,
        w: Number(g.w) * width,
        h: Number(g.h) * height,
      };
      const img = await pdf.embedPng(g.png);
      const label = 9;
      const area = { w: box.w, h: Math.max(box.h - label, box.h * 0.6) };
      const scale = Math.min(area.w / img.width, area.h / img.height);
      page.drawImage(img, {
        x: box.x + (box.w - img.width * scale) / 2,
        y: box.y + box.h - img.height * scale,
        width: img.width * scale,
        height: img.height * scale,
      });
      page.drawText(latin1(`Signed by ${g.name}, ${ist(g.acted_at)} IST`), {
        x: box.x,
        y: box.y + 1,
        size: Math.min(6, (box.w / 160) * 6),
        font,
        color: rgb(0.1, 0.1, 0.4),
      });
    }
    // The audit certificate.
    const cert = pdf.addPage([595.28, 841.89]);
    let y = 790;
    const write = (text: string, opts: { size?: number; b?: boolean; gap?: number } = {}) => {
      const size = opts.size ?? 9;
      const f = opts.b ? bold : font;
      for (const line of wrap(latin1(text), f, size, 500)) {
        cert.drawText(line, { x: 48, y, size, font: f });
        y -= size + 4;
      }
      y -= opts.gap ?? 2;
    };
    const wrap = (text: string, f: typeof font, size: number, max: number) => {
      const out: string[] = [];
      let cur = '';
      for (const word of text.split(' ')) {
        const next = cur ? `${cur} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > max && cur) {
          out.push(cur);
          cur = word;
        } else cur = next;
      }
      if (cur) out.push(cur);
      return out;
    };
    write('Sign-off certificate', { size: 16, b: true, gap: 8 });
    write(`${s.number}: ${s.title}`, { b: true });
    write(`Project: ${doc?.project ?? ''}`);
    write(`Document: ${doc?.name ?? ''}, version ${s.version_no}`);
    write(`SHA-256 of the unsigned file: ${s.source_sha256.toString('hex')}`, { size: 8, gap: 10 });
    for (const g of signers) {
      write(`${g.position}. ${g.name} (${g.username})`, { b: true });
      write(
        `Signed ${ist(g.acted_at)} IST from ${g.ip ?? 'unknown address'}, session ${g.session_id ?? '-'}`,
        {
          size: 8,
        },
      );
      write(`Browser: ${g.user_agent ?? '-'}`, { size: 8, gap: 8 });
    }
    write(`Made by Aerolith Core on ${ist(new Date())} IST.`, { size: 8 });
    write(NOT_QUALIFIED, { size: 8 });
    const signed = Buffer.from(await pdf.save());
    // Kept in the name of whoever started the sign-off (the team), not the last signer, who may not upload.
    const [creator] = await db<{ role: TenantClaims['role'] }[]>`
      SELECT role FROM platform."user" WHERE id = ${s.created_by}`;
    const up = await this.documents.upload(
      { ...claims, sub: s.created_by, role: creator?.role ?? claims.role },
      projectVault(s.project_id),
      { folderId: null, path: null, note: `Signed: ${s.number}`, documentId: s.document_id },
      { name: doc?.name ?? 'signed.pdf', stream: Readable.from(signed), truncated: () => false },
    );
    await db.begin(async (tx) => {
      await tx`
        UPDATE dms.signoff SET status = 'signed', signed_version_no = ${up.document.versionNo},
          signed_sha256 = ${sha256(signed)}, closed_at = now(), row_version = row_version + 1
        WHERE id = ${s.id}`;
      await tx`INSERT INTO platform.notification (user_id, kind, title, link)
        VALUES (${s.created_by}, 'signoff', ${`${s.number} ${s.title}: signed`},
          ${`/sign-offs?project=${s.project_id}&open=${s.id}`})`;
      await audit(tx, claims.sub, 'signoff.signed', 'signoff', s.id, {
        version: up.document.versionNo,
      });
    });
  }

  /** The kept signed version hashed again: intact, or altered since it was made. */
  async verify(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.row(db, id);
    await this.projects.access(db, claims, s.project_id);
    if (s.status !== 'signed' || !s.signed_version_no || !s.signed_sha256)
      throw new ConflictException({ code: 'not_signed', message: 'Not signed yet.' });
    const { bytes } = await this.bytes(claims, s.document_id, s.signed_version_no);
    const now = sha256(bytes);
    return {
      intact: now.equals(s.signed_sha256),
      expected: s.signed_sha256.toString('hex'),
      found: now.toString('hex'),
      versionNo: s.signed_version_no,
    };
  }
}
