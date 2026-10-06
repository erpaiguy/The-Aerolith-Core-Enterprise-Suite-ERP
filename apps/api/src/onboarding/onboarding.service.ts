// "Connect your Supabase" (docs/infra-existing-stack.md §5). The tenant opens an emailed onboarding link, consents
// on Supabase (OAuth with PKCE), picks an organisation if they have several, and provisioning starts in the
// background. Tokens, verifiers and links are stored only as HMACs or sealed values.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { open, seal } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import {
  newPkce,
  type OAuthTokens,
  type SupabaseOrganisation,
} from '../provisioning/supabase.client.js';

const LINK_DAYS = 7;
const STATE_MINUTES = 15;

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(CONTROL_DB) private readonly sql: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly provisioning: ProvisioningService,
  ) {}

  private hmac(value: string): string {
    return createHmac('sha256', this.config.licenceKeyPepper).update(value).digest('hex');
  }

  /** Owner/website: creates the tenant's database record and an onboarding link, and queues the email. */
  async createLink(tenantId: string): Promise<{ url: string; expiresAt: Date }> {
    const [tenant] = await this.sql<{ email: string }[]>`
      SELECT o.email FROM core.tenant t JOIN core.owner_account o ON o.id = t.owner_account_id WHERE t.id = ${tenantId}`;
    if (!tenant) throw new NotFoundException({ code: 'tenant_not_found' });
    const [existing] = await this.sql`SELECT 1 FROM core.tenant_db WHERE tenant_id = ${tenantId}`;
    if (!existing) await this.provisioning.register(tenantId, 'supabase');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_DAYS * 86_400_000);
    const url = new URL('/onboarding', this.config.websiteUrl);
    url.searchParams.set('token', token);
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO core.onboarding_token (tenant_id, token_hmac, expires_at)
        VALUES (${tenantId}, ${this.hmac(token)}, ${expiresAt})`;
      await tx`INSERT INTO core.email_outbox (to_email, template, data)
        VALUES (${tenant.email}, 'onboarding_link',
                ${tx.json({ tenantId, link: seal(url.toString(), this.config.controlPlaneEncKey), expiresAt: expiresAt.toISOString() })})`;
    });
    return { url: url.toString(), expiresAt };
  }

  async tenantForToken(token: string): Promise<string> {
    const [row] = await this.sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM core.onboarding_token WHERE token_hmac = ${this.hmac(token)} AND expires_at > now()`;
    if (!row)
      throw new NotFoundException({
        code: 'onboarding_link_invalid',
        message: 'This onboarding link is invalid or has expired.',
      });
    return row.tenant_id;
  }

  /** Step 1: returns the Supabase consent URL for the tenant behind an onboarding link. */
  async authorizeUrl(token: string): Promise<string> {
    const client = this.client();
    const tenantId = await this.tenantForToken(token);
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = newPkce();
    await this.sql`INSERT INTO core.oauth_state (state_hmac, tenant_id, verifier_secret, expires_at)
      VALUES (${this.hmac(state)}, ${tenantId}, ${seal(verifier, this.config.controlPlaneEncKey)},
              ${new Date(Date.now() + STATE_MINUTES * 60_000)})`;
    return client.authorizeUrl(state, challenge);
  }

  /** Step 2: Supabase redirects back with a code. One-time use; the state expires after 15 minutes. */
  async callback(code: string, state: string): Promise<{ tenantId: string; status: string }> {
    const client = this.client();
    const [row] = await this.sql<{ tenant_id: string; verifier_secret: string }[]>`
      UPDATE core.oauth_state SET used_at = now()
      WHERE state_hmac = ${this.hmac(state)} AND used_at IS NULL AND expires_at > now()
      RETURNING tenant_id, verifier_secret`;
    if (!row) throw new BadRequestException({ code: 'oauth_state_invalid' });
    const tokens = await client.exchangeCode(
      code,
      open(row.verifier_secret, this.config.controlPlaneEncKey),
    );
    const orgs = await client.listOrganisations(tokens.accessToken);
    if (orgs.length === 0) throw new BadRequestException({ code: 'no_supabase_organisation' });
    const single = orgs.length === 1 ? orgs[0]!.id : null;
    await this.sql`UPDATE core.tenant_db SET
        oauth_secret = ${seal(JSON.stringify(tokens), this.config.controlPlaneEncKey)},
        organisation_ref = ${single},
        status = ${single ? 'creating' : 'awaiting_org'},
        next_attempt_at = now(), updated_at = now()
      WHERE tenant_id = ${row.tenant_id} AND status IN ('awaiting_consent', 'awaiting_org')`;
    return { tenantId: row.tenant_id, status: single ? 'creating' : 'awaiting_org' };
  }

  async status(token: string): Promise<{ status: string; organisations?: SupabaseOrganisation[] }> {
    const tenantId = await this.tenantForToken(token);
    const s = await this.provisioning.status(tenantId);
    if (s.status !== 'awaiting_org') return { status: s.status };
    return { status: s.status, organisations: await this.listOrganisations(tenantId) };
  }

  /** Step 3 (only with several organisations): the tenant picks where the project is created. */
  async chooseOrganisation(token: string, organisationId: string): Promise<{ status: string }> {
    const tenantId = await this.tenantForToken(token);
    const orgs = await this.listOrganisations(tenantId);
    if (!orgs.some((o) => o.id === organisationId))
      throw new BadRequestException({ code: 'unknown_organisation' });
    const [row] = await this
      .sql`UPDATE core.tenant_db SET organisation_ref = ${organisationId}, status = 'creating',
        next_attempt_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND status = 'awaiting_org' RETURNING 1`;
    if (!row) throw new BadRequestException({ code: 'not_awaiting_organisation' });
    return { status: 'creating' };
  }

  private async listOrganisations(tenantId: string): Promise<SupabaseOrganisation[]> {
    const [row] = await this.sql<{ oauth_secret: string | null }[]>`
      SELECT oauth_secret FROM core.tenant_db WHERE tenant_id = ${tenantId}`;
    if (!row?.oauth_secret) throw new BadRequestException({ code: 'supabase_not_connected' });
    const tokens = JSON.parse(
      open(row.oauth_secret, this.config.controlPlaneEncKey),
    ) as OAuthTokens;
    return this.client().listOrganisations(tokens.accessToken);
  }

  private client() {
    const client = this.provisioning.supabaseClient;
    if (!client) throw new BadRequestException({ code: 'supabase_not_configured' });
    return client;
  }
}
