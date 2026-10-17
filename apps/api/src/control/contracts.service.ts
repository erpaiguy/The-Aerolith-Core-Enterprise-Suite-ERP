// Contracts and claims (docs/wave4-plan.md step 5): a project's contracts with their securities (reminded before
// they expire, as Wave 1's tender securities are), dated obligations, notices to answer, extensions of time built from
// the daily reports' hindrances, and cost claims followed to settlement.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { eotDays, reminderDates, type Hindrance } from './contract-rules.js';

type Db = Sql | TransactionSql;
const KIND_LABEL: Record<string, string> = {
  performance: 'Performance guarantee',
  advance: 'Advance guarantee',
  retention_bond: 'Retention bond',
  insurance: 'Insurance policy',
  other: 'Security',
};

export interface ContractInput {
  kind: 'client' | 'subcontract';
  partyId: string | null;
  orderId: string | null;
  reference: string;
  title: string;
  value: string;
  signedOn: string | null;
  startOn: string | null;
  completionOn: string | null;
  dlpMonths: number;
  ldPctPerWeek: string;
  ldCapPct: string;
  paymentTerms: string;
  notes: string;
}

@Injectable()
export class ContractsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
  ) {}

  private async commercial(db: Db, claims: TenantClaims, projectId: string) {
    await this.projects.access(db, claims, projectId);
    if (!(await this.permissions.can(claims, 'billing.edit')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'billing.edit',
        message:
          'Contracts, securities, notices, extensions and claims are kept with the billing permission.',
      });
  }

  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team keeps its obligations.",
      });
  }

  private async contractOf(db: Db, id: string) {
    const [c] = await db<
      { id: string; project_id: string; reference: string; created_by: string | null }[]
    >`
      SELECT id, project_id, reference, created_by FROM ctl.contract WHERE id = ${id}`;
    if (!c) throw new NotFoundException({ code: 'not_found', message: 'No such contract.' });
    return c;
  }

  /** Who is reminded: the project's leads, else whoever entered the contract. */
  private async recipients(tx: Db, contractId: string) {
    const rows = await tx<{ user_id: string }[]>`
      SELECT m.user_id FROM ctl.contract c JOIN proj.member m ON m.project_id = c.project_id AND m.role = 'lead'
      WHERE c.id = ${contractId}`;
    if (rows.length) return rows.map((r) => r.user_id);
    const [c] = await tx<
      { created_by: string | null }[]
    >`SELECT created_by FROM ctl.contract WHERE id = ${contractId}`;
    return c?.created_by ? [c.created_by] : [];
  }

  /** Replaces the future reminders of one dated item. */
  private async remind(
    tx: TransactionSql,
    source: string,
    contractId: string,
    due: string | null,
    before: number[],
    title: (days: number) => string,
    kind: string,
  ) {
    const now = new Date();
    await tx`DELETE FROM platform.notification WHERE source = ${source} AND (due_at > ${now} OR read_at IS NULL)`;
    if (!due) return;
    const [c] = await tx<
      { project_id: string }[]
    >`SELECT project_id FROM ctl.contract WHERE id = ${contractId}`;
    for (const user of await this.recipients(tx, contractId))
      for (const r of reminderDates(due, before, now))
        await tx`INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
          VALUES (${user}, ${kind}, ${title(r.days)}, ${`/contracts?project=${c!.project_id}`}, ${r.at}, ${source})`;
  }

  /**
   * Reminders before a client contract's defect liability period ends (docs/wave8-plan.md step 8d.3): the period runs
   * from completion for the contract's months; at its end the retention held and the performance guarantee are due
   * back, once the defects reported in it are put right.
   */
  private async dlpReminder(tx: TransactionSql, contractId: string) {
    const [c] = await tx<{ kind: string; reference: string; ends: string | null }[]>`
      SELECT kind, reference,
        CASE WHEN completion_on IS NULL THEN NULL
          ELSE to_char(completion_on + make_interval(months => dlp_months), 'YYYY-MM-DD') END AS ends
      FROM ctl.contract WHERE id = ${contractId}`;
    await this.remind(
      tx,
      `contract-dlp:${contractId}`,
      contractId,
      c?.kind === 'client' ? (c.ends ?? null) : null,
      [60, 30, 7],
      (days) =>
        `Defect liability on ${c!.reference} ends in ${days} days, on ${c!.ends}: clear the defects, then claim back the retention and the performance guarantee`,
      'dlp_end',
    );
  }

  // --- contracts ---

  async create(claims: TenantClaims, projectId: string, input: ContractInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.commercial(db, claims, projectId);
    if (input.kind === 'subcontract') {
      if (!input.orderId && !input.partyId)
        throw new BadRequestException({
          code: 'whose',
          message: 'A subcontract names its work order or subcontractor.',
        });
      if (input.orderId) {
        const [o] =
          await db`SELECT 1 FROM proc.purchase_order WHERE id = ${input.orderId} AND project_id = ${projectId} AND kind = 'work'`;
        if (!o)
          throw new BadRequestException({
            code: 'not_a_work_order',
            message: 'Not a work order of this project.',
          });
      }
    }
    const id = await db.begin(async (tx) => {
      const [party] = input.orderId
        ? await tx<
            { party_id: string }[]
          >`SELECT party_id FROM proc.purchase_order WHERE id = ${input.orderId}`
        : input.kind === 'client'
          ? await tx<
              { party_id: string }[]
            >`SELECT client_id AS party_id FROM proj.project WHERE id = ${projectId}`
          : [];
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO ctl.contract (project_id, kind, party_id, order_id, reference, title, value, signed_on, start_on,
          completion_on, dlp_months, ld_pct_per_week, ld_cap_pct, payment_terms, notes, created_by)
        VALUES (${projectId}, ${input.kind}, ${input.partyId ?? party?.party_id ?? null}, ${input.orderId}, ${input.reference},
          ${input.title}, ${input.value}, ${input.signedOn}, ${input.startOn}, ${input.completionOn}, ${input.dlpMonths},
          ${input.ldPctPerWeek}, ${input.ldCapPct}, ${input.paymentTerms}, ${input.notes}, ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'contract.create', 'contract', c!.id, {
        reference: input.reference,
      });
      await this.dlpReminder(tx, c!.id);
      return c!.id;
    });
    return { id, ...(await this.register(claims, projectId)) };
  }

  async update(
    claims: TenantClaims,
    id: string,
    input: ContractInput & { status: string; rowVersion: number },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.contractOf(db, id);
    await this.commercial(db, claims, c.project_id);
    await db.begin(async (tx) => {
      const r = await tx`
        UPDATE ctl.contract SET reference = ${input.reference}, title = ${input.title}, value = ${input.value},
          signed_on = ${input.signedOn}, start_on = ${input.startOn}, completion_on = ${input.completionOn},
          dlp_months = ${input.dlpMonths}, ld_pct_per_week = ${input.ldPctPerWeek}, ld_cap_pct = ${input.ldCapPct},
          payment_terms = ${input.paymentTerms}, notes = ${input.notes}, status = ${input.status},
          row_version = row_version + 1
        WHERE id = ${id} AND row_version = ${input.rowVersion} RETURNING 1`;
      if (!r.length)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed it; reload and try again.',
        });
      await audit(tx, claims.sub, 'contract.update', 'contract', id, {});
      await this.dlpReminder(tx, id);
    });
    return this.register(claims, c.project_id);
  }

  // --- securities ---

  private async rescheduleSecurity(tx: TransactionSql, id: string) {
    const [s] = await tx<
      {
        contract_id: string;
        kind: string;
        number: string;
        amount: string;
        valid_until: string;
        status: string;
        reference: string;
      }[]
    >`
      SELECT s.contract_id, s.kind, s.number, s.amount::text, to_char(s.valid_until, 'YYYY-MM-DD') AS valid_until, s.status,
        c.reference
      FROM ctl.security s JOIN ctl.contract c ON c.id = s.contract_id WHERE s.id = ${id}`;
    await this.remind(
      tx,
      `contract-security:${id}`,
      s!.contract_id,
      s!.status === 'held' ? s!.valid_until : null,
      [30, 7],
      (days) =>
        `${KIND_LABEL[s!.kind]}${s!.number ? ` ${s!.number}` : ''} on ${s!.reference} (₹${s!.amount}) expires in ${days} days, on ${s!.valid_until}`,
      'security_expiry',
    );
  }

  async addSecurity(
    claims: TenantClaims,
    contractId: string,
    input: {
      kind: string;
      issuer: string;
      number: string;
      amount: string;
      validUntil: string;
      claimUntil: string | null;
      notes: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.contractOf(db, contractId);
    await this.commercial(db, claims, c.project_id);
    await db.begin(async (tx) => {
      const [s] = await tx<{ id: string }[]>`
        INSERT INTO ctl.security (contract_id, kind, issuer, number, amount, valid_until, claim_until, notes)
        VALUES (${contractId}, ${input.kind}, ${input.issuer}, ${input.number}, ${input.amount}, ${input.validUntil},
          ${input.claimUntil}, ${input.notes})
        RETURNING id`;
      await this.rescheduleSecurity(tx, s!.id);
      await audit(tx, claims.sub, 'contract.security', 'contract', contractId, {
        kind: input.kind,
        amount: input.amount,
      });
    });
    return this.register(claims, c.project_id);
  }

  /** Extended (a new date), returned or invoked; reminders follow. */
  async updateSecurity(
    claims: TenantClaims,
    id: string,
    input: { validUntil: string; status: 'held' | 'returned' | 'invoked'; rowVersion: number },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<
      { contract_id: string }[]
    >`SELECT contract_id FROM ctl.security WHERE id = ${id}`;
    if (!s) throw new NotFoundException({ code: 'not_found', message: 'No such security.' });
    const c = await this.contractOf(db, s.contract_id);
    await this.commercial(db, claims, c.project_id);
    await db.begin(async (tx) => {
      const r = await tx`
        UPDATE ctl.security SET valid_until = ${input.validUntil}, status = ${input.status}, row_version = row_version + 1
        WHERE id = ${id} AND row_version = ${input.rowVersion} RETURNING 1`;
      if (!r.length)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed it; reload and try again.',
        });
      await this.rescheduleSecurity(tx, id);
      await audit(tx, claims.sub, 'contract.security_update', 'contract', s.contract_id, {
        ...input,
      });
    });
    return this.register(claims, c.project_id);
  }

  // --- obligations and notices ---

  async addObligation(
    claims: TenantClaims,
    contractId: string,
    input: { title: string; clause: string; dueOn: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.contractOf(db, contractId);
    await this.team(db, claims, c.project_id);
    await db.begin(async (tx) => {
      const [o] = await tx<{ id: string }[]>`
        INSERT INTO ctl.obligation (contract_id, title, clause, due_on) VALUES (${contractId}, ${input.title}, ${input.clause},
          ${input.dueOn}) RETURNING id`;
      await this.remind(
        tx,
        `obligation:${o!.id}`,
        contractId,
        input.dueOn,
        [7, 1],
        (days) =>
          `${input.title} (${c.reference}${input.clause ? `, ${input.clause}` : ''}) is due in ${days} days`,
        'obligation_due',
      );
    });
    return this.register(claims, c.project_id);
  }

  async obligationDone(claims: TenantClaims, id: string, on: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const [o] = await db<
      { contract_id: string }[]
    >`SELECT contract_id FROM ctl.obligation WHERE id = ${id}`;
    if (!o) throw new NotFoundException({ code: 'not_found', message: 'No such obligation.' });
    const c = await this.contractOf(db, o.contract_id);
    await this.team(db, claims, c.project_id);
    await db.begin(async (tx) => {
      await tx`UPDATE ctl.obligation SET done_on = ${on} WHERE id = ${id}`;
      if (on)
        await tx`DELETE FROM platform.notification WHERE source = ${`obligation:${id}`} AND read_at IS NULL`;
    });
    return this.register(claims, c.project_id);
  }

  async addNotice(
    claims: TenantClaims,
    contractId: string,
    input: {
      direction: 'sent' | 'received';
      subject: string;
      clause: string;
      dated: string;
      reference: string;
      replyBy: string | null;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.contractOf(db, contractId);
    await this.commercial(db, claims, c.project_id);
    await db.begin(async (tx) => {
      const [n] = await tx<{ id: string }[]>`
        INSERT INTO ctl.notice (contract_id, direction, subject, clause, dated, reference, reply_by)
        VALUES (${contractId}, ${input.direction}, ${input.subject}, ${input.clause}, ${input.dated}, ${input.reference},
          ${input.replyBy}) RETURNING id`;
      await this.remind(
        tx,
        `notice:${n!.id}`,
        contractId,
        input.replyBy,
        [3],
        (days) => `Reply due in ${days} days: ${input.subject} (${c.reference})`,
        'notice_reply',
      );
    });
    return this.register(claims, c.project_id);
  }

  async noticeReplied(claims: TenantClaims, id: string, on: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const [n] = await db<
      { contract_id: string }[]
    >`SELECT contract_id FROM ctl.notice WHERE id = ${id}`;
    if (!n) throw new NotFoundException({ code: 'not_found', message: 'No such notice.' });
    const c = await this.contractOf(db, n.contract_id);
    await this.commercial(db, claims, c.project_id);
    await db.begin(async (tx) => {
      await tx`UPDATE ctl.notice SET replied_on = ${on} WHERE id = ${id}`;
      if (on)
        await tx`DELETE FROM platform.notification WHERE source = ${`notice:${id}`} AND read_at IS NULL`;
    });
    return this.register(claims, c.project_id);
  }

  // --- extensions of time ---

  /** The days lost over a period, from the project's daily reports (submitted or acknowledged). */
  async eotBasis(claims: TenantClaims, contractId: string, from: string, to: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.contractOf(db, contractId);
    await this.projects.access(db, claims, c.project_id);
    return this.basis(db, c.project_id, from, to);
  }

  private async basis(db: Db, projectId: string, from: string, to: string) {
    const hs = await db<(Hindrance & { description: string })[]>`
      SELECT to_char(r.report_date, 'YYYY-MM-DD') AS date, h.cause, h.hours::float8 AS hours, h.account, h.description
      FROM proj.daily_report r JOIN proj.dr_hindrance h ON h.report_id = r.id
      WHERE r.project_id = ${projectId} AND r.status <> 'draft' AND r.report_date BETWEEN ${from} AND ${to}
      ORDER BY r.report_date, h.position`;
    return { from, to, ...eotDays(hs), hindrances: hs };
  }

  async addEot(
    claims: TenantClaims,
    contractId: string,
    input: { from: string; to: string; daysClaimed: number | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.contractOf(db, contractId);
    await this.commercial(db, claims, c.project_id);
    if (input.to < input.from)
      throw new BadRequestException({ code: 'dates', message: 'The period ends after it starts.' });
    const b = await this.basis(db, c.project_id, input.from, input.to);
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM ctl.contract WHERE id = ${contractId} FOR UPDATE`;
      const [n] = await tx<
        { n: number }[]
      >`SELECT count(*)::int + 1 AS n FROM ctl.eot WHERE contract_id = ${contractId}`;
      await tx`
        INSERT INTO ctl.eot (contract_id, number, from_on, to_on, basis, days_claimed)
        VALUES (${contractId}, ${`EOT-${String(n!.n).padStart(2, '0')}`}, ${input.from}, ${input.to},
          ${tx.json({ days: b.days, byCause: b.byCause, dates: b.dates })}, ${input.daysClaimed ?? b.days})`;
      await audit(tx, claims.sub, 'contract.eot', 'contract', contractId, {
        days: input.daysClaimed ?? b.days,
      });
    });
    return this.register(claims, c.project_id);
  }

  /** Submitted, or decided: granted days (0 is a rejection) move the contract's completion date. */
  async decideEot(
    claims: TenantClaims,
    id: string,
    input:
      | { action: 'submit' }
      | { action: 'decide'; daysGranted: number; reference: string; date: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db<{ contract_id: string; status: string; days_claimed: number }[]>`
      SELECT contract_id, status, days_claimed FROM ctl.eot WHERE id = ${id}`;
    if (!e) throw new NotFoundException({ code: 'not_found', message: 'No such extension.' });
    const c = await this.contractOf(db, e.contract_id);
    await this.commercial(db, claims, c.project_id);
    await db.begin(async (tx) => {
      if (input.action === 'submit') {
        if (e.status !== 'draft')
          throw new ConflictException({ code: 'not_draft', message: 'Only a draft is submitted.' });
        await tx`UPDATE ctl.eot SET status = 'submitted' WHERE id = ${id}`;
        return;
      }
      if (e.status !== 'submitted')
        throw new ConflictException({
          code: 'not_submitted',
          message: 'Only a submitted extension is decided.',
        });
      if (input.daysGranted > e.days_claimed)
        throw new BadRequestException({
          code: 'more_than_claimed',
          message: 'More days granted than claimed.',
        });
      await tx`UPDATE ctl.eot SET status = ${input.daysGranted > 0 ? 'granted' : 'rejected'}, days_granted = ${input.daysGranted},
          decided_on = ${input.date}, reference = ${input.reference} WHERE id = ${id}`;
      if (input.daysGranted > 0)
        await tx`UPDATE ctl.contract SET completion_on = completion_on + ${input.daysGranted}::int, row_version = row_version + 1
          WHERE id = ${e.contract_id} AND completion_on IS NOT NULL`;
      await audit(tx, claims.sub, 'contract.eot_decided', 'contract', e.contract_id, {
        days: input.daysGranted,
      });
      if (input.daysGranted > 0) await this.dlpReminder(tx, e.contract_id);
    });
    return this.register(claims, c.project_id);
  }

  // --- claims ---

  async addClaim(
    claims: TenantClaims,
    contractId: string,
    input: { kind: string; title: string; amount: string; evidence: string; eotId: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const c = await this.contractOf(db, contractId);
    await this.commercial(db, claims, c.project_id);
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM ctl.contract WHERE id = ${contractId} FOR UPDATE`;
      const [n] = await tx<
        { n: number }[]
      >`SELECT count(*)::int + 1 AS n FROM ctl.claim WHERE contract_id = ${contractId}`;
      await tx`
        INSERT INTO ctl.claim (contract_id, number, kind, title, amount, evidence, eot_id)
        VALUES (${contractId}, ${`CL-${String(n!.n).padStart(2, '0')}`}, ${input.kind}, ${input.title}, ${input.amount},
          ${input.evidence}, ${input.eotId})`;
    });
    return this.register(claims, c.project_id);
  }

  async claimStatus(
    claims: TenantClaims,
    id: string,
    input: {
      status: 'submitted' | 'negotiation' | 'settled' | 'rejected';
      settledAmount: string | null;
      date: string | null;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [cl] = await db<{ contract_id: string; status: string; amount: string }[]>`
      SELECT contract_id, status, amount::text FROM ctl.claim WHERE id = ${id}`;
    if (!cl) throw new NotFoundException({ code: 'not_found', message: 'No such claim.' });
    const c = await this.contractOf(db, cl.contract_id);
    await this.commercial(db, claims, c.project_id);
    const next: Record<string, string[]> = {
      draft: ['submitted'],
      submitted: ['negotiation', 'settled', 'rejected'],
      negotiation: ['settled', 'rejected'],
    };
    if (!(next[cl.status] ?? []).includes(input.status))
      throw new ConflictException({
        code: 'bad_step',
        message: `A ${cl.status} claim cannot become ${input.status}.`,
      });
    if (input.status === 'settled' && (input.settledAmount === null || !input.date))
      throw new BadRequestException({
        code: 'settlement',
        message: 'A settlement has an amount and a date.',
      });
    if (input.status === 'settled' && Number(input.settledAmount) > Number(cl.amount))
      throw new BadRequestException({
        code: 'more_than_claimed',
        message: 'Settled for more than was claimed.',
      });
    await db`UPDATE ctl.claim SET status = ${input.status},
        settled_amount = ${input.status === 'settled' ? input.settledAmount : null},
        settled_on = ${input.status === 'settled' ? input.date : null}
      WHERE id = ${id}`;
    return this.register(claims, c.project_id);
  }

  // --- the register and calendar ---

  async register(
    claims: TenantClaims,
    projectId: string,
    today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const contracts = await db<
      {
        id: string;
        kind: string;
        party: string | null;
        reference: string;
        title: string;
        value: string;
        completionOn: string | null;
        dlpMonths: number;
        dlpEnds: string | null;
        status: string;
        rowVersion: number;
      }[]
    >`
      SELECT c.id, c.kind, p.name AS party, c.reference, c.title, c.value::text AS value,
        to_char(c.signed_on, 'YYYY-MM-DD') AS "signedOn", to_char(c.start_on, 'YYYY-MM-DD') AS "startOn",
        to_char(c.completion_on, 'YYYY-MM-DD') AS "completionOn", c.dlp_months AS "dlpMonths",
        to_char(c.completion_on + make_interval(months => c.dlp_months), 'YYYY-MM-DD') AS "dlpEnds",
        c.ld_pct_per_week::text AS "ldPctPerWeek", c.ld_cap_pct::text AS "ldCapPct", c.payment_terms AS "paymentTerms",
        c.notes, c.status, c.row_version AS "rowVersion"
      FROM ctl.contract c LEFT JOIN platform.party p ON p.id = c.party_id
      WHERE c.project_id = ${projectId} ORDER BY c.kind, c.reference`;
    const ids = contracts.map((c) => c.id);
    const securities = await db<
      {
        id: string;
        contractId: string;
        kind: string;
        number: string;
        amount: string;
        validUntil: string;
        status: string;
      }[]
    >`
      SELECT id, contract_id AS "contractId", kind, issuer, number, amount::text AS amount,
        to_char(valid_until, 'YYYY-MM-DD') AS "validUntil", to_char(claim_until, 'YYYY-MM-DD') AS "claimUntil", status,
        row_version AS "rowVersion"
      FROM ctl.security WHERE contract_id = ANY(${ids}::uuid[]) ORDER BY valid_until`;
    const obligations = await db<
      { id: string; contractId: string; title: string; dueOn: string; doneOn: string | null }[]
    >`
      SELECT id, contract_id AS "contractId", title, clause, to_char(due_on, 'YYYY-MM-DD') AS "dueOn",
        to_char(done_on, 'YYYY-MM-DD') AS "doneOn"
      FROM ctl.obligation WHERE contract_id = ANY(${ids}::uuid[]) ORDER BY due_on`;
    const notices = await db<
      {
        id: string;
        contractId: string;
        subject: string;
        replyBy: string | null;
        repliedOn: string | null;
      }[]
    >`
      SELECT id, contract_id AS "contractId", direction, subject, clause, to_char(dated, 'YYYY-MM-DD') AS dated, reference,
        to_char(reply_by, 'YYYY-MM-DD') AS "replyBy", to_char(replied_on, 'YYYY-MM-DD') AS "repliedOn"
      FROM ctl.notice WHERE contract_id = ANY(${ids}::uuid[]) ORDER BY dated DESC`;
    const eots = await db`
      SELECT id, contract_id AS "contractId", number, to_char(from_on, 'YYYY-MM-DD') AS "from", to_char(to_on, 'YYYY-MM-DD') AS "to",
        basis, days_claimed AS "daysClaimed", status, days_granted AS "daysGranted", to_char(decided_on, 'YYYY-MM-DD') AS "decidedOn",
        reference
      FROM ctl.eot WHERE contract_id = ANY(${ids}::uuid[]) ORDER BY number`;
    const claimsList = await db`
      SELECT id, contract_id AS "contractId", number, kind, title, amount::text AS amount, evidence, eot_id AS "eotId", status,
        settled_amount::text AS "settledAmount", to_char(settled_on, 'YYYY-MM-DD') AS "settledOn"
      FROM ctl.claim WHERE contract_id = ANY(${ids}::uuid[]) ORDER BY number`;
    const refOf = new Map(contracts.map((c) => [c.id, c.reference]));
    const calendar = [
      ...securities
        .filter((s) => s.status === 'held')
        .map((s) => ({
          date: s.validUntil,
          what: `${KIND_LABEL[s.kind]} ${s.number} expires`,
          kind: 'security',
          contract: refOf.get(s.contractId)!,
          amount: s.amount,
        })),
      ...obligations
        .filter((o) => !o.doneOn)
        .map((o) => ({
          date: o.dueOn,
          what: o.title,
          kind: 'obligation',
          contract: refOf.get(o.contractId)!,
          amount: null,
        })),
      ...notices
        .filter((n) => n.replyBy && !n.repliedOn)
        .map((n) => ({
          date: n.replyBy!,
          what: `Reply: ${n.subject}`,
          kind: 'notice',
          contract: refOf.get(n.contractId)!,
          amount: null,
        })),
      ...contracts.flatMap((c) => [
        ...(c.completionOn && c.status === 'active'
          ? [
              {
                date: c.completionOn,
                what: 'Completion due',
                kind: 'completion',
                contract: c.reference,
                amount: null,
              },
            ]
          : []),
        ...(c.dlpEnds && c.status !== 'closed'
          ? [
              {
                date: c.dlpEnds,
                what: 'Defects liability period ends',
                kind: 'dlp',
                contract: c.reference,
                amount: null,
              },
            ]
          : []),
      ]),
    ]
      .map((x) => ({ ...x, overdue: x.date < today }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      contracts,
      securities,
      obligations,
      notices,
      eots,
      claims: claimsList,
      calendar,
      mayKeep: await this.permissions.can(claims, 'billing.edit'),
      today,
    };
  }
}
