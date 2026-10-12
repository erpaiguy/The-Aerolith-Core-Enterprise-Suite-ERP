// Equipment and fleet (docs/wave3-plan.md step 10): the register (own or hired), allocation to projects, daily log
// sheets, fuel issued from stores against a machine, maintenance plans and records, and the month's costing (own
// machines charged to projects at their internal rate; hired machines' hire bills worked from the log sheets).
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
import { dec, div, fmt, mul, type Dec } from '../rates/decimal.js';
import { audit } from '../tender/tender-records.js';
import { fromDb } from './accounts-rules.js';
import { addDays, daysBetween } from './depreciation.js';
import { LedgerService, type LineInput } from './ledger.service.js';
import { PayableService } from './payable.service.js';

type Db = Sql | TransactionSql;
const money = (v: Dec) => fmt(v, 2);
const r2 = (v: Dec) => dec(fmt(v, 2));
/** Fuel more than this far off the norm is flagged. */
const FUEL_TOLERANCE_PCT = 20;
const lastDay = (month: string) => {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

interface Eq {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  category: string;
  meter: 'hours' | 'km';
  ownership: 'own' | 'hired';
  asset_id: string | null;
  internal_rate: string | null;
  party_id: string | null;
  hire_basis: 'hour' | 'day' | 'month' | null;
  hire_rate: string | null;
  min_hours: string;
  operator_by: string;
  fuel_by: string;
  fuel_norm: string | null;
  status: string;
}
export interface EquipmentInput {
  entityId: string;
  code: string;
  name: string;
  category: string;
  meter: 'hours' | 'km';
  ownership: 'own' | 'hired';
  assetId: string | null;
  internalRate: string | null;
  partyId: string | null;
  hireBasis: 'hour' | 'day' | 'month' | null;
  hireRate: string | null;
  minHours: string;
  operatorBy: 'own' | 'hirer';
  fuelBy: 'own' | 'hirer';
  fuelNorm: string | null;
}
export interface LogInput {
  date: string;
  startReading: string | null;
  endReading: string | null;
  worked: string | null;
  idleHours: string;
  idleReason: string;
  breakdownHours: string;
  operator: string;
}

@Injectable()
export class EquipmentService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly ledger: LedgerService,
    private readonly payables: PayableService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          p === 'accounts.view'
            ? 'The equipment register needs the accounts permission.'
            : 'This needs the permission to post.',
      });
  }

  private async row(db: Db, id: string) {
    const [e] = await db<Eq[]>`
      SELECT id, entity_id, code, name, category, meter, ownership, asset_id, internal_rate::text AS internal_rate,
        party_id, hire_basis, hire_rate::text AS hire_rate, min_hours::text AS min_hours, operator_by, fuel_by,
        fuel_norm::text AS fuel_norm, status
      FROM eqp.equipment WHERE id = ${id}`;
    if (!e) throw new NotFoundException({ code: 'equipment_not_found' });
    return e;
  }

  /** Where a machine was on a date. */
  private async placeOn(db: Db, id: string, date: string) {
    const [a] = await db<{ project_id: string | null; site_id: string | null }[]>`
      SELECT project_id, site_id FROM eqp.allocation WHERE equipment_id = ${id} AND from_date <= ${date}
      ORDER BY from_date DESC LIMIT 1`;
    return a ?? null;
  }

  // --- the register ---

  async create(claims: TenantClaims, input: EquipmentInput) {
    await this.may(claims, 'accounts.post');
    if (input.ownership === 'own' && (input.partyId || input.hireBasis))
      throw new BadRequestException({
        code: 'own_not_hired',
        message: 'Own equipment has no hirer or hire terms.',
      });
    if (input.ownership === 'hired' && (!input.partyId || !input.hireBasis || !input.hireRate))
      throw new BadRequestException({
        code: 'hire_terms',
        message: 'A hired machine needs its supplier, the basis of hire and the rate.',
      });
    if (input.ownership === 'hired' && input.assetId)
      throw new BadRequestException({
        code: 'hired_asset',
        message: 'A hired machine is not our asset.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db
      .begin(async (tx) => {
        if (input.assetId) {
          const [a] =
            await tx`SELECT 1 FROM acc.asset WHERE id = ${input.assetId} AND entity_id = ${input.entityId}
            AND status = 'active'`;
          if (!a)
            throw new BadRequestException({
              code: 'not_an_asset',
              message: 'Not an active fixed asset of this company.',
            });
        }
        const rows = await tx<{ id: string }[]>`
          INSERT INTO eqp.equipment (entity_id, code, name, category, meter, ownership, asset_id, internal_rate, party_id,
            hire_basis, hire_rate, min_hours, operator_by, fuel_by, fuel_norm, created_by)
          VALUES (${input.entityId}, ${input.code}, ${input.name}, ${input.category}, ${input.meter}, ${input.ownership},
            ${input.assetId}, ${input.internalRate}, ${input.partyId}, ${input.hireBasis}, ${input.hireRate},
            ${input.minHours}, ${input.operatorBy}, ${input.fuelBy}, ${input.fuelNorm}, ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'equipment.create', 'equipment', rows[0]!.id, {
          code: input.code,
        });
        return rows;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'equipment_exists',
            message: `There is already ${input.code}, or that asset is on the register.`,
          });
        throw err;
      });
    return this.get(claims, e!.id);
  }

  async list(claims: TenantClaims, entityId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT e.id, e.code, e.name, e.category, e.ownership, e.meter, e.status, p.name AS supplier,
        (SELECT json_build_object('from', to_char(a.from_date, 'YYYY-MM-DD'), 'project', pr.number,
          'projectName', pr.name, 'site', s.name)
          FROM eqp.allocation a LEFT JOIN proj.project pr ON pr.id = a.project_id LEFT JOIN proj.site s ON s.id = a.site_id
          WHERE a.equipment_id = e.id AND a.from_date <= current_date ORDER BY a.from_date DESC LIMIT 1) AS place
      FROM eqp.equipment e LEFT JOIN platform.party p ON p.id = e.party_id
      WHERE e.entity_id = ${entityId} ORDER BY e.code`;
  }

  async get(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const e = await this.row(db, id);
    const [party] = e.party_id
      ? await db<{ name: string }[]>`SELECT name FROM platform.party WHERE id = ${e.party_id}`
      : [];
    const allocations = await db`
      SELECT to_char(a.from_date, 'YYYY-MM-DD') AS "from", a.project_id AS "projectId", pr.number AS project,
        pr.name AS "projectName", a.site_id AS "siteId", s.name AS site
      FROM eqp.allocation a LEFT JOIN proj.project pr ON pr.id = a.project_id LEFT JOIN proj.site s ON s.id = a.site_id
      WHERE a.equipment_id = ${id} ORDER BY a.from_date`;
    return {
      id: e.id,
      code: e.code,
      name: e.name,
      category: e.category,
      meter: e.meter,
      ownership: e.ownership,
      assetId: e.asset_id,
      internalRate: e.internal_rate,
      supplier: party ? { id: e.party_id, name: party.name } : null,
      hireBasis: e.hire_basis,
      hireRate: e.hire_rate,
      minHours: e.min_hours,
      operatorBy: e.operator_by,
      fuelBy: e.fuel_by,
      fuelNorm: e.fuel_norm,
      status: e.status,
      allocations,
      maintenance: await this.due(db, id, null),
      mayPost: await this.permissions.can(claims, 'accounts.post'),
    };
  }

  async allocate(
    claims: TenantClaims,
    id: string,
    input: { date: string; projectId: string | null; siteId: string | null },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const e = await this.row(tx, id);
        if (e.status !== 'active')
          throw new ConflictException({ code: 'retired', message: 'The machine is retired.' });
        if (input.siteId) {
          const [s] =
            await tx`SELECT 1 FROM proj.site WHERE id = ${input.siteId} AND project_id = ${input.projectId}`;
          if (!s)
            throw new BadRequestException({
              code: 'not_this_project',
              message: "The site is not the project's.",
            });
        }
        const [logged] =
          await tx`SELECT 1 FROM eqp.log WHERE equipment_id = ${id} AND log_date >= ${input.date} LIMIT 1`;
        if (logged)
          throw new ConflictException({
            code: 'logged_after',
            message: 'There are log sheets on or after that date; move it from a later day.',
          });
        await tx`INSERT INTO eqp.allocation (equipment_id, from_date, project_id, site_id, created_by)
          VALUES (${id}, ${input.date}, ${input.projectId}, ${input.siteId}, ${claims.sub})
          ON CONFLICT (equipment_id, from_date) DO NOTHING`;
        await audit(tx, claims.sub, 'equipment.allocate', 'equipment', id, { ...input });
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  // --- log sheets ---

  /** A day's log: by the project's team (as its daily report), or with the permission to post. */
  async log(claims: TenantClaims, id: string, input: LogInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const e = await this.row(tx, id);
      const place = await this.placeOn(tx, id, input.date);
      if (!place?.project_id)
        throw new BadRequestException({
          code: 'not_allocated',
          message: `${e.code} was not on a project that day.`,
        });
      const a = await this.projects.access(tx, claims, place.project_id);
      if (!(
        a.canEdit ||
        a.role === 'lead' ||
        a.role === 'member' ||
        (await this.permissions.can(claims, 'accounts.post'))
      ))
        throw new ForbiddenException({
          code: 'forbidden',
          message: "Log sheets are kept by the project's team.",
        });
      const [today] = await tx<{ d: string }[]>`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`;
      if (input.date > today!.d)
        throw new BadRequestException({ code: 'future', message: 'Log a day that has happened.' });
      let worked = input.worked;
      if (input.startReading !== null && input.endReading !== null) {
        if (dec(input.endReading) < dec(input.startReading))
          throw new BadRequestException({
            code: 'reading_back',
            message: 'The closing reading is below the opening.',
          });
        worked = fmt(dec(input.endReading) - dec(input.startReading), 1);
      }
      if (worked === null)
        throw new BadRequestException({
          code: 'worked_needed',
          message: 'Give the readings, or the hours worked.',
        });
      const [prev] = await tx<{ end_reading: string | null }[]>`
        SELECT end_reading::text AS end_reading FROM eqp.log WHERE equipment_id = ${id} AND log_date < ${input.date}
          AND end_reading IS NOT NULL ORDER BY log_date DESC LIMIT 1`;
      if (
        prev?.end_reading &&
        input.startReading !== null &&
        dec(input.startReading) < dec(prev.end_reading)
      )
        throw new BadRequestException({
          code: 'reading_overlap',
          message: `The opening reading is below the last closing reading (${Number(prev.end_reading)}).`,
        });
      if (
        e.meter === 'hours' &&
        dec(worked) + dec(input.idleHours) + dec(input.breakdownHours) > dec('24')
      )
        throw new BadRequestException({
          code: 'over_a_day',
          message: 'More than 24 hours in a day.',
        });
      await tx`
        INSERT INTO eqp.log (equipment_id, log_date, project_id, site_id, start_reading, end_reading, worked, idle_hours,
          idle_reason, breakdown_hours, operator, updated_by)
        VALUES (${id}, ${input.date}, ${place.project_id}, ${place.site_id}, ${input.startReading}, ${input.endReading},
          ${worked}, ${input.idleHours}, ${input.idleReason}, ${input.breakdownHours}, ${input.operator}, ${claims.sub})
        ON CONFLICT (equipment_id, log_date) DO UPDATE SET start_reading = EXCLUDED.start_reading,
          end_reading = EXCLUDED.end_reading, worked = EXCLUDED.worked, idle_hours = EXCLUDED.idle_hours,
          idle_reason = EXCLUDED.idle_reason, breakdown_hours = EXCLUDED.breakdown_hours, operator = EXCLUDED.operator,
          updated_at = now(), updated_by = EXCLUDED.updated_by`;
    });
    return this.listLogs(db, id, { from: addDays(input.date, -30), to: input.date });
  }

  async logs(claims: TenantClaims, id: string, q: { from: string; to: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    await this.row(db, id);
    return this.listLogs(db, id, q);
  }

  private listLogs(db: Db, id: string, q: { from: string; to: string }) {
    return db`
      SELECT to_char(l.log_date, 'YYYY-MM-DD') AS date, pr.number AS project, s.name AS site,
        l.start_reading::text AS "startReading", l.end_reading::text AS "endReading", l.worked::text AS worked,
        l.idle_hours::text AS "idleHours", l.idle_reason AS "idleReason", l.breakdown_hours::text AS "breakdownHours",
        l.operator
      FROM eqp.log l LEFT JOIN proj.project pr ON pr.id = l.project_id LEFT JOIN proj.site s ON s.id = l.site_id
      WHERE l.equipment_id = ${id} AND l.log_date BETWEEN ${q.from} AND ${q.to} ORDER BY l.log_date`;
  }

  /** The day's log sheets at a site, for the daily report. */
  static siteLogs(db: Db, siteId: string, date: string) {
    return db`
      SELECT e.code, e.name, e.ownership, l.worked::text AS worked, l.idle_hours::text AS "idleHours",
        l.idle_reason AS "idleReason", l.breakdown_hours::text AS "breakdownHours", l.operator
      FROM eqp.log l JOIN eqp.equipment e ON e.id = l.equipment_id
      WHERE l.site_id = ${siteId} AND l.log_date = ${date} ORDER BY e.code`;
  }

  // --- fuel ---

  /** Each machine's work and the fuel issued against it in a period; flagged when off the norm by more than 20%. */
  async fuel(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      {
        id: string;
        code: string;
        name: string;
        meter: string;
        fuel_norm: string | null;
        worked: string;
        litres: string;
      }[]
    >`
      SELECT e.id, e.code, e.name, e.meter, e.fuel_norm::text AS fuel_norm,
        coalesce((SELECT sum(l.worked) FROM eqp.log l WHERE l.equipment_id = e.id
          AND l.log_date BETWEEN ${q.from} AND ${q.to}), 0)::text AS worked,
        coalesce((SELECT sum(il.qty) FROM proc.stock_issue i JOIN proc.stock_issue_line il ON il.issue_id = i.id
          WHERE i.equipment_id = e.id AND i.issued_on BETWEEN ${q.from} AND ${q.to}), 0)::text AS litres
      FROM eqp.equipment e WHERE e.entity_id = ${q.entityId} ORDER BY e.code`;
    return {
      ...q,
      rows: rows
        .filter((r) => dec(r.worked) > 0n || dec(r.litres) > 0n)
        .map((r) => {
          const perUnit = dec(r.worked) > 0n ? fmt(div(dec(r.litres), dec(r.worked)), 2) : null;
          const offPct =
            perUnit && r.fuel_norm
              ? Math.round(((Number(perUnit) - Number(r.fuel_norm)) / Number(r.fuel_norm)) * 1000) /
                10
              : null;
          return {
            id: r.id,
            code: r.code,
            name: r.name,
            meter: r.meter,
            worked: r.worked,
            litres: fmt(dec(r.litres), 2),
            perUnit,
            norm: r.fuel_norm,
            offPct,
            flagged: offPct !== null && Math.abs(offPct) > FUEL_TOLERANCE_PCT,
          };
        }),
    };
  }

  // --- maintenance ---

  async addPlan(
    claims: TenantClaims,
    id: string,
    input: {
      name: string;
      everyHours: string | null;
      everyDays: number | null;
      fromDate: string;
      fromReading: string;
    },
  ) {
    await this.may(claims, 'accounts.post');
    if (!input.everyHours && !input.everyDays)
      throw new BadRequestException({
        code: 'no_interval',
        message: 'Every so many hours, or days.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await this.row(db, id);
    await db`INSERT INTO eqp.maintenance_plan (equipment_id, name, every_hours, every_days, from_date, from_reading, created_by)
      VALUES (${id}, ${input.name}, ${input.everyHours}, ${input.everyDays}, ${input.fromDate}, ${input.fromReading},
        ${claims.sub})`;
    return this.get(claims, id);
  }

  async addRecord(
    claims: TenantClaims,
    id: string,
    input: {
      planId: string | null;
      kind: 'service' | 'breakdown';
      doneOn: string;
      reading: string | null;
      description: string;
      downtimeHours: string;
      cost: string;
    },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await this.row(db, id);
    if (input.planId) {
      const [p] =
        await db`SELECT 1 FROM eqp.maintenance_plan WHERE id = ${input.planId} AND equipment_id = ${id}`;
      if (!p)
        throw new BadRequestException({
          code: 'not_this_plan',
          message: "Not this machine's plan.",
        });
    }
    await db`INSERT INTO eqp.maintenance_record (equipment_id, plan_id, kind, done_on, reading, description, downtime_hours,
        cost, created_by)
      VALUES (${id}, ${input.planId}, ${input.kind}, ${input.doneOn}, ${input.reading}, ${input.description},
        ${input.downtimeHours}, ${input.cost}, ${claims.sub})`;
    return this.get(claims, id);
  }

  /** Each plan's last service, the machine's reading now, and what is due (by hours, by days) as at a date. */
  private async due(db: Db, id: string, asOf: string | null) {
    const [now] = await db<{ reading: string | null; today: string }[]>`
      SELECT (SELECT max(end_reading) FROM eqp.log WHERE equipment_id = ${id})::text AS reading,
        to_char(${asOf ?? null}::date, 'YYYY-MM-DD') AS today`;
    const today = now!.today ?? new Date().toISOString().slice(0, 10);
    const plans = await db<
      {
        id: string;
        name: string;
        every_hours: string | null;
        every_days: number | null;
        from_date: string;
        from_reading: string;
        last_on: string | null;
        last_reading: string | null;
      }[]
    >`
      SELECT p.id, p.name, p.every_hours::text AS every_hours, p.every_days, to_char(p.from_date, 'YYYY-MM-DD') AS from_date,
        p.from_reading::text AS from_reading,
        (SELECT to_char(max(r.done_on), 'YYYY-MM-DD') FROM eqp.maintenance_record r WHERE r.plan_id = p.id) AS last_on,
        (SELECT r.reading::text FROM eqp.maintenance_record r WHERE r.plan_id = p.id ORDER BY r.done_on DESC LIMIT 1)
          AS last_reading
      FROM eqp.maintenance_plan p WHERE p.equipment_id = ${id} ORDER BY p.name`;
    const reading = now!.reading ? dec(now!.reading) : null;
    const records = await db`
      SELECT r.kind, to_char(r.done_on, 'YYYY-MM-DD') AS "doneOn", r.reading::text AS reading, r.description,
        r.downtime_hours::text AS "downtimeHours", r.cost::text AS cost, p.name AS plan
      FROM eqp.maintenance_record r LEFT JOIN eqp.maintenance_plan p ON p.id = r.plan_id
      WHERE r.equipment_id = ${id} ORDER BY r.done_on DESC LIMIT 50`;
    return {
      reading: reading === null ? null : fmt(reading, 1),
      plans: plans.map((p) => {
        const baseReading = dec(p.last_reading ?? p.from_reading);
        const baseDate = p.last_on ?? p.from_date;
        const dueAtReading = p.every_hours ? baseReading + dec(p.every_hours) : null;
        const dueOn = p.every_days ? addDays(baseDate, p.every_days) : null;
        const byHours = dueAtReading !== null && reading !== null && reading >= dueAtReading;
        const byDays = dueOn !== null && today >= dueOn;
        return {
          id: p.id,
          name: p.name,
          everyHours: p.every_hours,
          everyDays: p.every_days,
          lastOn: p.last_on,
          dueAtReading: dueAtReading === null ? null : fmt(dueAtReading, 1),
          dueOn,
          due: byHours || byDays,
        };
      }),
      records,
    };
  }

  async maintenance(claims: TenantClaims, id: string, asOf: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    await this.row(db, id);
    return this.due(db, id, asOf);
  }

  // --- the month's costing ---

  /**
   * The month worked out: own machines' hours (or km) on each project at their internal rate; hired machines' hire
   * from the log sheets: by the hour (at least the monthly minimum, the shortfall on the project with the most hours),
   * by the day worked, or the month pro rata to the days allocated to each project.
   */
  private async work(db: Db, entityId: string, month: string) {
    const from = `${month}-01`;
    const to = lastDay(month);
    const eqs = await db<Eq[]>`
      SELECT id, entity_id, code, name, category, meter, ownership, asset_id, internal_rate::text AS internal_rate,
        party_id, hire_basis, hire_rate::text AS hire_rate, min_hours::text AS min_hours, operator_by, fuel_by,
        fuel_norm::text AS fuel_norm, status
      FROM eqp.equipment WHERE entity_id = ${entityId} ORDER BY code`;
    const own: {
      equipment: string;
      projectId: string;
      qty: string;
      rate: string;
      amount: string;
    }[] = [];
    const hired: {
      equipmentId: string;
      equipment: string;
      name: string;
      partyId: string;
      basis: string;
      lines: {
        projectId: string;
        description: string;
        unit: string;
        qty: string;
        rate: string;
        amount: string;
      }[];
      total: string;
    }[] = [];
    for (const e of eqs) {
      const logs = await db<{ project_id: string; worked: string; days: number }[]>`
        SELECT project_id, sum(worked)::text AS worked, count(*) FILTER (WHERE worked > 0)::int AS days FROM eqp.log
        WHERE equipment_id = ${e.id} AND log_date BETWEEN ${from} AND ${to} AND project_id IS NOT NULL
        GROUP BY project_id ORDER BY sum(worked) DESC, project_id`;
      const unit = e.meter === 'km' ? 'km' : 'hour';
      if (e.ownership === 'own') {
        if (!e.internal_rate) continue;
        for (const l of logs.filter((x) => dec(x.worked) > 0n))
          own.push({
            equipment: e.code,
            projectId: l.project_id,
            qty: l.worked,
            rate: e.internal_rate,
            amount: money(r2(mul(dec(l.worked), dec(e.internal_rate)))),
          });
        continue;
      }
      const rate = dec(e.hire_rate!);
      const lines: (typeof hired)[number]['lines'] = [];
      if (e.hire_basis === 'hour') {
        for (const l of logs.filter((x) => dec(x.worked) > 0n))
          lines.push({
            projectId: l.project_id,
            description: `${e.name}, ${month}: ${Number(l.worked)} ${unit}s`,
            unit,
            qty: l.worked,
            rate: e.hire_rate!,
            amount: money(r2(mul(dec(l.worked), rate))),
          });
        const worked = logs.reduce((s, l) => s + dec(l.worked), 0n);
        const short = dec(e.min_hours) - worked;
        if (short > 0n) {
          const place = logs[0]?.project_id ?? (await this.placeOn(db, e.id, to))?.project_id;
          if (place)
            lines.push({
              projectId: place,
              description: `${e.name}, ${month}: monthly minimum, ${Number(fmt(short, 1))} ${unit}s short`,
              unit,
              qty: fmt(short, 1),
              rate: e.hire_rate!,
              amount: money(r2(mul(short, rate))),
            });
        }
      } else if (e.hire_basis === 'day') {
        for (const l of logs.filter((x) => x.days > 0))
          lines.push({
            projectId: l.project_id,
            description: `${e.name}, ${month}: ${l.days} days`,
            unit: 'day',
            qty: String(l.days),
            rate: e.hire_rate!,
            amount: money(r2(mul(dec(String(l.days)), rate))),
          });
      } else {
        // The month pro rata to the days allocated to each project.
        const days = daysBetween(from, to);
        const byProject = new Map<string, number>();
        for (let d = from; d <= to; d = addDays(d, 1)) {
          const p = (await this.placeOn(db, e.id, d))?.project_id;
          if (p) byProject.set(p, (byProject.get(p) ?? 0) + 1);
        }
        for (const [p, n] of byProject)
          lines.push({
            projectId: p,
            description: `${e.name}, ${month}: ${n} of ${days} days`,
            unit: 'month',
            qty: '1',
            rate: money(r2(div(mul(rate, dec(String(n))), dec(String(days))))),
            amount: money(r2(div(mul(rate, dec(String(n))), dec(String(days))))),
          });
      }
      if (lines.length)
        hired.push({
          equipmentId: e.id,
          equipment: e.code,
          name: e.name,
          partyId: e.party_id!,
          basis: e.hire_basis!,
          lines,
          total: money(lines.reduce((s, l) => s + dec(l.amount), 0n)),
        });
    }
    return {
      from,
      to,
      own,
      hired,
      internalTotal: money(own.reduce((s, o) => s + dec(o.amount), 0n)),
    };
  }

  async costingPreview(claims: TenantClaims, q: { entityId: string; month: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [done] = await db<{ voucher: string | null; hireBills: unknown }[]>`
      SELECT v.number AS voucher, c.hire_bills AS "hireBills" FROM eqp.costing c LEFT JOIN acc.voucher v ON v.id = c.voucher_id
      WHERE c.entity_id = ${q.entityId} AND c.month = ${`${q.month}-01`}`;
    return { ...q, ...(await this.work(db, q.entityId, q.month)), done: done ?? null };
  }

  /** The month posted: one journal for own machines; a supplier's bill for each hired one. Once a month. */
  async costingPost(claims: TenantClaims, q: { entityId: string; month: string }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const [done] =
      await db`SELECT 1 FROM eqp.costing WHERE entity_id = ${q.entityId} AND month = ${`${q.month}-01`}`;
    if (done)
      throw new ConflictException({
        code: 'month_costed',
        message: `${q.month} is already costed.`,
      });
    const w = await this.work(db, q.entityId, q.month);
    if (!w.own.length && !w.hired.length)
      throw new BadRequestException({
        code: 'nothing_to_cost',
        message: 'No machine worked that month.',
      });
    const hireAccount = await db.begin((tx) =>
      this.ledger.roleAccount(tx, q.entityId, 'equipment_hire'),
    );
    const bills: { equipment: string; billId: string; billNo: string; total: string }[] = [];
    for (const h of w.hired) {
      const billNo = `HIRE/${h.equipment}/${q.month}`.slice(0, 60);
      const b = (await this.payables.createBill(claims, {
        entityId: q.entityId,
        partyId: h.partyId,
        orderId: null,
        projectId: null,
        billNo,
        billDate: w.to,
        dueDate: addDays(w.to, 30),
        tdsSection: null,
        narration: `Hire of ${h.name} for ${q.month}, from the log sheets`,
        lines: h.lines.map((l) => ({
          lineKey: null,
          accountId: hireAccount,
          projectId: l.projectId,
          description: l.description,
          unit: l.unit,
          qty: l.qty,
          rate: l.rate,
          gstPct: '18',
        })),
      })) as unknown as { id: string; total: string };
      bills.push({ equipment: h.equipment, billId: b.id, billNo, total: b.total });
    }
    await db
      .begin(async (tx) => {
        let voucherId: string | null = null;
        if (w.own.length) {
          const charges = await this.ledger.roleAccount(tx, q.entityId, 'equipment_charges');
          const recovery = await this.ledger.roleAccount(tx, q.entityId, 'equipment_recovery');
          const byProject = new Map<string, Dec>();
          for (const o of w.own)
            byProject.set(o.projectId, (byProject.get(o.projectId) ?? 0n) + dec(o.amount));
          const line = (
            accountId: string,
            debit: string,
            credit: string,
            projectId: string | null,
          ): LineInput => ({
            accountId,
            partyId: null,
            debit,
            credit,
            projectId,
            siteId: null,
            costCodeId: null,
            note: `Own equipment, ${q.month}`,
          });
          const v = await this.ledger.post(
            tx,
            claims,
            {
              entityId: q.entityId,
              type: 'journal',
              date: w.to,
              narration: `Own equipment charged to projects, ${q.month}`,
              reference: `Equipment ${q.month}`,
              lines: [
                ...[...byProject.entries()].map(([p, v]) => line(charges, money(v), '0', p)),
                line(recovery, '0', w.internalTotal, null),
              ],
            },
            { kind: 'equipment_costing', id: q.entityId },
          );
          voucherId = v!.id;
        }
        await tx`INSERT INTO eqp.costing (entity_id, month, voucher_id, internal_total, hire_bills, created_by)
          VALUES (${q.entityId}, ${`${q.month}-01`}, ${voucherId}, ${w.internalTotal},
            ${tx.json(JSON.parse(JSON.stringify(bills)))}, ${claims.sub})`;
        await audit(tx, claims.sub, 'equipment.costing', 'entity', q.entityId, {
          month: q.month,
          bills: bills.length,
        });
      })
      .catch(fromDb);
    return this.costingPreview(claims, q);
  }
}
