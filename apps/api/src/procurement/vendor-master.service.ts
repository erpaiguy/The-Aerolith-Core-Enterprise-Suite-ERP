// The vendor master (docs/wave8-plan.md step 8e.1): trade categories, the vetting status with its reason, KYC documents
// with their expiry (reminded before it), and the company's rule to buy only from approved vendors. Who may be offered
// an enquiry or given an order is decided in vendor-rules.ts.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { reminderDates } from '../control/contract-rules.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FileTooLargeError } from '../documents/file-store.js';
import { imageType } from '../project/daily-report.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import type { VendorStatus } from './vendor-rules.js';

export const KYC_KINDS = [
  'gst_certificate',
  'pan',
  'udyam',
  'cancelled_cheque',
  'trade_licence',
  'labour_licence',
  'pf_registration',
  'esi_registration',
  'insurance',
  'iso',
  'other',
] as const;
export const KYC_MAX = 5 * 1024 * 1024;
const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** A scan's type by its first bytes: a PDF or a picture. */
const fileType = (head: Buffer) =>
  head.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : imageType(head);

@Injectable()
export class VendorMasterService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly documents: DocumentsService,
  ) {}

  private async must(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'purchase.edit')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'purchase.edit',
        message: 'The vendor master is kept with the purchase permission.',
      });
  }

  async categories(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT key, name, kind, active FROM proc.trade_category ORDER BY kind, name`;
  }

  async addCategory(
    claims: TenantClaims,
    input: { key: string; name: string; kind: 'material' | 'work' | 'service' },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db`
      INSERT INTO proc.trade_category (key, name, kind) VALUES (${input.key}, ${input.name}, ${input.kind})
      ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, active = true`;
    return this.categories(claims);
  }

  async policy(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<
      { approved_only: boolean }[]
    >`SELECT approved_only FROM proc.vendor_policy`;
    return { approvedOnly: p?.approved_only ?? false };
  }

  async setPolicy(claims: TenantClaims, approvedOnly: boolean) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO proc.vendor_policy (id, approved_only, updated_by) VALUES (true, ${approvedOnly}, ${claims.sub})
        ON CONFLICT (id) DO UPDATE SET approved_only = EXCLUDED.approved_only, updated_at = now(),
          updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'vendor.policy', 'vendor_policy', 'company', { approvedOnly });
    });
    return this.policy(claims);
  }

  /** Vendors and subcontractors with their status, categories and the state of their documents. */
  async vendors(
    claims: TenantClaims,
    q: { category?: string | undefined; status?: VendorStatus | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const today = indiaToday();
    return db`
      SELECT p.id, p.name, p.is_vendor AS "isVendor", p.is_subcontractor AS "isSubcontractor", p.gstin, p.pan,
        p.udyam_no AS "udyamNo", p.msme_type AS "msmeType", p.city,
        p.vendor_status AS status, p.vendor_status_reason AS "statusReason",
        to_char(p.vendor_status_on, 'YYYY-MM-DD') AS "statusOn",
        coalesce((SELECT array_agg(t.category ORDER BY t.category) FROM platform.party_trade t WHERE t.party_id = p.id),
          '{}') AS categories,
        (SELECT count(*)::int FROM proc.vendor_document d WHERE d.party_id = p.id AND d.removed_at IS NULL) AS documents,
        (SELECT count(*)::int FROM proc.vendor_document d WHERE d.party_id = p.id AND d.removed_at IS NULL
          AND d.valid_until < ${today}) AS expired,
        (SELECT count(*)::int FROM proc.vendor_document d WHERE d.party_id = p.id AND d.removed_at IS NULL
          AND d.valid_until BETWEEN ${today} AND ${today}::date + 30) AS expiring
      FROM platform.party p
      WHERE p.deleted_at IS NULL AND (p.is_vendor OR p.is_subcontractor)
        ${q.status ? db`AND p.vendor_status = ${q.status}` : db``}
        ${q.category ? db`AND EXISTS (SELECT 1 FROM platform.party_trade t WHERE t.party_id = p.id AND t.category = ${q.category})` : db``}
      ORDER BY lower(p.name)`;
  }

  async vendor(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [v] = await db`
      SELECT p.id, p.name, p.gstin, p.pan, p.udyam_no AS "udyamNo", p.msme_type AS "msmeType",
        p.vendor_status AS status, p.vendor_status_reason AS "statusReason",
        to_char(p.vendor_status_on, 'YYYY-MM-DD') AS "statusOn", u.display_name AS "statusBy",
        coalesce((SELECT array_agg(t.category ORDER BY t.category) FROM platform.party_trade t WHERE t.party_id = p.id),
          '{}') AS categories
      FROM platform.party p LEFT JOIN platform."user" u ON u.id = p.vendor_status_by
      WHERE p.id = ${id} AND p.deleted_at IS NULL`;
    if (!v) throw new NotFoundException({ code: 'party_not_found' });
    const documents = await db`
      SELECT id, kind, number, to_char(valid_until, 'YYYY-MM-DD') AS "validUntil", note, mime, file_name AS "fileName",
        size_bytes AS size, valid_until < ${indiaToday()} AS expired
      FROM proc.vendor_document WHERE party_id = ${id} AND removed_at IS NULL ORDER BY kind, created_at`;
    return { ...v, documents, mayEdit: await this.permissions.can(claims, 'purchase.edit') };
  }

  async setCategories(claims: TenantClaims, id: string, categories: string[]) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [p] =
        await tx`SELECT 1 FROM platform.party WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
      if (!p) throw new NotFoundException({ code: 'party_not_found' });
      await tx`DELETE FROM platform.party_trade WHERE party_id = ${id}`;
      for (const c of new Set(categories))
        await tx`INSERT INTO platform.party_trade (party_id, category) VALUES (${id}, ${c})`.catch(
          (err: unknown) => {
            if ((err as { code?: string }).code === '23503')
              throw new BadRequestException({
                code: 'no_such_category',
                message: `No trade category "${c}".`,
              });
            throw err;
          },
        );
      await audit(tx, claims.sub, 'vendor.categories', 'party', id, { categories });
    });
    return this.vendor(claims, id);
  }

  /** Approves, holds, blacklists or resets a vendor; a hold or blacklisting says why. */
  async setStatus(
    claims: TenantClaims,
    id: string,
    input: { status: VendorStatus; reason: string },
  ) {
    await this.must(claims);
    if ((input.status === 'on_hold' || input.status === 'blacklisted') && input.reason.length < 3)
      throw new BadRequestException({
        code: 'reason_required',
        message: 'Say why the vendor is held or blacklisted.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [p] = await tx`
        UPDATE platform.party SET vendor_status = ${input.status}, vendor_status_reason = ${input.reason},
          vendor_status_on = ${indiaToday()}, vendor_status_by = ${claims.sub}, row_version = row_version + 1,
          updated_at = now(), updated_by = ${claims.sub}
        WHERE id = ${id} AND deleted_at IS NULL RETURNING id`;
      if (!p) throw new NotFoundException({ code: 'party_not_found' });
      await audit(tx, claims.sub, 'vendor.status', 'party', id, { ...input });
    });
    return this.vendor(claims, id);
  }

  /** A KYC document; its expiry is reminded 30 and 7 days before to whoever entered it. */
  async addDocument(
    claims: TenantClaims,
    partyId: string,
    input: { kind: string; number: string; validUntil: string | null; note: string },
    file: { stream: Readable; truncated: () => boolean; name: string } | null,
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<{ name: string }[]>`
      SELECT name FROM platform.party WHERE id = ${partyId} AND deleted_at IS NULL`;
    if (!p) throw new NotFoundException({ code: 'party_not_found' });
    let stored: { key: string; mime: string; size: number } | null = null;
    if (file) {
      const store = await this.documents.store(claims.ten);
      const tooLarge = () =>
        new BadRequestException({ code: 'too_large', message: 'A document is at most 5 MB.' });
      const staged = await store.stage(file.stream, KYC_MAX).catch((e: unknown) => {
        throw e instanceof FileTooLargeError ? tooLarge() : e;
      });
      if (file.truncated()) {
        await store.discard(staged);
        throw tooLarge();
      }
      const mime = fileType(staged.head);
      if (!mime) {
        await store.discard(staged);
        throw new BadRequestException({
          code: 'not_a_scan',
          message: 'Send a PDF or a picture of the document.',
        });
      }
      stored = { key: await store.commit(staged), mime, size: staged.size };
    }
    await db.begin(async (tx) => {
      const [d] = await tx<{ id: string }[]>`
        INSERT INTO proc.vendor_document (party_id, kind, number, valid_until, note, storage_key, mime, file_name,
          size_bytes, created_by)
        VALUES (${partyId}, ${input.kind}, ${input.number}, ${input.validUntil}, ${input.note}, ${stored?.key ?? null},
          ${stored?.mime ?? null}, ${file ? file.name.slice(0, 200) : null}, ${stored?.size ?? null}, ${claims.sub})
        RETURNING id`;
      if (input.validUntil)
        for (const r of reminderDates(input.validUntil, [30, 7], new Date()))
          await tx`
            INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
            VALUES (${claims.sub}, 'vendor_document_expiry',
              ${`${p.name}'s ${input.kind.replace(/_/g, ' ')} expires in ${r.days} days, on ${input.validUntil}`},
              ${`/vendors/${partyId}`}, ${r.at}, ${`vendor-document:${d!.id}`})`;
      await audit(tx, claims.sub, 'vendor.document', 'party', partyId, {
        kind: input.kind,
        number: input.number,
      });
    });
    return this.vendor(claims, partyId);
  }

  async removeDocument(claims: TenantClaims, id: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const partyId = await db.begin(async (tx) => {
      const [d] = await tx<{ party_id: string }[]>`
        UPDATE proc.vendor_document SET removed_at = now() WHERE id = ${id} AND removed_at IS NULL
        RETURNING party_id`;
      if (!d) throw new NotFoundException({ code: 'not_found' });
      await tx`DELETE FROM platform.notification WHERE source = ${`vendor-document:${id}`} AND read_at IS NULL`;
      return d.party_id;
    });
    return this.vendor(claims, partyId);
  }

  async documentFile(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [d] = await db<
      { storage_key: string; mime: string; file_name: string; size_bytes: number }[]
    >`
      SELECT storage_key, mime, file_name, size_bytes FROM proc.vendor_document
      WHERE id = ${id} AND removed_at IS NULL AND storage_key IS NOT NULL`;
    if (!d) throw new NotFoundException({ code: 'not_found' });
    const store = await this.documents.store(claims.ten);
    return {
      stream: await store.open(d.storage_key),
      mime: d.mime,
      name: d.file_name,
      size: d.size_bytes,
    };
  }

  /** An enquiry's trade category: it limits who may be offered it where the company buys only from approved vendors. */
  async setRfqCategory(claims: TenantClaims, rfqId: string, category: string | null) {
    if (!(await this.permissions.can(claims, 'rfq.edit')))
      throw new ForbiddenException({ code: 'forbidden', permission: 'rfq.edit' });
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db`
      UPDATE tender.rfq SET category = ${category}, row_version = row_version + 1 WHERE id = ${rfqId}
      RETURNING id`.catch((err: unknown) => {
      if ((err as { code?: string }).code === '23503')
        throw new BadRequestException({ code: 'no_such_category' });
      throw err;
    });
    if (!r) throw new NotFoundException({ code: 'rfq_not_found' });
    return { category };
  }
}
