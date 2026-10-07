// The email worker against a real (local) SMTP server and the control-plane database.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { simpleParser, type ParsedMail } from 'mailparser';
import postgres, { type Sql } from 'postgres';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { EmailWorker } from '../src/email/email-worker.service.js';
import { LicensingService } from '../src/licensing/licensing.service.js';
import { signInOperator } from './helpers/operator.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
if (process.env.CI && !controlUrl) throw new Error('TEST_CONTROL_DATABASE_URL is required in CI');

describe.skipIf(!controlUrl)('email worker (integration)', () => {
  let app: NestFastifyApplication;
  let sql: Sql;
  let smtp: SMTPServer;
  let worker: EmailWorker;
  let owner: Record<string, string> = {};
  const received: ParsedMail[] = [];
  const behaviour = { tempFailData: false };

  const queue = async (to: string, template = 'test', data: object = {}) =>
    (
      await sql<
        { id: string }[]
      >`INSERT INTO core.email_outbox (to_email, template, data) VALUES (${to}, ${template}, ${sql.json(data as never)}) RETURNING id`
    )[0]!.id;
  const row = async (id: string) =>
    (
      await sql<
        {
          status: string;
          attempts: number;
          next_attempt_at: Date | null;
          last_error: string | null;
          provider_message_id: string | null;
        }[]
      >`
      SELECT status, attempts, next_attempt_at, last_error, provider_message_id FROM core.email_outbox WHERE id = ${id}`
    )[0]!;

  beforeAll(async () => {
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onRcptTo(address, _session, cb) {
        if (address.address.startsWith('bounce'))
          return cb(Object.assign(new Error('5.1.1 No such user'), { responseCode: 550 }));
        cb();
      },
      onData(stream, _session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          if (behaviour.tempFailData)
            return cb(Object.assign(new Error('4.3.0 Try again later'), { responseCode: 451 }));
          void simpleParser(Buffer.concat(chunks)).then((mail) => {
            received.push(mail);
            cb();
          });
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    const port = (smtp.server.address() as AddressInfo).port;

    sql = postgres(controlUrl!, { onnotice: () => {} });
    await sql`DROP SCHEMA IF EXISTS core CASCADE`;
    await sql`DROP SCHEMA IF EXISTS aerolith_meta CASCADE`;
    await migrate(sql);
    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      CONTROL_PLANE_ENC_KEY: randomBytes(32).toString('base64'),
      RATE_LIMIT_SCALE: '20',
      EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_REQUIRE_TLS: 'false',
      EMAIL_FROM: 'Aerolith Core <no-reply@aerolith.example.in>',
      SUPPORT_EMAIL: 'help@aerolith.example.in',
      WEBSITE_URL: 'https://aerolith.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    worker = app.get(EmailWorker);
    owner = (await signInOperator(app)).headers;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await new Promise<void>((resolve) => smtp?.close(() => resolve()));
    for (const k of [
      'EMAIL_TRANSPORT',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_REQUIRE_TLS',
      'EMAIL_FROM',
      'SUPPORT_EMAIL',
    ])
      delete process.env[k];
  });

  beforeEach(async () => {
    received.length = 0;
    behaviour.tempFailData = false;
    // Isolate tests: everything earlier is already sent or irrelevant.
    await sql`UPDATE core.email_outbox SET status = 'sent', sent_at = now() - interval '2 hours' WHERE status IN ('queued', 'sending')`;
  });

  it('sends the licence key and the admin set-password link for a new trial', async () => {
    const trial = await app
      .get(LicensingService)
      .createTenantWithTrial('admin@sharma-builders.in', 'Sharma Builders', 'test');
    const run = await worker.runOnce();
    expect(run).toMatchObject({ sent: 2, failed: 0, retrying: 0 });

    const licenceMail = received.find((m) => m.subject === 'Your Aerolith Core licence key')!;
    expect(licenceMail.to).toMatchObject({ text: 'admin@sharma-builders.in' });
    expect(licenceMail.from?.text).toContain('no-reply@aerolith.example.in');
    expect(licenceMail.text).toContain(trial.licenceKey);
    expect(licenceMail.html).toContain(trial.licenceKey);

    const setupMail = received.find((m) => m.subject === 'Set your Aerolith Core admin password')!;
    expect(setupMail.text).toMatch(
      /https:\/\/aerolith\.example\.in\/account\/set-password\?token=[\w-]{40,}/,
    );

    const rows =
      await sql`SELECT status, subject, provider_message_id FROM core.email_outbox WHERE to_email = 'admin@sharma-builders.in'`;
    expect(rows.every((r) => r.status === 'sent' && r.provider_message_id && r.subject)).toBe(true);
    const [event] =
      await sql`SELECT kind FROM core.licence_event WHERE licence_id = ${trial.licenceId} AND kind = 'emailed'`;
    expect(event).toBeTruthy();
    // The outbox never stored the key or a readable link.
    const stored = JSON.stringify(await sql`SELECT data FROM core.email_outbox`);
    expect(stored).not.toContain(trial.licenceKey.slice(5));
    expect(stored).not.toContain('set-password?token=');
  });

  it('retries temporary failures with backoff, then delivers', async () => {
    const id = await queue('retry@example.in');
    behaviour.tempFailData = true;
    const now = new Date();
    expect(await worker.runOnce(now)).toMatchObject({ retrying: 1 });
    const first = await row(id);
    expect(first).toMatchObject({ status: 'queued', attempts: 1 });
    expect(first.last_error).toContain('Try again later');
    expect(first.next_attempt_at!.getTime() - now.getTime()).toBe(60_000);

    behaviour.tempFailData = false;
    expect(await worker.runOnce(now)).toMatchObject({ sent: 0 }); // not due yet
    expect(await worker.runOnce(new Date(now.getTime() + 61_000))).toMatchObject({ sent: 1 });
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
  });

  it('stops after a hard bounce and never sends to that address again', async () => {
    const first = await queue('bounce@example.in');
    expect(await worker.runOnce()).toMatchObject({ failed: 1 });
    expect((await row(first)).last_error).toContain('No such user');
    const [suppressed] =
      await sql`SELECT reason FROM core.email_suppression WHERE email = 'bounce@example.in'`;
    expect(suppressed).toMatchObject({ reason: 'hard_bounce' });

    const second = await queue('Bounce@Example.in');
    expect(await worker.runOnce()).toMatchObject({ suppressed: 1, sent: 0 });
    expect((await row(second)).status).toBe('suppressed');
  });

  it('respects the hourly sending cap', async () => {
    await sql`INSERT INTO core.email_outbox (to_email, template, status, sent_at)
      SELECT 'filler' || g || '@example.in', 'test', 'sent', now() FROM generate_series(1, 60) g`;
    const id = await queue('later@example.in');
    expect(await worker.runOnce()).toMatchObject({ sent: 0, deferredByRateLimit: true });
    expect((await row(id)).status).toBe('queued');
    await sql`UPDATE core.email_outbox SET sent_at = now() - interval '2 hours' WHERE to_email LIKE 'filler%'`;
    expect(await worker.runOnce()).toMatchObject({ sent: 1 });
  });

  it('recovers emails left in "sending" by a crashed process', async () => {
    const id = await queue('stuck@example.in');
    await sql`UPDATE core.email_outbox SET status = 'sending', sending_started_at = now() - interval '20 minutes' WHERE id = ${id}`;
    expect(await worker.runOnce()).toMatchObject({ sent: 1 });
  });

  it('fails unknown templates once, without retrying', async () => {
    const id = await queue('x@example.in', 'no_such_template');
    expect(await worker.runOnce()).toMatchObject({ failed: 1 });
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('gives the owner delivery health, retry and suppression controls without exposing links', async () => {
    const failedId = await queue('bounce2@example.in');
    await queue('fine@example.in', 'admin_password_setup', { link: 'not-sealed' });
    await worker.runOnce();
    const list = await app.inject({
      method: 'GET',
      url: '/api/owner/emails?limit=200',
      headers: owner,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('token=');
    expect(
      list.json<{ id: string; status: string }[]>().find((e) => e.id === failedId)?.status,
    ).toBe('failed');

    const summary = (
      await app.inject({ method: 'GET', url: '/api/owner/emails/summary', headers: owner })
    ).json<{ sentLastHour: number }>();
    expect(summary.sentLastHour).toBeGreaterThan(0);

    await app.inject({
      method: 'POST',
      url: '/api/owner/email-suppressions/remove',
      headers: owner,
      payload: { email: 'bounce2@example.in' },
    });
    const retry = await app.inject({
      method: 'POST',
      url: `/api/owner/emails/${failedId}/retry`,
      headers: owner,
    });
    expect(retry.json()).toEqual({ id: failedId, status: 'queued' });

    const test = await app.inject({
      method: 'POST',
      url: '/api/owner/emails/test',
      headers: owner,
      payload: { email: 'owner@example.in' },
    });
    expect(test.statusCode).toBe(201);
    await worker.runOnce();
    expect(received.some((m) => m.subject === 'Aerolith Core test email')).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/owner/emails' })).statusCode).toBe(401);
  });
});
