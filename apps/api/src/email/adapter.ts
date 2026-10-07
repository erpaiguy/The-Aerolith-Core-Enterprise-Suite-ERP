// How email leaves the system (docs/infra-existing-stack.md §1). SMTP for the GoDaddy mailbox (or any provider),
// a file adapter for development and tests that writes real .eml files, and nothing else.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingEmail {
  from: string;
  replyTo?: string | undefined;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable id so a retried send is recognisable in the mailbox (Message-ID header). */
  id: string;
}

export interface EmailAdapter {
  send(email: OutgoingEmail): Promise<{ messageId: string }>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** true = TLS from the first byte (port 465). false = STARTTLS upgrade (port 587). */
  secure: boolean;
  user: string;
  password: string;
  /** Refuse to send unless the connection is encrypted. Only ever false in development/tests. */
  requireTls: boolean;
}

const messageId = (email: OutgoingEmail, from: string): string =>
  `<${email.id}@${from.split('@')[1]?.replace(/>.*$/, '') ?? 'aerolith'}>`;

export class SmtpAdapter implements EmailAdapter {
  private readonly transport: Transporter;

  constructor(settings: SmtpSettings) {
    this.transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: settings.requireTls && !settings.secure,
      ignoreTLS: !settings.requireTls && !settings.secure,
      auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  async send(email: OutgoingEmail): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({
      from: email.from,
      replyTo: email.replyTo,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      messageId: messageId(email, email.from),
    });
    return { messageId: String(info.messageId) };
  }
}

/** Development/test: writes each message as a real RFC 5322 .eml file you can open in any mail client. */
export class FileAdapter implements EmailAdapter {
  private readonly transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async send(email: OutgoingEmail): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({
      from: email.from,
      replyTo: email.replyTo,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      messageId: messageId(email, email.from),
    });
    const safeTo = email.to.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
    writeFileSync(
      join(this.dir, `${Date.now()}-${email.id}-${safeTo}.eml`),
      info.message as Buffer,
    );
    return { messageId: String(info.messageId) };
  }
}

export type DeliveryOutcome = 'retry' | 'permanent' | 'permanent_bad_recipient';

/**
 * Classifies an SMTP failure.
 * - 5xx to RCPT TO: the address does not exist. Never try it again (suppressed).
 * - 5xx to DATA: the server refused this message's content. Final for this message.
 * - Everything else is retried: timeouts, 4xx, and configuration problems (wrong password, sender not allowed,
 *   "basic authentication is not supported"). Those are fixed in settings, and the queued customer emails must
 *   still go out afterwards instead of being thrown away.
 */
export function classifyDeliveryError(err: unknown): DeliveryOutcome {
  const e = err as { responseCode?: number; command?: string };
  if (typeof e.responseCode === 'number' && e.responseCode >= 500) {
    if (e.command === 'RCPT TO') return 'permanent_bad_recipient';
    if (e.command === 'DATA') return 'permanent';
  }
  return 'retry';
}
