// The CRM (docs/wave6-plan.md step 1): contacts at parties, leads through their stages with value, probability and
// the month the work is expected, interactions with follow-ups (a notice, and a reminder on the day), conversion of a
// lead into a tender (Wave 1), whose outcome the lead then follows, and the pipeline.
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
import { cents, fromCents } from '../project/money.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { TenderService } from '../tender/tender.service.js';
import { audit } from '../tender/tender-records.js';
import {
  OPEN,
  mayMove,
  probabilityOf,
  stageFromTender,
  weighted,
  type Stage,
} from './crm-rules.js';

type Db = Sql | TransactionSql;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const VERTICAL: Record<string, string> = {
  buildings: 'buildings',
  interiors: 'interiors',
  joinery: 'joinery',
  mep: 'mep',
  real_estate: 'buildings',
  other: 'other',
};

interface LeadRow {
  id: string;
  number: string;
  title: string;
  partyId: string | null;
  party: string | null;
  organisation: string | null;
  contactId: string | null;
  contact: string | null;
  source: string;
  segment: string;
  location: string;
  value: string | null;
  ownProbability: number | null;
  expectedMonth: string | null;
  storedStage: Stage;
  reason: string;
  ownerId: string;
  owner: string;
  tenderId: string | null;
  tender: string | null;
  tenderStatus: string | null;
  notes: string;
  lastTouch: Date | null;
  createdAt: Date;
  rowVersion: number;
}

export interface LeadInput {
  title: string;
  partyId: string | null;
  organisation: string | null;
  contactId: string | null;
  source: string;
  segment: string;
  location: string;
  value: string | null;
  probability: number | null;
  expectedMonth: string | null;
  ownerId: string | null;
  notes: string;
}

