// Real estate sales and RERA (docs/wave6-plan.md step 2), Maharashtra first. A project's sales setup; towers and
// units; buyers booking units (each booking its own party ledger under debtors); payment plans whose stages fall due on
// booking, on the registered agreement or on a construction milestone; demands with GST posted to the ledger (held
// back while RERA §13's 10% before the agreement would be passed); receipts posted and allocated oldest first, each
// adding its share to what the designated account must hold; delay interest; deposits and certified withdrawals.
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { LineInput } from '../accounts/ledger.service.js';
import { LedgerService } from '../accounts/ledger.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import {
  agreementValue,
  allocate,
  daysLate,
  delayInterest,
  demandOf,
  hundredths,
  reraShare,
  rupees,
  withdrawable,
  withinTenPercent,
} from './re-rules.js';

type Db = Sql | TransactionSql;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const p = (v: string | number | null | undefined) => hundredths(String(v ?? '0'));

interface Setup {
  project_id: string;
  rera_number: string;
  registered_on: string | null;
  completion_on: string | null;
  collection_account_id: string | null;
  designated_account_id: string | null;
  share_pct: string;
  interest_pct: string;
  pay_days: number;
}

export interface UnitInput {
  floor: number;
  number: string;
  kind: 'flat' | 'shop' | 'office';
  carpetSqm: string;
  ratePerSqm: string;
  parking: string;
  charges: string;
  gstPct: string;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly ledger: LedgerService,
  ) {}

  private async may(claims: TenantClaims, perm: 'sales.edit' | 'accounts.post') {
    if (!(await this.permissions.can(claims, perm)))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: perm,
        message:
          perm === 'sales.edit'
            ? 'This needs the sales permission.'
            : 'Posting to the books needs the permission to post.',
      });
  }

  private async setupRow(db: Db, projectId: string): Promise<Setup> {
    const [s] = await db<Setup[]>`
      SELECT project_id, rera_number, to_char(registered_on, 'YYYY-MM-DD') AS registered_on,
        to_char(completion_on, 'YYYY-MM-DD') AS completion_on, collection_account_id, designated_account_id,
        share_pct::text, interest_pct::text, pay_days
      FROM re.setup WHERE project_id = ${projectId}`;
    return (
      s ?? {
        project_id: projectId,
        rera_number: '',
        registered_on: null,
        completion_on: null,
        collection_account_id: null,
        designated_account_id: null,
        share_pct: '70',
        interest_pct: '10.75',
        pay_days: 15,
      }
    );
  }

  private async entityOf(db: Db, projectId: string) {
    const [x] = await db<{ entity_id: string; number: string; name: string }[]>`
      SELECT entity_id, number, name FROM proj.project WHERE id = ${projectId}`;
    if (!x) throw new NotFoundException({ code: 'not_found', message: 'No such project.' });
    return x;
  }

  // --- setup, towers, units, plan ---

  async overview(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const setup = await this.setupRow(db, projectId);
    const towers = await db`
      SELECT id, name, floors FROM re.tower WHERE project_id = ${projectId} ORDER BY name`;
    const units = await db`
      SELECT u.id, u.tower_id AS "towerId", u.floor, u.number, u.kind, u.carpet_sqm::text AS "carpetSqm",
        u.rate_per_sqm::text AS "ratePerSqm", u.parking::text, u.charges::text, u.gst_pct::text AS "gstPct", u.status,
        b.number AS booking, y.name AS buyer, u.row_version AS "rowVersion"
      FROM re.unit u JOIN re.tower t ON t.id = u.tower_id
      LEFT JOIN re.booking b ON b.unit_id = u.id AND b.status <> 'cancelled' LEFT JOIN re.buyer y ON y.id = b.buyer_id
      WHERE t.project_id = ${projectId} ORDER BY t.name, u.floor DESC, u.number`;
    const plan = await db`
      SELECT s.id, s.position, s.name, s.pct::text, s.trigger, s.tower_id AS "towerId", t.name AS tower,
        to_char(s.reached_on, 'YYYY-MM-DD') AS "reachedOn"
      FROM re.plan_stage s LEFT JOIN re.tower t ON t.id = s.tower_id
      WHERE s.project_id = ${projectId} ORDER BY s.position`;
    return {
      setup: {
        reraNumber: setup.rera_number,
        registeredOn: setup.registered_on,
        completionOn: setup.completion_on,
        collectionAccountId: setup.collection_account_id,
        designatedAccountId: setup.designated_account_id,
        sharePct: setup.share_pct,
        interestPct: setup.interest_pct,
        payDays: setup.pay_days,
      },
      towers,
      units: units.map((u) => ({
        ...u,
        value: rupees(
          agreementValue({
            carpetSqm: u.carpetSqm as string,
            ratePerSqm: u.ratePerSqm as string,
            parking: u.parking as string,
            charges: u.charges as string,
          }),
        ),
      })),
      plan,
      planTotal: rupees(plan.reduce((a, s) => a + p(s.pct as string), 0n)),
    };
  }

  async saveSetup(
    claims: TenantClaims,
    projectId: string,
    input: {
      reraNumber: string;
      registeredOn: string | null;
      completionOn: string | null;
      collectionAccountId: string | null;
      designatedAccountId: string | null;
      sharePct: string;
      interestPct: string;
      payDays: number;
    },
  ) {
    await this.may(claims, 'sales.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    for (const a of [input.collectionAccountId, input.designatedAccountId])
      if (a) {
        const [x] = await db<{ kind: string }[]>`SELECT kind FROM acc.account WHERE id = ${a}`;
        if (x?.kind !== 'bank')
          throw new BadRequestException({
            code: 'not_bank',
            message: 'The collection and designated accounts are bank ledgers.',
          });
      }
    await db.begin(async (tx) => {
      const cols = {
        rera_number: input.reraNumber,
        registered_on: input.registeredOn,
        completion_on: input.completionOn,
        collection_account_id: input.collectionAccountId,
        designated_account_id: input.designatedAccountId,
        share_pct: input.sharePct,
        interest_pct: input.interestPct,
        pay_days: input.payDays,
        updated_by: claims.sub,
      };
      await tx`
        INSERT INTO re.setup ${tx({ project_id: projectId, ...cols })}
        ON CONFLICT (project_id) DO UPDATE SET ${tx(cols)}, updated_at = now()`;
      await audit(tx, claims.sub, 're.setup', 'project', projectId, input);
    });
    return this.overview(claims, projectId);
  }

  async addTower(claims: TenantClaims, projectId: string, input: { name: string; floors: number }) {
    await this.may(claims, 'sales.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    await db`INSERT INTO re.tower (project_id, name, floors) VALUES (${projectId}, ${input.name}, ${input.floors})`.catch(
      (err: { code?: string }) => {
        if (err.code === '23505')
          throw new ConflictException({
            code: 'tower_exists',
            message: 'A tower by that name exists.',
          });
        throw err;
      },
    );
    return this.overview(claims, projectId);
  }

  /** Units added to a tower; one already numbered there is refused. */
  async addUnits(claims: TenantClaims, towerId: string, units: UnitInput[]) {
    await this.may(claims, 'sales.edit');
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db<{ project_id: string; floors: number }[]>`
      SELECT project_id, floors FROM re.tower WHERE id = ${towerId}`;
    if (!t) throw new NotFoundException({ code: 'not_found', message: 'No such tower.' });
    await this.projects.access(db, claims, t.project_id);
    if (units.some((u) => u.floor > t.floors))
      throw new BadRequestException({
        code: 'floor',
        message: `The tower has ${t.floors} floors.`,
      });
    await db.begin(async (tx) => {
      for (const u of units)
        await tx`
          INSERT INTO re.unit ${tx({
            tower_id: towerId,
            floor: u.floor,
            number: u.number,
            kind: u.kind,
            carpet_sqm: u.carpetSqm,
            rate_per_sqm: u.ratePerSqm,
            parking: u.parking,
            charges: u.charges,
            gst_pct: u.gstPct,
          })}`.catch((err: { code?: string }) => {
          if (err.code === '23505')
            throw new ConflictException({
              code: 'unit_exists',
              message: `Unit ${u.number} exists.`,
            });
          throw err;
        });
      await audit(tx, claims.sub, 're.units', 'tower', towerId, { count: units.length });
    });
    return this.overview(claims, t.project_id);
  }

  /** The payment plan, replaced whole while nothing has been demanded from it. Stages total 100%. */
  async savePlan(
    claims: TenantClaims,
    projectId: string,
    stages: {
      name: string;
      pct: string;
      trigger: 'booking' | 'agreement' | 'milestone';
      towerId: string | null;
    }[],
  ) {
    await this.may(claims, 'sales.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    if (stages.reduce((a, s) => a + p(s.pct), 0n) !== 10_000n)
      throw new BadRequestException({
        code: 'not_100',
        message: 'The stages must add up to 100%.',
      });
    const [used] = await db`
      SELECT 1 FROM re.demand d JOIN re.plan_stage s ON s.id = d.stage_id WHERE s.project_id = ${projectId} LIMIT 1`;
    if (used)
      throw new ConflictException({
        code: 'plan_in_use',
        message: 'Demands have been raised on this plan; it can no longer be replaced.',
      });
    await db.begin(async (tx) => {
      await tx`DELETE FROM re.plan_stage WHERE project_id = ${projectId}`;
      for (const [i, s] of stages.entries())
        await tx`
          INSERT INTO re.plan_stage (project_id, position, name, pct, trigger, tower_id)
          VALUES (${projectId}, ${i + 1}, ${s.name}, ${s.pct}, ${s.trigger}, ${s.trigger === 'milestone' ? s.towerId : null})`;
      await audit(tx, claims.sub, 're.plan', 'project', projectId, { stages: stages.length });
    });
    return this.overview(claims, projectId);
  }

  // --- bookings ---

  async book(
    claims: TenantClaims,
    unitId: string,
    input: {
      buyer: {
        name: string;
        coApplicant: string;
        phone: string;
        email: string;
        pan: string | null;
        address: string;
      };
      bookedOn: string;
    },
  ) {
    await this.may(claims, 'sales.edit');
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const [u] = await db<
      {
        project_id: string;
        tower: string;
        number: string;
        status: string;
        carpet_sqm: string;
        rate_per_sqm: string;
        parking: string;
        charges: string;
      }[]
    >`
      SELECT t.project_id, t.name AS tower, u.number, u.status, u.carpet_sqm::text, u.rate_per_sqm::text,
        u.parking::text, u.charges::text
      FROM re.unit u JOIN re.tower t ON t.id = u.tower_id WHERE u.id = ${unitId}`;
    if (!u) throw new NotFoundException({ code: 'not_found', message: 'No such unit.' });
    await this.projects.access(db, claims, u.project_id);
    if (u.status !== 'available' && u.status !== 'held')
      throw new ConflictException({ code: 'not_available', message: 'This unit is already sold.' });
    if (input.bookedOn > today())
      throw new BadRequestException({ code: 'in_future', message: 'Not a date in the future.' });
    const value = agreementValue({
      carpetSqm: u.carpet_sqm,
      ratePerSqm: u.rate_per_sqm,
      parking: u.parking,
      charges: u.charges,
    });
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('re.booking'))`;
      const [n] = await tx<{ n: number }[]>`SELECT count(*)::int + 1 AS n FROM re.booking`;
      const number = `BK-${String(n!.n).padStart(3, '0')}`;
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO re.buyer ${tx({
          name: input.buyer.name,
          co_applicant: input.buyer.coApplicant,
          phone: input.buyer.phone,
          email: input.buyer.email,
          pan: input.buyer.pan,
          address: input.buyer.address,
        })} RETURNING id`;
      const [party] = await tx<{ id: string }[]>`
        INSERT INTO platform.party (name, is_buyer, contact_name, phone, email, pan, address, notes, created_by, updated_by)
        VALUES (${`${u.tower}-${u.number} ${input.buyer.name} (${number})`.slice(0, 200)}, true, ${input.buyer.name},
          ${input.buyer.phone || null}, ${input.buyer.email || null}, ${input.buyer.pan}, ${input.buyer.address || null},
          ${`Buyer of ${u.tower}-${u.number}`}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      const [bk] = await tx<{ id: string }[]>`
        INSERT INTO re.booking (number, unit_id, buyer_id, party_id, value, booked_on, created_by)
        VALUES (${number}, ${unitId}, ${b!.id}, ${party!.id}, ${rupees(value)}, ${input.bookedOn}, ${claims.sub})
        RETURNING id`;
      await tx`UPDATE re.unit SET status = 'booked', row_version = row_version + 1 WHERE id = ${unitId}`;
      await audit(tx, claims.sub, 're.book', 'booking', bk!.id, {
        number,
        unit: `${u.tower}-${u.number}`,
      });
      // The booking stage, and any milestone the tower has already reached, fall due now.
      await this.raiseDue(tx, claims, bk!.id, input.bookedOn);
      return bk!.id;
    });
    return this.booking(claims, id);
  }

  async registerAgreement(
    claims: TenantClaims,
    bookingId: string,
    input: { on: string; number: string },
  ) {
    await this.may(claims, 'sales.edit');
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.bookingRow(db, bookingId);
    await this.projects.access(db, claims, b.project_id);
    if (b.status !== 'booked')
      throw new ConflictException({
        code: 'not_booked',
        message: 'Only a live booking is registered.',
      });
    await db.begin(async (tx) => {
      await tx`
        UPDATE re.booking SET status = 'agreement', agreement_on = ${input.on}, agreement_number = ${input.number}
        WHERE id = ${bookingId}`;
      await tx`UPDATE re.unit SET status = 'agreement', row_version = row_version + 1 WHERE id = ${b.unit_id}`;
      await audit(tx, claims.sub, 're.agreement', 'booking', bookingId, input);
      await this.raiseDue(tx, claims, bookingId, input.on);
    });
    return this.booking(claims, bookingId);
  }

  async cancel(claims: TenantClaims, bookingId: string, on: string) {
    await this.may(claims, 'sales.edit');
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.bookingRow(db, bookingId);
    await this.projects.access(db, claims, b.project_id);
    if (b.status === 'cancelled')
      throw new ConflictException({ code: 'cancelled', message: 'Already cancelled.' });
    await db.begin(async (tx) => {
      await tx`UPDATE re.booking SET status = 'cancelled', cancelled_on = ${on} WHERE id = ${bookingId}`;
      await tx`UPDATE re.unit SET status = 'available', row_version = row_version + 1 WHERE id = ${b.unit_id}`;
      await audit(tx, claims.sub, 're.cancel', 'booking', bookingId, { on });
    });
    return this.booking(claims, bookingId);
  }

  private async bookingRow(db: Db, id: string) {
    const [b] = await db<
      {
        id: string;
        number: string;
        unit_id: string;
        party_id: string;
        value: string;
        status: string;
        agreement_on: string | null;
        project_id: string;
        tower_id: string;
        gst_pct: string;
        unit: string;
      }[]
    >`
      SELECT b.id, b.number, b.unit_id, b.party_id, b.value::text, b.status, to_char(b.agreement_on, 'YYYY-MM-DD') AS agreement_on,
        t.project_id, u.tower_id, u.gst_pct::text, t.name || '-' || u.number AS unit
      FROM re.booking b JOIN re.unit u ON u.id = b.unit_id JOIN re.tower t ON t.id = u.tower_id WHERE b.id = ${id}`;
    if (!b) throw new NotFoundException({ code: 'not_found', message: 'No such booking.' });
    return b;
  }

  /**
   * Raises every stage of the plan now due on a booking: booking always, the agreement once registered, a milestone
   * once its tower (or every tower) has reached it. Before the agreement, RERA §13 holds back what would pass 10%.
   */
  private async raiseDue(tx: TransactionSql, claims: TenantClaims, bookingId: string, on: string) {
    const b = await this.bookingRow(tx, bookingId);
    if (b.status === 'cancelled') return 0;
    const setup = await this.setupRow(tx, b.project_id);
    const stages = await tx<
      { id: string; name: string; pct: string; trigger: string; reached_on: string | null }[]
    >`
      SELECT s.id, s.name, s.pct::text, s.trigger, to_char(s.reached_on, 'YYYY-MM-DD') AS reached_on
      FROM re.plan_stage s
      WHERE s.project_id = ${b.project_id} AND (s.tower_id IS NULL OR s.tower_id = ${b.tower_id})
        AND NOT EXISTS (SELECT 1 FROM re.demand d WHERE d.booking_id = ${bookingId} AND d.stage_id = s.id)
      ORDER BY s.position`;
    const [sofar] = await tx<{ base: string }[]>`
      SELECT coalesce(sum(base), 0)::text AS base FROM re.demand WHERE booking_id = ${bookingId} AND kind = 'stage'`;
    let demanded = p(sofar!.base);
    const value = p(b.value);
    let raised = 0;
    for (const s of stages) {
      const due =
        s.trigger === 'booking' ||
        (s.trigger === 'agreement' && b.status === 'agreement') ||
        (s.trigger === 'milestone' && s.reached_on !== null);
      if (!due) continue;
      const d = demandOf(value, s.pct, b.gst_pct);
      if (b.status !== 'agreement' && !withinTenPercent(value, demanded, d.base)) continue;
      await this.post(tx, claims, b, setup, {
        stageId: s.id,
        kind: 'stage',
        raisedOn: on,
        base: d.base,
        cgst: d.cgst,
        sgst: d.sgst,
        what: s.name,
      });
      demanded += d.base;
      raised++;
    }
    return raised;
  }

  /** A demand posted: buyer Dr; advances from buyers (or interest income) Cr; output CGST and SGST Cr. */
  private async post(
    tx: TransactionSql,
    claims: TenantClaims,
    b: Awaited<ReturnType<SalesService['bookingRow']>>,
    setup: Setup,
    d: {
      stageId: string | null;
      kind: 'stage' | 'interest';
      raisedOn: string;
      base: bigint;
      cgst: bigint;
      sgst: bigint;
      what: string;
    },
  ) {
    const { entity_id } = await this.entityOf(tx, b.project_id);
    await tx`SELECT pg_advisory_xact_lock(hashtext('re.demand'))`;
    const [n] = await tx<{ n: number }[]>`SELECT count(*)::int + 1 AS n FROM re.demand`;
    const number = `DM-${String(n!.n).padStart(3, '0')}`;
    const id = randomUUID();
    const line = (accountId: string, debit: bigint, credit: bigint, note = ''): LineInput => ({
      accountId,
      partyId: null,
      debit: rupees(debit),
      credit: rupees(credit),
      projectId: b.project_id,
      siteId: null,
      costCodeId: null,
      note,
    });
    const credit = await this.ledger.roleAccount(
      tx,
      entity_id,
      d.kind === 'interest' ? 'interest_income' : 'buyer_advances',
    );
    const lines: LineInput[] = [
      line(await this.ledger.partyLedger(tx, b.party_id), d.base + d.cgst + d.sgst, 0n),
      line(credit, 0n, d.base, d.what),
      ...(d.cgst > 0n
        ? [line(await this.ledger.roleAccount(tx, entity_id, 'output_cgst'), 0n, d.cgst)]
        : []),
      ...(d.sgst > 0n
        ? [line(await this.ledger.roleAccount(tx, entity_id, 'output_sgst'), 0n, d.sgst)]
        : []),
    ];
    const v = await this.ledger.post(
      tx,
      claims,
      {
        entityId: entity_id,
        type: 'sales',
        date: d.raisedOn,
        narration: `${number} ${b.unit} ${d.what}`,
        reference: b.number,
        lines,
      },
      { kind: 're_demand', id },
    );
    await tx`
      INSERT INTO re.demand (id, number, booking_id, stage_id, kind, raised_on, due_on, base, cgst, sgst, voucher_id, created_by)
      VALUES (${id}, ${number}, ${b.id}, ${d.stageId}, ${d.kind}, ${d.raisedOn}, ${addDays(d.raisedOn, setup.pay_days)},
        ${rupees(d.base)}, ${rupees(d.cgst)}, ${rupees(d.sgst)}, ${v.id}, ${claims.sub})`;
    await audit(tx, claims.sub, 're.demand', 'booking', b.id, { number, base: rupees(d.base) });
  }

  /** A construction milestone reached: every live booking on its tower (or all) gets its demand. */
  async reachMilestone(claims: TenantClaims, stageId: string, on: string) {
    await this.may(claims, 'sales.edit');
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<
      { project_id: string; trigger: string; reached_on: Date | null; tower_id: string | null }[]
    >`
      SELECT project_id, trigger, reached_on, tower_id FROM re.plan_stage WHERE id = ${stageId}`;
    if (!s) throw new NotFoundException({ code: 'not_found', message: 'No such stage.' });
    await this.projects.access(db, claims, s.project_id);
    if (s.trigger !== 'milestone')
      throw new BadRequestException({
        code: 'not_milestone',
        message: 'Only a milestone is reached on site.',
      });
    if (s.reached_on) throw new ConflictException({ code: 'reached', message: 'Already reached.' });
    if (on > today())
      throw new BadRequestException({ code: 'in_future', message: 'Not a date in the future.' });
    const raised = await db.begin(async (tx) => {
      await tx`UPDATE re.plan_stage SET reached_on = ${on}, reached_by = ${claims.sub} WHERE id = ${stageId}`;
      const bookings = await tx<{ id: string }[]>`
        SELECT b.id FROM re.booking b JOIN re.unit u ON u.id = b.unit_id JOIN re.tower t ON t.id = u.tower_id
        WHERE t.project_id = ${s.project_id} AND b.status <> 'cancelled'
          AND (${s.tower_id}::uuid IS NULL OR u.tower_id = ${s.tower_id})
        ORDER BY b.number`;
      let n = 0;
      for (const b of bookings) n += await this.raiseDue(tx, claims, b.id, on);
      await audit(tx, claims.sub, 're.milestone', 'plan_stage', stageId, { on, demands: n });
      return n;
    });
    return { raised, overview: await this.overview(claims, s.project_id) };
  }

  // --- receipts and interest ---

  async receive(
    claims: TenantClaims,
    bookingId: string,
    input: { on: string; amount: string; mode: string; reference: string },
  ) {
    await this.may(claims, 'sales.edit');
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.bookingRow(db, bookingId);
    await this.projects.access(db, claims, b.project_id);
    const setup = await this.setupRow(db, b.project_id);
    if (!setup.collection_account_id)
      throw new ConflictException({
        code: 'no_collection_account',
        message: 'Set the collection bank account in the sales setup first.',
      });
    if (input.on > today())
      throw new BadRequestException({ code: 'in_future', message: 'Not a date in the future.' });
    const amount = p(input.amount);
    const { entity_id } = await this.entityOf(db, b.project_id);
    const id = await db.begin(async (tx) => {
      const open = await tx<{ id: string; base: string; gst: string; open: string }[]>`
        SELECT id, base::text, (cgst + sgst)::text AS gst, (base + cgst + sgst - paid)::text AS open
        FROM re.demand WHERE booking_id = ${bookingId} AND base + cgst + sgst > paid
        ORDER BY due_on, number FOR UPDATE`;
      const a = allocate(
        amount,
        open.map((d) => ({ id: d.id, base: p(d.base), gst: p(d.gst), open: p(d.open) })),
      );
      const gstPart = a.allocations.reduce((s, x) => s + x.gst, 0n);
      await tx`SELECT pg_advisory_xact_lock(hashtext('re.receipt'))`;
      const [n] = await tx<{ n: number }[]>`SELECT count(*)::int + 1 AS n FROM re.receipt`;
      const number = `RC-${String(n!.n).padStart(3, '0')}`;
      const rid = randomUUID();
      const line = (accountId: string, debit: bigint, credit: bigint): LineInput => ({
        accountId,
        partyId: null,
        debit: rupees(debit),
        credit: rupees(credit),
        projectId: b.project_id,
        siteId: null,
        costCodeId: null,
        note: '',
      });
      const v = await this.ledger.post(
        tx,
        claims,
        {
          entityId: entity_id,
          type: 'receipt',
          date: input.on,
          narration: `${number} ${b.unit} ${input.mode} ${input.reference}`.trim(),
          reference: b.number,
          lines: [
            line(setup.collection_account_id!, amount, 0n),
            line(await this.ledger.partyLedger(tx, b.party_id), 0n, amount),
          ],
        },
        { kind: 're_receipt', id: rid },
      );
      await tx`
        INSERT INTO re.receipt (id, number, booking_id, received_on, amount, gst_part, rera_share, unallocated, mode,
          reference, voucher_id, created_by)
        VALUES (${rid}, ${number}, ${bookingId}, ${input.on}, ${rupees(amount)}, ${rupees(gstPart)},
          ${rupees(reraShare(amount - a.unallocated, gstPart, setup.share_pct))}, ${rupees(a.unallocated)},
          ${input.mode}, ${input.reference}, ${v.id}, ${claims.sub})`;
      for (const x of a.allocations) {
        await tx`INSERT INTO re.receipt_allocation (receipt_id, demand_id, amount, gst)
          VALUES (${rid}, ${x.id}, ${rupees(x.amount)}, ${rupees(x.gst)})`;
        await tx`UPDATE re.demand SET paid = paid + ${rupees(x.amount)} WHERE id = ${x.id}`;
      }
      await audit(tx, claims.sub, 're.receipt', 'booking', bookingId, {
        number,
        amount: input.amount,
      });
      return rid;
    });
    void id;
    return this.booking(claims, bookingId);
  }

  /** Interest on what was paid late or is still overdue, at the project's rate, less interest already raised. */
  private async interestDue(db: Db, bookingId: string, rate: string, asOf: string) {
    const demands = await db<{ id: string; due_on: string; total: string; kind: string }[]>`
      SELECT id, to_char(due_on, 'YYYY-MM-DD') AS due_on, (base + cgst + sgst)::text AS total, kind
      FROM re.demand WHERE booking_id = ${bookingId} AND kind = 'stage'`;
    const allocs = await db<{ demand_id: string; amount: string; received_on: string }[]>`
      SELECT a.demand_id, a.amount::text, to_char(r.received_on, 'YYYY-MM-DD') AS received_on
      FROM re.receipt_allocation a JOIN re.receipt r ON r.id = a.receipt_id
      JOIN re.demand d ON d.id = a.demand_id WHERE d.booking_id = ${bookingId}`;
    let total = 0n;
    for (const d of demands) {
      let left = p(d.total);
      for (const x of allocs.filter((a) => a.demand_id === d.id)) {
        total += delayInterest(p(x.amount), rate, daysLate(d.due_on, x.received_on));
        left -= p(x.amount);
      }
      if (left > 0n) total += delayInterest(left, rate, daysLate(d.due_on, asOf));
    }
    const [raised] = await db<{ s: string }[]>`
      SELECT coalesce(sum(base), 0)::text AS s FROM re.demand WHERE booking_id = ${bookingId} AND kind = 'interest'`;
    const due = total - p(raised!.s);
    return due > 0n ? due : 0n;
  }

  async raiseInterest(claims: TenantClaims, bookingId: string, on: string) {
    await this.may(claims, 'sales.edit');
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.bookingRow(db, bookingId);
    await this.projects.access(db, claims, b.project_id);
    const setup = await this.setupRow(db, b.project_id);
    const due = await this.interestDue(db, bookingId, setup.interest_pct, on);
    if (due <= 0n)
      throw new ConflictException({ code: 'no_interest', message: 'No interest is due.' });
    await db.begin((tx) =>
      this.post(tx, claims, b, setup, {
        stageId: null,
        kind: 'interest',
        raisedOn: on,
        base: due,
        cgst: 0n,
        sgst: 0n,
        what: `Interest on late payment at ${setup.interest_pct}%`,
      }),
    );
    return this.booking(claims, bookingId);
  }

  async booking(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.bookingRow(db, id);
    await this.projects.access(db, claims, b.project_id);
    const setup = await this.setupRow(db, b.project_id);
    const [head] = await db`
      SELECT b.id, b.number, b.status, b.value::text, to_char(b.booked_on, 'YYYY-MM-DD') AS "bookedOn",
        to_char(b.agreement_on, 'YYYY-MM-DD') AS "agreementOn", b.agreement_number AS "agreementNumber",
        y.name AS buyer, y.co_applicant AS "coApplicant", y.phone, y.email, y.pan, y.address,
        t.name || '-' || u.number AS unit, u.carpet_sqm::text AS "carpetSqm", u.gst_pct::text AS "gstPct",
        u.kind AS "unitKind", u.floor, u.rate_per_sqm::text AS "ratePerSqm", u.parking::text,
        u.charges::text, t.project_id AS "projectId"
      FROM re.booking b JOIN re.buyer y ON y.id = b.buyer_id JOIN re.unit u ON u.id = b.unit_id
      JOIN re.tower t ON t.id = u.tower_id WHERE b.id = ${id}`;
    // For the cost sheet and demand letters (docs/wave7-plan.md step 7b.5): the payment plan and the registration.
    const plan = await db`
      SELECT s.position, s.name, s.pct::text, s.trigger, to_char(s.reached_on, 'YYYY-MM-DD') AS "reachedOn"
      FROM re.plan_stage s
      WHERE s.project_id = ${b.project_id} AND (s.tower_id IS NULL OR s.tower_id = ${b.tower_id})
      ORDER BY s.position`;
    const demands = await db`
      SELECT d.id, d.number, d.kind, s.name AS stage, to_char(d.raised_on, 'YYYY-MM-DD') AS "raisedOn",
        to_char(d.due_on, 'YYYY-MM-DD') AS "dueOn", d.base::text, d.cgst::text, d.sgst::text,
        (d.base + d.cgst + d.sgst)::text AS total, d.paid::text,
        (d.base + d.cgst + d.sgst - d.paid)::text AS open,
        d.base + d.cgst + d.sgst > d.paid AND d.due_on < ${today()}::date AS overdue
      FROM re.demand d LEFT JOIN re.plan_stage s ON s.id = d.stage_id
      WHERE d.booking_id = ${id} ORDER BY d.raised_on, d.number`;
    const receipts = await db`
      SELECT number, to_char(received_on, 'YYYY-MM-DD') AS "receivedOn", amount::text, gst_part::text AS "gstPart",
        rera_share::text AS "reraShare", unallocated::text, mode, reference
      FROM re.receipt WHERE booking_id = ${id} ORDER BY received_on, number`;
    const sum = (xs: Record<string, unknown>[], k: string) =>
      rupees(xs.reduce((a, x) => a + p(x[k] as string), 0n));
    return {
      ...head!,
      reraNumber: setup.rera_number,
      interestPct: setup.interest_pct,
      plan,
      demands,
      receipts,
      totals: {
        demanded: sum(demands, 'total'),
        received: sum(receipts, 'amount'),
        outstanding: sum(demands, 'open'),
        interestDue: rupees(await this.interestDue(db, id, setup.interest_pct, today())),
      },
    };
  }

  async bookings(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return db`
      SELECT b.id, b.number, b.status, b.value::text, t.name || '-' || u.number AS unit, y.name AS buyer,
        to_char(b.booked_on, 'YYYY-MM-DD') AS "bookedOn",
        coalesce((SELECT sum(base + cgst + sgst) FROM re.demand d WHERE d.booking_id = b.id), 0)::text AS demanded,
        coalesce((SELECT sum(amount) FROM re.receipt r WHERE r.booking_id = b.id), 0)::text AS received,
        coalesce((SELECT sum(base + cgst + sgst - paid) FROM re.demand d WHERE d.booking_id = b.id
          AND d.due_on < ${today()}::date), 0)::text AS overdue
      FROM re.booking b JOIN re.unit u ON u.id = b.unit_id JOIN re.tower t ON t.id = u.tower_id
      JOIN re.buyer y ON y.id = b.buyer_id
      WHERE t.project_id = ${projectId} ORDER BY b.number`;
  }

  // --- the designated account ---

  async rera(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const [x] = await db<
      { required: string; deposited: string; withdrawn: string; completion: string | null }[]
    >`
      SELECT
        coalesce((SELECT sum(r.rera_share) FROM re.receipt r JOIN re.booking b ON b.id = r.booking_id
          JOIN re.unit u ON u.id = b.unit_id JOIN re.tower t ON t.id = u.tower_id WHERE t.project_id = ${projectId}), 0)::numeric(16, 2)::text AS required,
        coalesce((SELECT sum(amount) FROM re.rera_entry WHERE project_id = ${projectId} AND kind = 'deposit'), 0)::numeric(16, 2)::text AS deposited,
        coalesce((SELECT sum(amount) FROM re.rera_entry WHERE project_id = ${projectId} AND kind = 'withdrawal'), 0)::numeric(16, 2)::text AS withdrawn,
        (SELECT completion_pct::text FROM re.rera_entry WHERE project_id = ${projectId} AND kind = 'withdrawal'
          ORDER BY on_date DESC, created_at DESC LIMIT 1) AS completion`;
    const entries = await db`
      SELECT e.kind, to_char(e.on_date, 'YYYY-MM-DD') AS "on", e.amount::text, e.completion_pct::text AS "completionPct",
        e.engineer_ref AS "engineerRef", e.architect_ref AS "architectRef", e.ca_ref AS "caRef"
      FROM re.rera_entry e WHERE e.project_id = ${projectId} ORDER BY e.on_date, e.created_at`;
    const required = p(x!.required);
    const deposited = p(x!.deposited);
    const withdrawn = p(x!.withdrawn);
    return {
      required: rupees(required),
      deposited: rupees(deposited),
      shortfall: rupees(required > deposited ? required - deposited : 0n),
      withdrawn: rupees(withdrawn),
      balance: rupees(deposited - withdrawn),
      lastCompletionPct: x!.completion,
      entries,
    };
  }

  async reraEntry(
    claims: TenantClaims,
    projectId: string,
    input: {
      kind: 'deposit' | 'withdrawal';
      on: string;
      amount: string;
      toAccountId: string | null;
      completionPct: string | null;
      engineerRef: string;
      architectRef: string;
      caRef: string;
    },
  ) {
    await this.may(claims, 'sales.edit');
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const setup = await this.setupRow(db, projectId);
    if (!setup.collection_account_id || !setup.designated_account_id)
      throw new ConflictException({
        code: 'no_accounts',
        message: 'Set the collection and designated bank accounts in the sales setup first.',
      });
    const amount = p(input.amount);
    if (input.kind === 'withdrawal') {
      if (
        !input.completionPct ||
        !input.toAccountId ||
        !input.engineerRef ||
        !input.architectRef ||
        !input.caRef
      )
        throw new BadRequestException({
          code: 'certificates',
          message:
            "A withdrawal needs the completion % and the engineer's, architect's and CA's certificates (Forms 1, 2 and 3).",
        });
      const r = await this.rera(claims, projectId);
      const may = withdrawable(p(r.deposited), input.completionPct, p(r.withdrawn));
      if (amount > may)
        throw new ConflictException({
          code: 'over_limit',
          message: `At ${input.completionPct}% completion ₹${rupees(may)} more may be withdrawn.`,
        });
    }
    const { entity_id, number } = await this.entityOf(db, projectId);
    await db.begin(async (tx) => {
      const id = randomUUID();
      const [from, to] =
        input.kind === 'deposit'
          ? [setup.collection_account_id!, setup.designated_account_id!]
          : [setup.designated_account_id!, input.toAccountId!];
      const line = (accountId: string, debit: bigint, credit: bigint): LineInput => ({
        accountId,
        partyId: null,
        debit: rupees(debit),
        credit: rupees(credit),
        projectId,
        siteId: null,
        costCodeId: null,
        note: '',
      });
      const v = await this.ledger.post(
        tx,
        claims,
        {
          entityId: entity_id,
          type: 'contra',
          date: input.on,
          narration:
            input.kind === 'deposit'
              ? `${number}: into the RERA designated account`
              : `${number}: from the RERA designated account at ${input.completionPct}% completion`,
          reference: input.kind === 'withdrawal' ? input.caRef : '',
          lines: [line(to, amount, 0n), line(from, 0n, amount)],
        },
        { kind: 're_rera', id },
      );
      await tx`
        INSERT INTO re.rera_entry ${tx({
          id,
          project_id: projectId,
          kind: input.kind,
          on_date: input.on,
          amount: input.amount,
          to_account_id: input.kind === 'withdrawal' ? input.toAccountId : null,
          completion_pct: input.kind === 'withdrawal' ? input.completionPct : null,
          engineer_ref: input.engineerRef,
          architect_ref: input.architectRef,
          ca_ref: input.caRef,
          voucher_id: v.id,
          created_by: claims.sub,
        })}`;
      await audit(tx, claims.sub, `re.rera.${input.kind}`, 'project', projectId, {
        amount: input.amount,
      });
    });
    return this.rera(claims, projectId);
  }

  /** The figures for MahaRERA's quarterly update, for the quarter ending on `upto`. */
  async quarter(claims: TenantClaims, projectId: string, upto: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const m = Number(upto.slice(5, 7));
    const qStart = `${upto.slice(0, 4)}-${String(m - ((m - 1) % 3)).padStart(2, '0')}-01`;
    const setup = await this.setupRow(db, projectId);
    const [{ name, number }] = [await this.entityOf(db, projectId)];
    const towers = await db<
      { tower: string; units: number; booked_q: number; booked: number; reached: string[] | null }[]
    >`
      SELECT t.name AS tower, count(u.id)::int AS units,
        count(b.id) FILTER (WHERE b.booked_on BETWEEN ${qStart} AND ${upto})::int AS booked_q,
        count(b.id) FILTER (WHERE b.booked_on <= ${upto})::int AS booked,
        (SELECT array_agg(s.name ORDER BY s.position) FROM re.plan_stage s
          WHERE s.project_id = t.project_id AND s.trigger = 'milestone' AND (s.tower_id IS NULL OR s.tower_id = t.id)
            AND s.reached_on <= ${upto}) AS reached
      FROM re.tower t LEFT JOIN re.unit u ON u.tower_id = t.id
      LEFT JOIN re.booking b ON b.unit_id = u.id AND b.status <> 'cancelled'
      WHERE t.project_id = ${projectId} GROUP BY t.id ORDER BY t.name`;
    const [money] = await db<
      { collected_q: string; collected: string; dep_q: string; wd_q: string }[]
    >`
      SELECT
        coalesce(sum(r.amount) FILTER (WHERE r.received_on BETWEEN ${qStart} AND ${upto}), 0)::numeric(16, 2)::text AS collected_q,
        coalesce(sum(r.amount) FILTER (WHERE r.received_on <= ${upto}), 0)::numeric(16, 2)::text AS collected,
        (SELECT coalesce(sum(amount), 0)::numeric(16, 2)::text FROM re.rera_entry WHERE project_id = ${projectId} AND kind = 'deposit'
          AND on_date BETWEEN ${qStart} AND ${upto}) AS dep_q,
        (SELECT coalesce(sum(amount), 0)::numeric(16, 2)::text FROM re.rera_entry WHERE project_id = ${projectId} AND kind = 'withdrawal'
          AND on_date BETWEEN ${qStart} AND ${upto}) AS wd_q
      FROM re.receipt r JOIN re.booking b ON b.id = r.booking_id JOIN re.unit u ON u.id = b.unit_id
      JOIN re.tower t ON t.id = u.tower_id WHERE t.project_id = ${projectId}`;
    return {
      project: `${number} ${name}`,
      reraNumber: setup.rera_number,
      from: qStart,
      upto,
      towers: towers.map((t) => ({
        tower: t.tower,
        units: t.units,
        bookedInQuarter: t.booked_q,
        bookedToDate: t.booked,
        milestonesReached: t.reached ?? [],
      })),
      collectedInQuarter: money!.collected_q,
      collectedToDate: money!.collected,
      depositedInQuarter: money!.dep_q,
      withdrawnInQuarter: money!.wd_q,
    };
  }
}
