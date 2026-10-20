// The legal documents (docs/wave9-plan.md step 9b.3): what each person must accept and has accepted, recording an
// acceptance with when and from where, the record of who accepted which version for admins, and an admin marking a
// version as reviewed by the company's lawyer (until then the pages say they are drafts).
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LEGAL_DOCUMENTS, legalDocument, legalFor, type LegalKey } from '@aerolith/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { AllowWhilePasswordChangeRequired, Auth, Roles, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

const KEYS = LEGAL_DOCUMENTS.map((d) => d.key) as [LegalKey, ...LegalKey[]];
const accept = z.object({ documents: z.array(z.enum(KEYS)).min(1).max(KEYS.length) });
const review = z.object({
  document: z.enum(KEYS),
  reviewed: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

@Controller('tenant/legal')
@UseGuards(TenantAuthGuard)
export class LegalController {
  constructor(private readonly tenants: TenantConnections) {}

  /** Every document with its current version, whether this person must accept it, and its review state. */
  @Get()
  @AllowWhilePasswordChangeRequired()
  async state(@Auth() c: TenantClaims) {
    const db = await this.tenants.forTenant(c.ten);
    const mine = await db<{ document: string; version: string; at: Date }[]>`
      SELECT document, version, accepted_at AS at FROM platform.legal_acceptance WHERE user_id = ${c.sub}`;
    const reviews = await db<{ document: string; version: string; at: Date; by: string }[]>`
      SELECT r.document, r.version, r.reviewed_at AS at, u.display_name AS by
      FROM platform.legal_review r JOIN platform."user" u ON u.id = r.reviewed_by`;
    const applies = new Set(legalFor(c.role).map((d) => d.key));
    return {
      documents: LEGAL_DOCUMENTS.map((d) => {
        const accepted = mine.find((m) => m.document === d.key && m.version === d.version);
        const reviewed = reviews.find((r) => r.document === d.key && r.version === d.version);
        return {
          ...d,
          mustAccept: applies.has(d.key) && !accepted,
          acceptedAt: accepted?.at.toISOString() ?? null,
          reviewed: reviewed ? { by: reviewed.by, at: reviewed.at.toISOString() } : null,
        };
      }),
    };
  }

  @Post('accept')
  @HttpCode(200)
  @AllowWhilePasswordChangeRequired()
  async accept(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(accept)) b: z.infer<typeof accept>,
    @Req() req: FastifyRequest,
  ) {
    const applies = new Set(legalFor(c.role).map((d) => d.key));
    const notYours = b.documents.filter((k) => !applies.has(k));
    if (notYours.length)
      throw new BadRequestException({
        code: 'invalid_request',
        message: 'Only an administrator accepts those for the company.',
      });
    const db = await this.tenants.forTenant(c.ten);
    await db.begin(async (tx) => {
      for (const key of b.documents) {
        const d = legalDocument(key)!;
        const [row] = await tx`
          INSERT INTO platform.legal_acceptance (user_id, document, version, ip, user_agent)
          VALUES (${c.sub}, ${d.key}, ${d.version}, ${req.ip.slice(0, 64)},
                  ${req.headers['user-agent']?.slice(0, 300) ?? null})
          ON CONFLICT DO NOTHING RETURNING 1`;
        if (row)
          await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
            VALUES (${c.sub}, 'legal.accept', 'user', ${c.sub}, ${tx.json({ document: d.key, version: d.version })})`;
      }
    });
    return this.state(c);
  }

  /** Who accepted which version, and when: for admins. */
  @Get('acceptances')
  @Roles('admin')
  async acceptances(@Auth() c: TenantClaims) {
    const db = await this.tenants.forTenant(c.ten);
    return db<
      { username: string; name: string; document: string; version: string; acceptedAt: Date }[]
    >`
      SELECT u.username, u.display_name AS name, a.document, a.version, a.accepted_at AS "acceptedAt"
      FROM platform.legal_acceptance a JOIN platform."user" u ON u.id = a.user_id
      ORDER BY a.accepted_at DESC LIMIT 2000`;
  }

  /** An admin records that the company's lawyer reviewed the current version (or takes it back). */
  @Post('review')
  @HttpCode(200)
  @Roles('admin')
  async review(@Auth() c: TenantClaims, @Body(new ZodPipe(review)) b: z.infer<typeof review>) {
    const d = legalDocument(b.document)!;
    const db = await this.tenants.forTenant(c.ten);
    await db.begin(async (tx) => {
      if (b.reviewed)
        await tx`INSERT INTO platform.legal_review (document, version, reviewed_by, note)
          VALUES (${d.key}, ${d.version}, ${c.sub}, ${b.note ?? null})
          ON CONFLICT (document, version) DO UPDATE SET reviewed_by = EXCLUDED.reviewed_by,
            reviewed_at = now(), note = EXCLUDED.note`;
      else
        await tx`DELETE FROM platform.legal_review WHERE document = ${d.key} AND version = ${d.version}`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${c.sub}, ${b.reviewed ? 'legal.reviewed' : 'legal.unreviewed'}, 'user', ${c.sub},
                ${tx.json({ document: d.key, version: d.version })})`;
    });
    return this.state(c);
  }
}
