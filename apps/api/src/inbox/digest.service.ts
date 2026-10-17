// The daily reminder digest (docs/wave8-plan.md step 8g.3): each morning after 07:00 IST, one email per person who
// has given an address and not turned it off, with what is overdue, what falls due this week, what waits on them,
// and what is expiring: tender and contract guarantees, insurance, permits to work past their validity, vendor KYC
// documents, and buyers' overdue demands. Each person sees only their own tenders and projects, and company-wide
// registers only with the permission to act on them. Nothing to say, no email. Sent through the email outbox.
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CONTROL_DB } from '../db/db.module.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { InboxService } from './inbox.service.js';

const HOUR = 3_600_000;
const SEND_FROM_HOUR = 7;
const PER_SECTION = 10;

export interface DigestSection {
  title: string;
  lines: string[];
  more: number;
}

const istDay = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const istHour = (at: Date) => new Date(at.getTime() + 330 * 60_000).getUTCHours();
const inr = (v: string | number) =>
  `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const day = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

@Injectable()
export class DigestService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Digest');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly tenants: TenantConnections,
    private readonly inbox: InboxService,
    private readonly permissions: PermissionsService,
    @Inject(CONTROL_DB) private readonly control: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (!this.config.reportsWorker || this.config.email.transport === 'disabled') return;
    this.timer = setInterval(() => void this.tick(), HOUR);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // --- the person's own settings ---

  async settings(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const [u] = await db<{ email: string | null; enabled: boolean; sentOn: string | null }[]>`
      SELECT email, digest_enabled AS enabled, to_char(digest_sent_on, 'YYYY-MM-DD') AS "sentOn"
      FROM platform."user" WHERE id = ${claims.sub}`;
    return { ...u!, preview: await this.sections(claims, new Date()) };
  }

  async setSettings(claims: TenantClaims, input: { email: string | null; enabled: boolean }) {
    const email = input.email?.trim().toLowerCase() || null;
    if (input.enabled && !email)
      throw new BadRequestException({
        code: 'email_needed',
        message: 'Give an email address to get the morning digest.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db`UPDATE platform."user" SET email = ${email}, digest_enabled = ${input.enabled} WHERE id = ${claims.sub}`;
    return this.settings(claims);
  }

  // --- what goes in it ---

  /** The digest's sections for one person, empty ones left out. */
  async sections(claims: TenantClaims, now: Date): Promise<DigestSection[]> {
    const db = await this.tenants.forTenant(claims.ten);
    const today = istDay(now);
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + 30);
    const in30 = soon.toISOString().slice(0, 10);
    const week = new Date(now.getTime() + 7 * 86_400_000);
    const all = await this.permissions.can(claims, 'projects.all');
    const projects = all
      ? db`SELECT id FROM proj.project`
      : db`SELECT project_id FROM proj.member WHERE user_id = ${claims.sub}`;
    const out: DigestSection[] = [];
    const add = (title: string, lines: string[], total = lines.length) => {
      if (total > 0)
        out.push({
          title,
          lines: lines.slice(0, PER_SECTION),
          more: Math.max(0, total - PER_SECTION),
        });
    };

    const due = await db<{ title: string; due_at: Date | null }[]>`
      SELECT title, due_at FROM platform.notification
      WHERE user_id = ${claims.sub} AND read_at IS NULL AND due_at IS NOT NULL AND due_at <= ${now}
      ORDER BY due_at LIMIT 50`;
    add(
      'Overdue and due today',
      due.map((n) => `${n.title} (${day(n.due_at!.toISOString())})`),
    );
    const coming = await db<{ title: string; due_at: Date }[]>`
      SELECT title, due_at FROM platform.notification
      WHERE user_id = ${claims.sub} AND due_at > ${now} AND due_at <= ${week} ORDER BY due_at LIMIT 50`;
    add(
      'Coming up this week',
      coming.map((n) => `${day(n.due_at.toISOString())}: ${n.title}`),
    );

    const work = await this.inbox.myWork(claims);
    const waiting = [
      [work.approvals.count, 'approval', 'approvals'],
      [work.rfis.count, 'RFI to answer', 'RFIs to answer'],
      [work.bills.count, 'subcontract bill to certify', 'subcontract bills to certify'],
      [work.ncrs.count, 'NCR open', 'NCRs open'],
      [work.actions.count, 'meeting action', 'meeting actions'],
      [work.findings.count, 'safety finding', 'safety findings'],
      [work.followUps.count, 'CRM follow-up this week', 'CRM follow-ups this week'],
    ] as const;
    add(
      'Waiting on you',
      waiting.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`),
    );

    const expiring: string[] = [];
    const tenderSec = await db<
      { purpose: string; amount: string; valid_until: string; tender: string }[]
    >`
      SELECT s.purpose, s.amount::text, to_char(s.valid_until, 'YYYY-MM-DD') AS valid_until, t.title AS tender
      FROM tender.security_instrument s JOIN tender.tender t ON t.id = s.tender_id
      WHERE s.status IN ('issued', 'submitted') AND s.valid_until <= ${in30}
        AND (t.owner_id = ${claims.sub} OR ${claims.role === 'admin'})
      ORDER BY s.valid_until`;
    for (const s of tenderSec)
      expiring.push(
        `${s.valid_until < today ? 'Lapsed' : 'Expires'} ${day(s.valid_until)}: ${s.purpose.toUpperCase()} ${inr(s.amount)}, ${s.tender}`,
      );
    const contractSec = await db<
      { kind: string; amount: string; valid_until: string; contract: string }[]
    >`
      SELECT s.kind, s.amount::text, to_char(s.valid_until, 'YYYY-MM-DD') AS valid_until, c.title AS contract
      FROM ctl.security s JOIN ctl.contract c ON c.id = s.contract_id
      WHERE s.status = 'held' AND s.valid_until <= ${in30} AND c.project_id IN (${projects})
      ORDER BY s.valid_until`;
    for (const s of contractSec)
      expiring.push(
        `${s.valid_until < today ? 'Lapsed' : 'Expires'} ${day(s.valid_until)}: ${s.kind === 'insurance' ? 'insurance' : `${s.kind.replace('_', ' ')} guarantee`} ${inr(s.amount)}, ${s.contract}`,
      );
    const permits = await db<{ number: string; kind: string; valid_to: Date; project: string }[]>`
      SELECT p.number, p.kind, p.valid_to, j.name AS project
      FROM hse.permit p JOIN proj.project j ON j.id = p.project_id
      WHERE p.status = 'issued' AND p.valid_to < ${now} AND p.project_id IN (${projects})
      ORDER BY p.valid_to`;
    for (const p of permits)
      expiring.push(
        `Permit ${p.number} (${p.kind.replace('_', ' ')}) past its validity and not closed, ${p.project}`,
      );
    if (await this.permissions.can(claims, 'purchase.edit')) {
      const kyc = await db<{ kind: string; valid_until: string; party: string }[]>`
        SELECT DISTINCT ON (d.party_id, d.kind) d.kind, to_char(d.valid_until, 'YYYY-MM-DD') AS valid_until,
          y.name AS party
        FROM proc.vendor_document d JOIN platform.party y ON y.id = d.party_id
        WHERE d.removed_at IS NULL AND d.valid_until IS NOT NULL
        ORDER BY d.party_id, d.kind, d.valid_until DESC`;
      for (const k of kyc
        .filter((x) => x.valid_until <= in30)
        .sort((a, b) => a.valid_until.localeCompare(b.valid_until)))
        expiring.push(
          `${k.valid_until < today ? 'Lapsed' : 'Expires'} ${day(k.valid_until)}: ${k.party}'s ${k.kind.replace(/_/g, ' ')}`,
        );
    }
    add('Expiring in 30 days, or lapsed', expiring);

    if (await this.permissions.can(claims, 'sales.edit')) {
      const demands = await db<{ number: string; due_on: string; owed: string; buyer: string }[]>`
        SELECT d.number, to_char(d.due_on, 'YYYY-MM-DD') AS due_on,
          (d.base + d.cgst + d.sgst - d.paid)::text AS owed, u.name AS buyer
        FROM re.demand d JOIN re.booking b ON b.id = d.booking_id JOIN re.buyer u ON u.id = b.buyer_id
        WHERE b.status <> 'cancelled' AND d.due_on < ${today} AND d.base + d.cgst + d.sgst > d.paid
        ORDER BY d.due_on`;
      add(
        "Buyers' demands overdue",
        demands.map((d) => `${d.number}, ${d.buyer}: ${inr(d.owed)} due ${day(d.due_on)}`),
      );
    }
    return out;
  }

  // --- sending ---

  /** Sends today's digest to everyone due one in a tenant; returns how many were queued. */
  async runDue(tenantId: string, now: Date): Promise<number> {
    if (istHour(now) < SEND_FROM_HOUR) return 0;
    const today = istDay(now);
    const db = await this.tenants.forTenant(tenantId);
    const people = await db<
      { id: string; display_name: string; role: TenantClaims['role']; email: string }[]
    >`
      SELECT id, display_name, role, email FROM platform."user"
      WHERE status = 'active' AND digest_enabled AND email IS NOT NULL
        AND (digest_sent_on IS NULL OR digest_sent_on < ${today})`;
    const [company] = await db<{ name: string }[]>`
      SELECT name FROM platform.entity ORDER BY is_default DESC, created_at LIMIT 1`;
    let sent = 0;
    for (const p of people) {
      const t = Math.floor(now.getTime() / 1000);
      const claims: TenantClaims = {
        v: 1,
        kind: 'tenant',
        ten: tenantId,
        sub: p.id,
        role: p.role,
        sid: 'daily-digest',
        mcp: false,
        lic: 'active',
        iat: t,
        exp: t + 60,
      };
      const sections = await this.sections(claims, now);
      // Marked first: a crash after queueing must not send it twice.
      await db`UPDATE platform."user" SET digest_sent_on = ${today} WHERE id = ${p.id}`;
      if (!sections.length) continue;
      const count = sections.reduce((s, x) => s + x.lines.length + x.more, 0);
      await this.control`
        INSERT INTO core.email_outbox (to_email, template, data)
        VALUES (${p.email}, 'daily_digest', ${this.control.json({
          name: p.display_name,
          company: company?.name ?? '',
          summary: `${count} ${count === 1 ? 'thing' : 'things'} for ${day(today)}`,
          sections,
        } as unknown as Parameters<Sql['json']>[0])})`;
      sent++;
    }
    return sent;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const tenants = await this.control<{ tenant_id: string }[]>`
        SELECT tenant_id FROM core.tenant_db WHERE status = 'ready'`;
      for (const { tenant_id } of tenants)
        await this.runDue(tenant_id, new Date()).catch((err: unknown) =>
          this.log.warn(`Digest failed for ${tenant_id}: ${(err as Error).message}`),
        );
    } finally {
      this.running = false;
    }
  }
}
