// Webhooks (docs/wave6-plan.md step 6): admins subscribe an https URL to events; deliveries are written in the
// changing transaction (events.ts) and sent here, signed, with a timeout, no redirects, retries on a schedule, and
// never to a private address unless the deployment allows it (tests, on-premises).
import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CONTROL_DB } from '../db/db.module.js';
import { open, seal } from '../crypto/secretbox.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { mustBeAdmin } from './api-keys.service.js';
import type { WebhookEvent } from './events.js';
import { isPrivateAddress, nextAttempt, sign } from './integration-rules.js';

const TIMEOUT_MS = 10_000;
const BATCH = 50;

@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Webhooks');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly tenants: TenantConnections,
    @Inject(CONTROL_DB) private readonly control: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (!this.config.webhookWorker) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const tenants = await this.control<{ tenant_id: string }[]>`
        SELECT tenant_id FROM core.tenant_db WHERE status = 'ready'`;
      for (const { tenant_id } of tenants) {
        await this.sendDue(tenant_id).catch((err: unknown) =>
          this.log.error(
            `tenant ${tenant_id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    } finally {
      this.running = false;
    }
  }

  // --- admin ---

  async list(claims: TenantClaims) {
    mustBeAdmin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const hooks = await db`
      SELECT w.id, w.url, w.events, w.active, w.created_at AS "createdAt",
        (SELECT count(*)::int FROM platform.webhook_delivery d WHERE d.webhook_id = w.id AND d.status = 'failed')
          AS failed
      FROM platform.webhook w ORDER BY w.active DESC, w.created_at DESC`;
    const deliveries = await db`
      SELECT d.id, d.webhook_id AS "webhookId", d.event, d.status, d.attempts, d.last_status AS "lastStatus",
        d.last_error AS "lastError", d.created_at AS "createdAt", d.delivered_at AS "deliveredAt",
        d.next_at AS "nextAt"
      FROM platform.webhook_delivery d ORDER BY d.created_at DESC LIMIT 50`;
    return { hooks, deliveries };
  }

  private async checkUrl(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException({ code: 'bad_url', message: 'Not a web address.' });
    }
    if (url.protocol !== 'https:' && !(this.config.webhookAllowPrivate && url.protocol === 'http:'))
      throw new BadRequestException({
        code: 'https_only',
        message: 'Webhooks go to https addresses only.',
      });
    if (url.username || url.password)
      throw new BadRequestException({
        code: 'bad_url',
        message: 'Put no password in the address.',
      });
    return url;
  }

  /** The signing secret is returned once; it is kept sealed so the sender can sign with it. */
  async create(claims: TenantClaims, input: { url: string; events: WebhookEvent[] }) {
    mustBeAdmin(claims);
    await this.checkUrl(input.url);
    const db = await this.tenants.forTenant(claims.ten);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const id = await db.begin(async (tx) => {
      const [w] = await tx<{ id: string }[]>`
        INSERT INTO platform.webhook (url, events, secret_sealed, created_by)
        VALUES (${input.url}, ${input.events}, ${seal(secret, this.config.controlPlaneEncKey)}, ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'webhook.create', 'webhook', w!.id, {
        url: input.url,
        events: input.events,
      });
      return w!.id;
    });
    return { id, secret };
  }

  async disable(claims: TenantClaims, id: string) {
    mustBeAdmin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [w] =
        await tx`UPDATE platform.webhook SET active = false WHERE id = ${id} RETURNING id`;
      if (!w) throw new NotFoundException({ code: 'not_found', message: 'No such webhook.' });
      await tx`UPDATE platform.webhook_delivery SET status = 'failed', last_error = 'Webhook turned off'
        WHERE webhook_id = ${id} AND status = 'pending'`;
      await audit(tx, claims.sub, 'webhook.disable', 'webhook', id, {});
    });
    return this.list(claims);
  }

  /** A `ping` to one webhook, sent at once. */
  async test(claims: TenantClaims, id: string) {
    mustBeAdmin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [w] = await db<
      { id: string }[]
    >`SELECT id FROM platform.webhook WHERE id = ${id} AND active`;
    if (!w) throw new NotFoundException({ code: 'not_found', message: 'No such webhook.' });
    const eventId = randomUUID();
    const payload = {
      id: eventId,
      event: 'ping',
      occurredAt: new Date().toISOString(),
      data: { message: 'A test from Aerolith Core' },
    };
    await db`INSERT INTO platform.webhook_delivery (webhook_id, event_id, event, payload)
      VALUES (${id}, ${eventId}, 'ping', ${db.json(payload)})`;
    await this.sendDue(claims.ten);
    return this.list(claims);
  }

  // --- the sender ---

  /** Sends what is due in one tenant (the loop calls this; tests call it with a clock). */
  async sendDue(tenantId: string, now = new Date()) {
    const db = await this.tenants.forTenant(tenantId);
    const due = await db<
      {
        id: string;
        url: string;
        secret_sealed: string;
        payload: unknown;
        attempts: number;
        active: boolean;
      }[]
    >`
      UPDATE platform.webhook_delivery d SET status = 'sending'
      FROM platform.webhook w
      WHERE d.webhook_id = w.id AND d.id IN (
        SELECT id FROM platform.webhook_delivery WHERE status = 'pending' AND next_at <= ${now}
        ORDER BY next_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING d.id, w.url, w.secret_sealed, d.payload, d.attempts, w.active`;
    for (const d of due) {
      const attempts = d.attempts + 1;
      const result = d.active
        ? await this.deliver(
            d.url,
            open(d.secret_sealed, this.config.controlPlaneEncKey),
            d.payload,
          )
        : { ok: false, status: null, error: 'Webhook turned off' };
      if (result.ok) {
        await db`UPDATE platform.webhook_delivery SET status = 'delivered', attempts = ${attempts},
            last_status = ${result.status}, last_error = NULL, delivered_at = now()
          WHERE id = ${d.id}`;
        continue;
      }
      const next = d.active ? nextAttempt(attempts, now) : null;
      await db`UPDATE platform.webhook_delivery SET status = ${next ? 'pending' : 'failed'}, attempts = ${attempts},
          next_at = ${next ?? now}, last_status = ${result.status}, last_error = ${result.error.slice(0, 500)}
        WHERE id = ${d.id}`;
    }
    return due.length;
  }

  private async deliver(
    rawUrl: string,
    secret: string,
    payload: unknown,
  ): Promise<{ ok: boolean; status: number | null; error: string }> {
    try {
      const url = await this.checkUrl(rawUrl);
      if (!this.config.webhookAllowPrivate) {
        const addrs = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
        if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address)))
          return { ok: false, status: null, error: 'The address is on a private network.' };
      }
      const body = JSON.stringify(payload);
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Aerolith-Core-Webhooks/1',
          'x-aerolith-signature': sign(secret, Math.floor(Date.now() / 1000), body),
          'x-aerolith-event': (payload as { event: string }).event,
        },
        body,
      });
      await res.body?.cancel().catch(() => undefined);
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, error: '' }
        : { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
