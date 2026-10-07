// Sends the email outbox (docs/email.md). Rows are claimed with SKIP LOCKED so two API processes never send the same
// row at once; sending happens outside the claiming transaction so a slow SMTP server holds no database locks.
// Delivery is at-least-once: if the process dies mid-send, the row returns to the queue after 10 minutes.
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { resolve } from 'node:path';
import type { Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { open } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';
import { classifyDeliveryError, FileAdapter, SmtpAdapter, type EmailAdapter } from './adapter.js';
import { renderEmail, UnknownTemplateError } from './templates.js';

const POLL_MS = 10_000;
const BATCH = 20;
const MAX_ATTEMPTS = 6;
/** 1 min, 5 min, 15 min, 1 h, 3 h; the sixth failure is final. */
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000];
const STUCK_MINUTES = 10;

interface OutboxRow {
  id: string;
  to_email: string;
  template: string;
  data: Record<string, unknown>;
  attempts: number;
}

export interface RunSummary {
  sent: number;
  retrying: number;
  failed: number;
  suppressed: number;
  deferredByRateLimit: boolean;
}

@Injectable()
export class EmailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Email');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Replaceable in tests. */
  adapter: EmailAdapter | null;

  constructor(
    @Inject(CONTROL_DB) private readonly sql: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const email = config.email;
    this.adapter =
      email.transport === 'smtp' && email.smtp
        ? new SmtpAdapter(email.smtp)
        : email.transport === 'file'
          ? new FileAdapter(resolve(process.cwd(), email.fileDir))
          : null;
  }

  onApplicationBootstrap(): void {
    if (this.config.email.worker) this.timer = setInterval(() => void this.runOnce(), POLL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One delivery cycle. `at` pins the clock (tests); otherwise "due" is decided by the database clock, because
   * created_at has microsecond precision and a JavaScript Date only milliseconds.
   */
  async runOnce(at?: Date): Promise<RunSummary> {
    const now = at ?? new Date();
    const dbNow = at ? this.sql`${at}::timestamptz` : this.sql`clock_timestamp()`;
    const summary: RunSummary = {
      sent: 0,
      retrying: 0,
      failed: 0,
      suppressed: 0,
      deferredByRateLimit: false,
    };
    if (this.running || !this.adapter) return summary;
    this.running = true;
    try {
      // Rows left in `sending` by a crashed process go back to the queue.
      await this.sql`UPDATE core.email_outbox SET status = 'queued'
        WHERE status = 'sending' AND sending_started_at < ${dbNow} - make_interval(mins => ${STUCK_MINUTES})`;

      const sentLastHour = await this.count(this.sql`
        SELECT count(*)::int AS n FROM core.email_outbox WHERE sent_at > ${dbNow} - interval '1 hour'`);
      const budget = Math.min(BATCH, this.config.email.maxPerHour - sentLastHour);
      if (budget <= 0) return { ...summary, deferredByRateLimit: true };

      const rows = await this.sql.begin(async (tx) => {
        const due = await tx<OutboxRow[]>`
          SELECT id, to_email, template, data, attempts FROM core.email_outbox
          WHERE status = 'queued' AND coalesce(next_attempt_at, created_at) <= ${dbNow}
          ORDER BY coalesce(next_attempt_at, created_at) LIMIT ${budget} FOR UPDATE SKIP LOCKED`;
        if (due.length > 0) {
          await tx`UPDATE core.email_outbox SET status = 'sending', sending_started_at = ${now}
            WHERE id IN ${tx(due.map((r) => r.id))}`;
        }
        return due;
      });
      for (const row of rows) summary[await this.deliver(row, now)]++;
      const stillDue = await this.count(this.sql`SELECT count(*)::int AS n FROM core.email_outbox
        WHERE status = 'queued' AND coalesce(next_attempt_at, created_at) <= ${dbNow}`);
      summary.deferredByRateLimit = stillDue > 0 && rows.length === budget && budget < BATCH;
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async count(query: PromiseLike<readonly { n?: number }[]>): Promise<number> {
    const [row] = await query;
    return Number(row?.n ?? 0);
  }

  private async deliver(
    row: OutboxRow,
    now: Date,
  ): Promise<'sent' | 'retrying' | 'failed' | 'suppressed'> {
    const to = row.to_email.trim().toLowerCase();
    const [blocked] = await this.sql`SELECT 1 FROM core.email_suppression WHERE email = ${to}`;
    if (blocked) {
      await this
        .sql`UPDATE core.email_outbox SET status = 'suppressed', last_error = 'address is on the suppression list' WHERE id = ${row.id}`;
      return 'suppressed';
    }

    let rendered;
    try {
      rendered = renderEmail(await this.resolve(row), {
        productName: 'Aerolith Core',
        websiteUrl: this.config.websiteUrl,
        supportEmail: this.config.email.supportEmail,
      });
    } catch (err) {
      // Bad template or undecryptable data will not fix itself.
      const message =
        err instanceof UnknownTemplateError
          ? err.message
          : `could not prepare message: ${(err as Error).message}`;
      await this
        .sql`UPDATE core.email_outbox SET status = 'failed', attempts = attempts + 1, last_error = ${message} WHERE id = ${row.id}`;
      this.log.error(`email ${row.id} (${row.template}) failed permanently: ${message}`);
      return 'failed';
    }

    try {
      const { messageId } = await this.adapter!.send({
        from: this.config.email.from,
        replyTo: this.config.email.replyTo ?? undefined,
        to: row.to_email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        id: row.id,
      });
      await this
        .sql`UPDATE core.email_outbox SET status = 'sent', sent_at = ${now}, attempts = attempts + 1,
        provider_message_id = ${messageId}, subject = ${rendered.subject}, last_error = NULL WHERE id = ${row.id}`;
      if (row.template === 'licence_key' && typeof row.data.licenceId === 'string') {
        await this.sql`INSERT INTO core.licence_event (licence_id, kind, actor, data)
          VALUES (${row.data.licenceId}, 'emailed', 'email-worker', ${this.sql.json({ outboxId: row.id })})`;
      }
      return 'sent';
    } catch (err) {
      const outcome = classifyDeliveryError(err);
      const message = (err as Error).message.slice(0, 1000);
      const attempts = row.attempts + 1;
      if (outcome === 'retry' && attempts < MAX_ATTEMPTS) {
        const next = new Date(
          now.getTime() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!,
        );
        await this
          .sql`UPDATE core.email_outbox SET status = 'queued', attempts = ${attempts}, next_attempt_at = ${next},
          last_error = ${message} WHERE id = ${row.id}`;
        this.log.warn(`email ${row.id} to ${to} will retry (attempt ${attempts}): ${message}`);
        return 'retrying';
      }
      await this
        .sql`UPDATE core.email_outbox SET status = 'failed', attempts = ${attempts}, last_error = ${message} WHERE id = ${row.id}`;
      if (outcome === 'permanent_bad_recipient') {
        await this
          .sql`INSERT INTO core.email_suppression (email, reason, detail) VALUES (${to}, 'hard_bounce', ${message})
          ON CONFLICT (email) DO NOTHING`;
      }
      this.log.error(`email ${row.id} to ${to} failed permanently: ${message}`);
      return 'failed';
    }
  }

  /** Decrypts what the template needs. Secrets exist in plain text only in memory, only while sending. */
  private async resolve(row: OutboxRow) {
    const key = this.config.controlPlaneEncKey;
    const link = typeof row.data.link === 'string' ? open(row.data.link, key) : undefined;
    let licenceKey: string | undefined;
    if (row.template === 'licence_key') {
      const [lic] = await this.sql<
        { key_cipher: string }[]
      >`SELECT key_cipher FROM core.licence WHERE id = ${String(row.data.licenceId)}`;
      if (!lic) throw new Error('licence not found');
      licenceKey = open(lic.key_cipher, key);
    }
    return { template: row.template, data: row.data, link, licenceKey };
  }
}
