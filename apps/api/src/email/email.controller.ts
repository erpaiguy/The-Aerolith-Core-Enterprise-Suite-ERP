import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { OperatorGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CONTROL_DB } from '../db/db.module.js';

const listQuery = z.object({
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'suppressed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const emailBody = z.object({ email: z.string().email().max(254) });
const suppressBody = z.object({
  email: z.string().email().max(254),
  detail: z.string().max(500).default(''),
});

/** Owner console: delivery health. Never returns links, keys or message bodies. */
@Controller('owner')
@UseGuards(OperatorGuard)
export class EmailOwnerController {
  constructor(@Inject(CONTROL_DB) private readonly sql: Sql) {}

  @Get('emails')
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this
      .sql`SELECT id, to_email AS "to", template, subject, status, attempts, last_error AS "lastError",
        next_attempt_at AS "nextAttemptAt", created_at AS "createdAt", sent_at AS "sentAt"
      FROM core.email_outbox ${q.status ? this.sql`WHERE status = ${q.status}` : this.sql``}
      ORDER BY created_at DESC LIMIT ${q.limit}`;
  }

  @Get('emails/summary')
  async summary() {
    const rows = await this.sql<{ status: string; n: number }[]>`
      SELECT status, count(*)::int AS n FROM core.email_outbox WHERE created_at > now() - interval '7 days' GROUP BY status`;
    const [hour] = await this.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM core.email_outbox WHERE sent_at > now() - interval '1 hour'`;
    return {
      last7Days: Object.fromEntries(rows.map((r) => [r.status, r.n])),
      sentLastHour: hour?.n ?? 0,
    };
  }

  /** Puts a failed or suppressed email back in the queue (e.g. after fixing SMTP settings). */
  @Post('emails/:id/retry')
  @HttpCode(200)
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this
      .sql`UPDATE core.email_outbox SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL
      WHERE id = ${id} AND status IN ('failed', 'suppressed') RETURNING id`;
    if (!row) throw new NotFoundException({ code: 'email_not_retryable' });
    return { id, status: 'queued' };
  }

  /** Queues a test message to check SMTP settings. */
  @Post('emails/test')
  async test(@Body(new ZodPipe(emailBody)) body: z.infer<typeof emailBody>) {
    const [row] = await this.sql<
      { id: string }[]
    >`INSERT INTO core.email_outbox (to_email, template) VALUES (${body.email}, 'test') RETURNING id`;
    return { id: row!.id, status: 'queued' };
  }

  @Get('email-suppressions')
  suppressions() {
    return this
      .sql`SELECT email, reason, detail, created_at AS "createdAt" FROM core.email_suppression ORDER BY created_at DESC LIMIT 500`;
  }

  @Post('email-suppressions')
  async suppress(@Body(new ZodPipe(suppressBody)) body: z.infer<typeof suppressBody>) {
    await this
      .sql`INSERT INTO core.email_suppression (email, reason, detail) VALUES (${body.email.toLowerCase()}, 'manual', ${body.detail})
      ON CONFLICT (email) DO NOTHING`;
    return { email: body.email.toLowerCase(), suppressed: true };
  }

  @Post('email-suppressions/remove')
  @HttpCode(200)
  async unsuppress(@Body(new ZodPipe(emailBody)) body: z.infer<typeof emailBody>) {
    await this.sql`DELETE FROM core.email_suppression WHERE email = ${body.email.toLowerCase()}`;
    return { email: body.email.toLowerCase(), suppressed: false };
  }
}