@Injectable()
export class CrmService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly tenders: TenderService,
  ) {}

  private async editor(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'crm.edit')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'crm.edit',
        message: 'This needs the CRM permission.',
      });
  }

  // --- contacts ---

  async contacts(claims: TenantClaims, partyId: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT c.id, c.party_id AS "partyId", p.name AS party, c.name, c.role, c.phone, c.email, c.active
      FROM crm.contact c JOIN platform.party p ON p.id = c.party_id
      WHERE ${partyId ? db`c.party_id = ${partyId}` : db`true`} AND c.active
      ORDER BY p.name, c.name`;
  }

  async addContact(
    claims: TenantClaims,
    input: { partyId: string; name: string; role: string; phone: string; email: string },
  ) {
    await this.editor(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [p] =
      await db`SELECT 1 FROM platform.party WHERE id = ${input.partyId} AND deleted_at IS NULL`;
    if (!p) throw new NotFoundException({ code: 'no_such_party', message: 'No such party.' });
    const [c] = await db.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO crm.contact ${tx({
          party_id: input.partyId,
          name: input.name,
          role: input.role,
          phone: input.phone,
          email: input.email,
          created_by: claims.sub,
        })} RETURNING id`;
      await audit(tx, claims.sub, 'crm.contact', 'contact', rows[0]!.id, { name: input.name });
      return rows;
    });
    return { id: c!.id, contacts: await this.contacts(claims, input.partyId) };
  }

  // --- leads ---

  private rows(db: Db, where: ReturnType<Db>) {
    return db<LeadRow[]>`
      SELECT l.id, l.number, l.title, l.party_id AS "partyId", p.name AS party, l.organisation,
        l.contact_id AS "contactId", c.name AS contact, l.source, l.segment, l.location, l.value::text AS value,
        l.probability AS "ownProbability", to_char(l.expected_month, 'YYYY-MM') AS "expectedMonth",
        l.stage AS "storedStage", l.reason, l.owner_id AS "ownerId", u.display_name AS owner, l.tender_id AS "tenderId",
        t.number AS tender, t.status AS "tenderStatus", l.notes,
        (SELECT max(i.happened_at) FROM crm.interaction i WHERE i.lead_id = l.id) AS "lastTouch",
        l.created_at AS "createdAt", l.row_version AS "rowVersion"
      FROM crm.lead l LEFT JOIN platform.party p ON p.id = l.party_id
      LEFT JOIN crm.contact c ON c.id = l.contact_id JOIN platform."user" u ON u.id = l.owner_id
      LEFT JOIN tender.tender t ON t.id = l.tender_id
      WHERE ${where} ORDER BY l.created_at DESC`;
  }

  /** The stage in effect (a converted lead follows its tender), its probability and weighted value. */
  private shape(r: LeadRow) {
    const stage: Stage = r.tenderStatus ? stageFromTender(r.tenderStatus) : r.storedStage;
    const probability = probabilityOf(stage, r.ownProbability);
    const goingCold =
      OPEN.includes(stage) &&
      stage !== 'tender' &&
      Date.now() - (r.lastTouch ?? r.createdAt).getTime() > 30 * 86_400_000;
    const { storedStage: _, ...rest } = r;
    return {
      ...rest,
      stage,
      probability,
      weighted: r.value ? fromCents(weighted(cents(r.value), probability)) : '0.00',
      goingCold,
    };
  }

  async list(claims: TenantClaims, filter: { stage: string | null; ownerId: string | null }) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = (
      await this.rows(db, db`${filter.ownerId ? db`l.owner_id = ${filter.ownerId}` : db`true`}`)
    ).map((r) => this.shape(r));
    return filter.stage ? rows.filter((r) => r.stage === filter.stage) : rows;
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await this.rows(db, db`l.id = ${id}`);
    if (!r) throw new NotFoundException({ code: 'not_found', message: 'No such lead.' });
    const interactions = await db`
      SELECT i.id, i.kind, i.happened_at AS "happenedAt", i.summary, c.name AS contact,
        to_char(i.follow_up_on, 'YYYY-MM-DD') AS "followUpOn", i.follow_up AS "followUp",
        i.follow_up_done_at AS "followUpDoneAt", u.display_name AS "by",
        i.follow_up_on IS NOT NULL AND i.follow_up_done_at IS NULL AND i.follow_up_on < ${today()}::date AS overdue
      FROM crm.interaction i JOIN platform."user" u ON u.id = i.created_by
      LEFT JOIN crm.contact c ON c.id = i.contact_id
      WHERE i.lead_id = ${id} ORDER BY i.happened_at DESC, i.created_at DESC`;
    const lead = this.shape(r);
    return {
      ...lead,
      interactions,
      mayEdit:
        (await this.permissions.can(claims, 'crm.edit')) &&
        (r.ownerId === claims.sub || claims.role !== 'worker'),
    };
  }

  private async checkRefs(db: Db, input: Partial<LeadInput>) {
    if (input.partyId) {
      const [p] =
        await db`SELECT 1 FROM platform.party WHERE id = ${input.partyId} AND deleted_at IS NULL`;
      if (!p) throw new NotFoundException({ code: 'no_such_party', message: 'No such party.' });
    }
    if (input.contactId) {
      const [c] = await db<{ party_id: string }[]>`
        SELECT party_id FROM crm.contact WHERE id = ${input.contactId}`;
      if (!c || (input.partyId && c.party_id !== input.partyId))
        throw new BadRequestException({
          code: 'contact_not_of_party',
          message: "The contact must be one of the client's people.",
        });
    }
    if (input.ownerId) {
      const [u] =
        await db`SELECT 1 FROM platform."user" WHERE id = ${input.ownerId} AND status = 'active'`;
      if (!u) throw new BadRequestException({ code: 'no_such_owner', message: 'No such person.' });
    }
  }

  private cols(input: LeadInput) {
    return {
      title: input.title,
      party_id: input.partyId,
      organisation: input.partyId ? null : input.organisation,
      contact_id: input.contactId,
      source: input.source,
      segment: input.segment,
      location: input.location,
      value: input.value,
      probability: input.probability,
      expected_month: input.expectedMonth ? `${input.expectedMonth}-01` : null,
      notes: input.notes,
    };
  }

  async create(claims: TenantClaims, input: LeadInput) {
    await this.editor(claims);
    if (!input.partyId && !input.organisation)
      throw new BadRequestException({
        code: 'who',
        message: 'Name the client: a party, or a new organisation.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await this.checkRefs(db, input);
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('crm.lead'))`;
      const [n] = await tx<{ n: number }[]>`SELECT count(*)::int + 1 AS n FROM crm.lead`;
      const number = `LD-${String(n!.n).padStart(3, '0')}`;
      const [l] = await tx<{ id: string }[]>`
        INSERT INTO crm.lead ${tx({
          ...this.cols(input),
          number,
          owner_id: input.ownerId ?? claims.sub,
          created_by: claims.sub,
        })} RETURNING id`;
      await audit(tx, claims.sub, 'crm.lead', 'lead', l!.id, { number });
      return l!.id;
    });
    return this.get(claims, id);
  }

  /** The lead's own row, for writing: its owner, or a manager or admin, with the CRM permission. */
  private async writable(db: Db, claims: TenantClaims, id: string) {
    await this.editor(claims);
    const [l] = await db<
      { owner_id: string; stage: Stage; tender_id: string | null; row_version: number }[]
    >`SELECT owner_id, stage, tender_id, row_version FROM crm.lead WHERE id = ${id}`;
    if (!l) throw new NotFoundException({ code: 'not_found', message: 'No such lead.' });
    if (claims.role === 'worker' && l.owner_id !== claims.sub)
      throw new ForbiddenException({
        code: 'not_yours',
        message: 'Only the lead’s owner or a manager changes it.',
      });
    return l;
  }

  async update(claims: TenantClaims, id: string, rowVersion: number, input: LeadInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const l = await this.writable(db, claims, id);
    await this.checkRefs(db, input);
    await db.begin(async (tx) => {
      const r = await tx`
        UPDATE crm.lead SET ${tx(this.cols(input))}, owner_id = ${input.ownerId ?? l.owner_id},
          row_version = row_version + 1
        WHERE id = ${id} AND row_version = ${rowVersion}`;
      if (!r.count)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone changed this lead; reload it.',
        });
      await audit(tx, claims.sub, 'crm.lead.update', 'lead', id, {});
    });
    return this.get(claims, id);
  }

  async move(claims: TenantClaims, id: string, to: Stage, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const l = await this.writable(db, claims, id);
    if (l.tender_id)
      throw new ConflictException({
        code: 'converted',
        message: 'This lead follows its tender now.',
      });
    if (!mayMove(l.stage, to))
      throw new ConflictException({
        code: 'bad_move',
        message: `A lead cannot go from ${l.stage} to ${to} by hand.`,
      });
    if ((to === 'lost' || to === 'dropped') && reason.trim().length < 3)
      throw new BadRequestException({ code: 'reason_needed', message: 'Say why.' });
    await db.begin(async (tx) => {
      await tx`
        UPDATE crm.lead SET stage = ${to}, reason = ${to === 'lost' || to === 'dropped' ? reason.trim() : ''},
          closed_at = CASE WHEN ${to} IN ('won', 'lost', 'dropped') THEN now() ELSE NULL END,
          row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'crm.lead.move', 'lead', id, { from: l.stage, to, reason });
    });
    return this.get(claims, id);
  }

  /** The lead becomes a tender: its client (made a party if new), title, value, location, vertical and owner. */
  async convert(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const l = await this.writable(db, claims, id);
    if (!(await this.permissions.can(claims, 'tender.edit')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'tender.edit',
        message: 'Making a tender needs the tenders permission.',
      });
    if (l.tender_id)
      throw new ConflictException({ code: 'converted', message: 'Already a tender.' });
    if (!['qualified', 'proposal', 'negotiation'].includes(l.stage))
      throw new ConflictException({
        code: 'not_qualified',
        message: 'Qualify the lead before making it a tender.',
      });
    const [r] = await this.rows(db, db`l.id = ${id}`);
    let partyId = r!.partyId;
    if (!partyId) {
      // An organisation named on the lead becomes a client party; one already known by that name is reused.
      const [known] = await db<{ id: string; is_client: boolean }[]>`
        SELECT id, is_client FROM platform.party WHERE lower(name) = lower(${r!.organisation!}) AND deleted_at IS NULL`;
      if (known) {
        partyId = known.id;
        if (!known.is_client)
          await db`UPDATE platform.party SET is_client = true, row_version = row_version + 1 WHERE id = ${known.id}`;
      } else
        partyId = (
          (await this.tenders.createParty(claims, {
            name: r!.organisation!,
            isClient: true,
            isVendor: false,
            isSubcontractor: false,
            isCompetitor: false,
            gstin: null,
            pan: null,
            contactName: r!.contact,
            email: null,
            phone: null,
            address: null,
            notes: `From lead ${r!.number}`,
          })) as { id: string }
        ).id;
    }
    const tender = (await this.tenders.create(claims, {
      title: r!.title,
      clientId: partyId,
      clientRef: null,
      source:
        r!.source === 'repeat_client'
          ? 'repeat_client'
          : r!.source === 'referral'
            ? 'referral'
            : 'other',
      portalUrl: null,
      vertical: VERTICAL[r!.segment] ?? 'other',
      location: r!.location || null,
      estimatedValue: r!.value,
      emdAmount: null,
      tenderFee: null,
      publishedOn: null,
      prebidAt: null,
      submissionDueAt: null,
      openingAt: null,
      queriesDueAt: null,
      bidValidityDays: null,
      ownerId: r!.ownerId,
      description: `From lead ${r!.number}${r!.notes ? `\n\n${r!.notes}` : ''}`,
    })) as unknown as { id: string; number: string };
    await db.begin(async (tx) => {
      await tx`
        UPDATE crm.lead SET stage = 'tender', tender_id = ${tender.id}, party_id = ${partyId}, organisation = NULL,
          row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'crm.lead.convert', 'lead', id, { tender: tender.number });
    });
    return this.get(claims, id);
  }

  // --- interactions and follow-ups ---

  async interact(
    claims: TenantClaims,
    id: string,
    input: {
      kind: string;
      happenedAt: Date;
      summary: string;
      contactId: string | null;
      followUpOn: string | null;
      followUp: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.writable(db, claims, id);
    if (input.happenedAt.getTime() > Date.now() + 5 * 60_000)
      throw new BadRequestException({
        code: 'in_future',
        message: 'Record what has happened; plan the next step as a follow-up.',
      });
    if (input.followUpOn && input.followUpOn < today())
      throw new BadRequestException({
        code: 'follow_up_past',
        message: 'A follow-up is for today or later.',
      });
    const [lead] = await db<{ number: string; title: string; owner_id: string }[]>`
      SELECT number, title, owner_id FROM crm.lead WHERE id = ${id}`;
    await db.begin(async (tx) => {
      const [i] = await tx<{ id: string }[]>`
        INSERT INTO crm.interaction ${tx({
          lead_id: id,
          kind: input.kind,
          happened_at: input.happenedAt,
          summary: input.summary,
          contact_id: input.contactId,
          follow_up_on: input.followUpOn,
          follow_up: input.followUpOn ? input.followUp : '',
          created_by: claims.sub,
        })} RETURNING id`;
      if (input.followUpOn) {
        const title = `${lead!.number} ${lead!.title}: ${input.followUp || 'follow up'}`;
        const link = `/crm?lead=${id}`;
        const source = `follow-up:${i!.id}`;
        await tx`INSERT INTO platform.notification (user_id, kind, title, link, source)
          VALUES (${lead!.owner_id}, 'follow_up', ${`${title} (on ${input.followUpOn})`}, ${link}, ${source})`;
        const at = new Date(`${input.followUpOn}T09:00:00+05:30`);
        if (at > new Date())
          await tx`INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
            VALUES (${lead!.owner_id}, 'follow_up_due', ${`${title}, today`}, ${link}, ${at}, ${source})`;
      }
      await audit(tx, claims.sub, 'crm.interaction', 'lead', id, { kind: input.kind });
    });
    return this.get(claims, id);
  }

  async followUpDone(claims: TenantClaims, interactionId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<{ lead_id: string }[]>`
      SELECT lead_id FROM crm.interaction WHERE id = ${interactionId} AND follow_up_on IS NOT NULL`;
    if (!i) throw new NotFoundException({ code: 'not_found', message: 'No such follow-up.' });
    await this.writable(db, claims, i.lead_id);
    await db.begin(async (tx) => {
      await tx`UPDATE crm.interaction SET follow_up_done_at = coalesce(follow_up_done_at, now()) WHERE id = ${interactionId}`;
      await tx`DELETE FROM platform.notification WHERE source = ${`follow-up:${interactionId}`} AND read_at IS NULL`;
    });
    return this.get(claims, i.lead_id);
  }

  /** Follow-ups due by today and not done, mine (or everyone's for managers with `all`). */
  async followUps(claims: TenantClaims, all: boolean) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT i.id, l.id AS "leadId", l.number, l.title, to_char(i.follow_up_on, 'YYYY-MM-DD') AS "on", i.follow_up AS what,
        u.display_name AS owner, i.follow_up_on < ${today()}::date AS overdue
      FROM crm.interaction i JOIN crm.lead l ON l.id = i.lead_id JOIN platform."user" u ON u.id = l.owner_id
      WHERE i.follow_up_on IS NOT NULL AND i.follow_up_done_at IS NULL AND i.follow_up_on <= ${addDays(today(), 7)}::date
        AND ${all && claims.role !== 'worker' ? db`true` : db`l.owner_id = ${claims.sub}`}
      ORDER BY i.follow_up_on, l.number`;
  }

  // --- the pipeline ---

  async pipeline(claims: TenantClaims) {
    const leads = await this.list(claims, { stage: null, ownerId: null });
    type L = (typeof leads)[number];
    const sum = (xs: L[], f: (x: L) => string) =>
      fromCents(xs.reduce((a, l) => a + cents(f(l)), 0n));
    const stages: Stage[] = [
      'new',
      'qualified',
      'proposal',
      'negotiation',
      'tender',
      'won',
      'lost',
      'dropped',
    ];
    const byStage = stages.map((stage) => {
      const xs = leads.filter((l) => l.stage === stage);
      return {
        stage,
        count: xs.length,
        value: sum(xs, (l) => l.value ?? '0'),
        weighted: sum(xs, (l) => l.weighted),
      };
    });
    const open = leads.filter((l) => OPEN.includes(l.stage));
    const month0 = today().slice(0, 7);
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(
        Date.UTC(Number(month0.slice(0, 4)), Number(month0.slice(5, 7)) - 1 + i, 1),
      );
      return d.toISOString().slice(0, 7);
    });
    const byMonth = months.map((month) => {
      const xs = open.filter((l) => l.expectedMonth === month);
      return { month, count: xs.length, weighted: sum(xs, (l) => l.weighted) };
    });
    const sources = [...new Set(leads.map((l) => l.source))].sort();
    const bySource = sources.map((source) => {
      const xs = leads.filter((l) => l.source === source);
      const closed = xs.filter(
        (l) => l.stage === 'won' || l.stage === 'lost' || l.stage === 'dropped',
      );
      const won = xs.filter((l) => l.stage === 'won').length;
      return {
        source,
        leads: xs.length,
        won,
        closed: closed.length,
        winRate: closed.length ? Math.round((won / closed.length) * 100) : null,
      };
    });
    return {
      totals: {
        open: open.length,
        value: sum(open, (l) => l.value ?? '0'),
        weighted: sum(open, (l) => l.weighted),
      },
      byStage,
      byMonth,
      bySource,
      goingCold: leads
        .filter((l) => l.goingCold)
        .map((l) => ({
          id: l.id,
          number: l.number,
          title: l.title,
          owner: l.owner,
          lastTouch: l.lastTouch,
        })),
      followUps: await this.followUps(claims, true),
    };
  }
}
