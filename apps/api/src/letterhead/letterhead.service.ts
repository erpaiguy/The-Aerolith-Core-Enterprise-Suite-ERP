// Letterhead (docs/wave7-plan.md step 7b.1): each company's block for printed documents (name, address, tax numbers,
// contact lines, footer, signatory and logo). Anyone signed in reads it (they print); the admin sets it.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export interface LetterheadInput {
  phone: string;
  email: string;
  website: string;
  footer: string;
  signatoryName: string;
  signatoryTitle: string;
}

const MAX_LOGO = 300 * 1024;

/** The image's type from its first bytes, never from what the browser said. */
export function logoType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (
    bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  return null;
}

@Injectable()
export class LetterheadService {
  constructor(private readonly tenants: TenantConnections) {}

  private admin(claims: TenantClaims) {
    if (claims.role !== 'admin')
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Only the admin sets the letterhead.',
      });
  }

  async get(claims: TenantClaims, entityId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db<
      {
        id: string;
        name: string;
        legalName: string;
        address: string;
        city: string;
        pincode: string | null;
        gstin: string | null;
        pan: string | null;
        phone: string;
        email: string;
        website: string;
        footer: string;
        signatoryName: string;
        signatoryTitle: string;
        mime: string | null;
        bytes: Buffer | null;
      }[]
    >`
      SELECT e.id, e.name, e.legal_name AS "legalName", e.address, e.city, e.pincode, e.gstin, e.pan, e.phone, e.email,
        e.website, e.letter_footer AS footer, e.signatory_name AS "signatoryName",
        e.signatory_title AS "signatoryTitle", l.mime, l.bytes
      FROM platform.entity e LEFT JOIN platform.entity_logo l ON l.entity_id = e.id
      WHERE e.id = ${entityId}`;
    if (!e) throw new NotFoundException({ code: 'company_not_found' });
    const { mime, bytes, ...rest } = e;
    return {
      ...rest,
      logo: mime && bytes ? `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` : null,
      mayEdit: claims.role === 'admin',
    };
  }

  async set(claims: TenantClaims, entityId: string, b: LetterheadInput) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db`
      UPDATE platform.entity SET phone = ${b.phone}, email = ${b.email}, website = ${b.website},
        letter_footer = ${b.footer}, signatory_name = ${b.signatoryName}, signatory_title = ${b.signatoryTitle},
        updated_at = now(), row_version = row_version + 1
      WHERE id = ${entityId} RETURNING id`;
    if (!e) throw new NotFoundException({ code: 'company_not_found' });
    return this.get(claims, entityId);
  }

  /** A logo sent as a data URL (PNG or JPEG, up to 300 KB). */
  async setLogo(claims: TenantClaims, entityId: string, dataUrl: string) {
    this.admin(claims);
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    const bytes = m ? Buffer.from(m[2]!, 'base64') : null;
    const mime = bytes ? logoType(bytes) : null;
    if (!bytes || !mime)
      throw new BadRequestException({
        code: 'bad_logo',
        message: 'The logo must be a PNG or JPEG image.',
      });
    if (bytes.length > MAX_LOGO)
      throw new BadRequestException({
        code: 'logo_too_big',
        message: 'The logo must be 300 KB or smaller.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db`SELECT 1 FROM platform.entity WHERE id = ${entityId}`;
    if (!e) throw new NotFoundException({ code: 'company_not_found' });
    await db`
      INSERT INTO platform.entity_logo (entity_id, mime, bytes, updated_by)
      VALUES (${entityId}, ${mime}, ${bytes}, ${claims.sub})
      ON CONFLICT (entity_id) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, updated_at = now(),
        updated_by = EXCLUDED.updated_by`;
    return this.get(claims, entityId);
  }

  async removeLogo(claims: TenantClaims, entityId: string) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db`DELETE FROM platform.entity_logo WHERE entity_id = ${entityId}`;
    return this.get(claims, entityId);
  }
}
