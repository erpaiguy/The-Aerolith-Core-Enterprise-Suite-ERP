// Staff check what portal users send before it counts (docs/wave6-plan.md step 5). Accepting goes through the
// module's own entry: a quote is saved by the RFQ's quote entry (a new round), a measurement is booked in the work
// order's measurement book with all its checks. An invoice is marked received; the accounts team posts the bill as
// usual with the file, since a bill is never posted from a vendor's own figures.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { SubcontractService } from '../accounts/subcontract.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { RfqService } from '../rfq/rfq.service.js';
import { audit } from '../tender/tender-records.js';
import type { PortalQuoteInput } from './portal.service.js';

interface Row {
  id: string;
  seq: string;
  user_id: string;
  party_id: string;
  kind: 'quote' | 'measurement' | 'invoice';
  rfq_id: string | null;
  order_id: string | null;
  payload: unknown;
  status: string;
  created_at: Date;
  storage_key: string | null;
  mime: string | null;
  size_bytes: number | null;
  file_name: string | null;
}

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly rfqs: RfqService,
    private readonly subcontracts: SubcontractService,
    private readonly documents: DocumentsService,
  ) {}

  private async may(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'portal.manage')))
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'You may not handle portal submissions.',
      });
  }

  async list(claims: TenantClaims, status: 'submitted' | 'all', only: string | null = null) {
    await this.may(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT s.id, 'PS-' || lpad(s.seq::text, 6, '0') AS number, s.kind, s.status, s.reason, s.payload,
        s.file_name AS "fileName", p.name AS party, u.name AS "submittedBy", u.email,
        coalesce(r.number || ' ' || r.title, o.number) AS about, s.rfq_id AS "rfqId", s.order_id AS "orderId",
        pr.name AS project, s.created_at AS "createdAt", s.decided_at AS "decidedAt", d.display_name AS "decidedBy"
      FROM portal.submission s JOIN platform.party p ON p.id = s.party_id JOIN portal."user" u ON u.id = s.user_id
      LEFT JOIN tender.rfq r ON r.id = s.rfq_id LEFT JOIN proc.purchase_order o ON o.id = s.order_id
      LEFT JOIN proj.project pr ON pr.id = coalesce(s.project_id, o.project_id)
      LEFT JOIN platform."user" d ON d.id = s.decided_by
      WHERE ${status === 'submitted' ? db`s.status = 'submitted'` : db`true`}
        AND ${only ? db`s.id = ${only}` : db`true`}
      ORDER BY s.status <> 'submitted', s.created_at DESC LIMIT 500`;
  }

  private async row(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<Row[]>`SELECT * FROM portal.submission WHERE id = ${id}`;
    if (!s) throw new NotFoundException({ code: 'not_found', message: 'No such submission.' });
    return { db, s };
  }

  async file(claims: TenantClaims, id: string) {
    await this.may(claims);
    const { s } = await this.row(claims, id);
    if (!s.storage_key) throw new NotFoundException({ code: 'no_file', message: 'No file.' });
    const store = await this.documents.store(claims.ten);
    return {
      stream: await store.open(s.storage_key),
      mime: s.mime ?? 'application/octet-stream',
      size: s.size_bytes ?? undefined,
      name: s.file_name ?? 'invoice',
    };
  }

  /** Claimed first (so two people cannot both accept it), applied, and released again if the module refuses. */
  async accept(claims: TenantClaims, id: string) {
    await this.may(claims);
    const { db, s } = await this.row(claims, id);
    const [claimed] = await db`
      UPDATE portal.submission SET status = 'accepted', decided_by = ${claims.sub}, decided_at = now()
      WHERE id = ${id} AND status = 'submitted' RETURNING id`;
    if (!claimed)
      throw new ConflictException({
        code: 'decided',
        message: 'This submission is already decided.',
      });
    try {
      if (s.kind === 'quote') await this.acceptQuote(claims, s);
      if (s.kind === 'measurement') await this.acceptMeasurement(claims, s);
    } catch (err) {
      await db`UPDATE portal.submission SET status = 'submitted', decided_by = NULL, decided_at = NULL
        WHERE id = ${id}`;
      throw err;
    }
    await db.begin(async (tx) => {
      await audit(tx, claims.sub, 'portal.accept_submission', 'portal_submission', id, {
        kind: s.kind,
      });
    });
    return this.one(claims, id);
  }

  private async acceptQuote(claims: TenantClaims, s: Row) {
    if (!(await this.permissions.can(claims, 'rfq.edit')))
      throw new ForbiddenException({ code: 'forbidden', message: 'You may not enter quotes.' });
    const q = s.payload as PortalQuoteInput;
    const receivedOn = new Date(s.created_at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    await this.rfqs.saveQuote(claims, s.rfq_id!, s.party_id, {
      receivedOn,
      validUntil: q.validUntil,
      reference: q.reference || `Portal ${'PS-' + s.seq.padStart(6, '0')}`,
      gstMode: q.gstMode,
      gstPct: q.gstPct,
      terms: q.terms,
      lines: q.lines,
      newRound: true,
    });
  }

  private async acceptMeasurement(claims: TenantClaims, s: Row) {
    const m = s.payload as {
      measuredOn: string;
      lines: { lineKey: string; qty: string; description: string }[];
    };
    if (!m.lines.length) throw new BadRequestException({ code: 'nothing_measured' });
    await this.subcontracts.measureMany(claims, s.order_id!, m.measuredOn, m.lines);
  }

  async reject(claims: TenantClaims, id: string, reason: string) {
    await this.may(claims);
    const { db } = await this.row(claims, id);
    await db.begin(async (tx) => {
      const [u] = await tx`
        UPDATE portal.submission SET status = 'rejected', reason = ${reason}, decided_by = ${claims.sub},
          decided_at = now()
        WHERE id = ${id} AND status = 'submitted' RETURNING id`;
      if (!u)
        throw new ConflictException({
          code: 'decided',
          message: 'This submission is already decided.',
        });
      await audit(tx, claims.sub, 'portal.reject_submission', 'portal_submission', id, { reason });
    });
    return this.one(claims, id);
  }

  private async one(claims: TenantClaims, id: string) {
    const [row] = await this.list(claims, 'all', id);
    return row;
  }
}
