// The risk register (docs/wave4-plan.md step 6): risks per project or company on the company's scales, mitigation
// actions, the heat map and top risks, and the contingency held in a project's budget drawn down against risks that
// occur.
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
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { band, DEFAULT_SCALES, expectedValue, heatMap, score, type Scales } from './risk-rules.js';

type Db = Sql | TransactionSql;

export interface RiskInput {
  category: string;
  cause: string;
  event: string;
  effect: string;
  probability: number;
  impact: number;
  costImpact: string;
  timeImpact: number;
  ownerId: string | null;
  wbsId: string | null;
  costCodeId: string | null;
  status: 'open' | 'closed' | 'occurred';
}

@Injectable()
export class RisksService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
  ) {}

  private async forecaster(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'cost.forecast')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'cost.forecast',
        message: 'This needs the cost forecasting permission.',
      });
  }

  /** The project's team keeps its risks; company risks need cost.forecast. */
  private async keeper(db: Db, claims: TenantClaims, projectId: string | null) {
    if (projectId === null) return this.forecaster(claims);
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team keeps its risks.",
      });
  }

  async scales(db: Db): Promise<Scales> {
    const [s] = await db<Scales[]>`SELECT probability, impact FROM ctl.risk_scale`;
    return s ?? DEFAULT_SCALES;
  }

  async setScales(claims: TenantClaims, scales: Scales) {
    await this.forecaster(claims);
    const levels = (xs: { level: number }[]) => xs.map((x) => x.level).join(',') === '1,2,3,4,5';
    if (!levels(scales.probability) || !levels(scales.impact))
      throw new BadRequestException({ code: 'levels', message: 'Five levels each, 1 to 5.' });
    const pcts = scales.probability.map((p) => p.pct);
    if (pcts.some((p, i) => p <= 0 || p >= 100 || (i > 0 && p <= pcts[i - 1]!)))
      throw new BadRequestException({
        code: 'pcts',
        message: 'Probabilities rise from level 1 to 5, between 0 and 100%.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO ctl.risk_scale (id, probability, impact, updated_by)
        VALUES (true, ${tx.json(scales.probability)}, ${tx.json(scales.impact)}, ${claims.sub})
        ON CONFLICT (id) DO UPDATE SET probability = EXCLUDED.probability, impact = EXCLUDED.impact, updated_at = now(),
          updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'risk.scales', 'risk_scale', claims.sub, {});
    });
    return scales;
  }

  private async check(db: Db, projectId: string | null, input: RiskInput) {
    if (projectId === null && input.wbsId)
      throw new BadRequestException({
        code: 'not_this_project',
        message: 'A company risk has no WBS element.',
      });
    if (input.wbsId) {
      const [w] =
        await db`SELECT 1 FROM proj.wbs WHERE id = ${input.wbsId} AND project_id = ${projectId}`;
      if (!w)
        throw new BadRequestException({
          code: 'not_this_project',
          message: "The WBS element is not this project's.",
        });
    }
  }

  async create(claims: TenantClaims, projectId: string | null, input: RiskInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.keeper(db, claims, projectId);
    await this.check(db, projectId, input);
    const id = await db.begin(async (tx) => {
      if (projectId) await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      else await tx`SELECT pg_advisory_xact_lock(hashtext('company risks'))`;
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int + 1 AS n FROM ctl.risk WHERE project_id IS NOT DISTINCT FROM ${projectId}`;
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO ctl.risk (project_id, number, category, cause, event, effect, probability, impact, cost_impact, time_impact,
          owner_id, wbs_id, cost_code_id, status, created_by)
        VALUES (${projectId}, ${`R-${String(n!.n).padStart(3, '0')}`}, ${input.category}, ${input.cause}, ${input.event},
          ${input.effect}, ${input.probability}, ${input.impact}, ${input.costImpact}, ${input.timeImpact}, ${input.ownerId},
          ${input.wbsId}, ${input.costCodeId}, ${input.status}, ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'risk.create', 'risk', r!.id, { event: input.event });
      return r!.id;
    });
    return { id, ...(await this.register(claims, projectId)) };
  }

  private async riskOf(db: Db, id: string) {
    const [r] = await db<{ project_id: string | null; status: string; row_version: number }[]>`
      SELECT project_id, status, row_version FROM ctl.risk WHERE id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'not_found', message: 'No such risk.' });
    return r;
  }

  async update(claims: TenantClaims, id: string, input: RiskInput & { rowVersion: number }) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.riskOf(db, id);
    await this.keeper(db, claims, r0.project_id);
    await this.check(db, r0.project_id, input);
    const r = await db`
      UPDATE ctl.risk SET category = ${input.category}, cause = ${input.cause}, event = ${input.event}, effect = ${input.effect},
        probability = ${input.probability}, impact = ${input.impact}, cost_impact = ${input.costImpact},
        time_impact = ${input.timeImpact}, owner_id = ${input.ownerId}, wbs_id = ${input.wbsId}, cost_code_id = ${input.costCodeId},
        status = ${input.status}, updated_at = now(), row_version = row_version + 1
      WHERE id = ${id} AND row_version = ${input.rowVersion} RETURNING 1`;
    if (!r.length)
      throw new ConflictException({
        code: 'stale',
        message: 'Someone else changed it; reload and try again.',
      });
    return this.register(claims, r0.project_id);
  }

  async addAction(
    claims: TenantClaims,
    riskId: string,
    input: { action: string; dueOn: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.riskOf(db, riskId);
    await this.keeper(db, claims, r.project_id);
    await db`INSERT INTO ctl.risk_action (risk_id, action, due_on) VALUES (${riskId}, ${input.action}, ${input.dueOn})`;
    return this.register(claims, r.project_id);
  }

  async actionDone(claims: TenantClaims, actionId: string, on: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const [a] = await db<
      { risk_id: string }[]
    >`SELECT risk_id FROM ctl.risk_action WHERE id = ${actionId}`;
    if (!a) throw new NotFoundException({ code: 'not_found', message: 'No such action.' });
    const r = await this.riskOf(db, a.risk_id);
    await this.keeper(db, claims, r.project_id);
    await db`UPDATE ctl.risk_action SET done_on = ${on} WHERE id = ${actionId}`;
    return this.register(claims, r.project_id);
  }

  async setContingency(claims: TenantClaims, projectId: string, held: string) {
    await this.forecaster(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    await db.begin(async (tx) => {
      const [d] = await tx<{ drawn: string }[]>`
        SELECT coalesce(sum(amount), 0)::text AS drawn FROM ctl.contingency_draw WHERE project_id = ${projectId}`;
      if (cents(held) < cents(d!.drawn))
        throw new BadRequestException({
          code: 'below_drawn',
          message: `₹${d!.drawn} is already drawn.`,
        });
      await tx`
        INSERT INTO ctl.contingency (project_id, held, updated_by) VALUES (${projectId}, ${held}, ${claims.sub})
        ON CONFLICT (project_id) DO UPDATE SET held = EXCLUDED.held, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'risk.contingency', 'project', projectId, { held });
    });
    return this.register(claims, projectId);
  }

  /** Drawn against a risk that has occurred, never beyond what remains. */
  async draw(
    claims: TenantClaims,
    riskId: string,
    input: { amount: string; date: string; note: string },
  ) {
    await this.forecaster(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.riskOf(db, riskId);
    if (!r.project_id)
      throw new BadRequestException({
        code: 'company_risk',
        message: "Contingency is a project's.",
      });
    await this.projects.access(db, claims, r.project_id);
    if (r.status !== 'occurred')
      throw new ConflictException({
        code: 'not_occurred',
        message: 'Contingency is drawn against a risk that has occurred.',
      });
    await db.begin(async (tx) => {
      const [c] = await tx<
        { held: string }[]
      >`SELECT held::text FROM ctl.contingency WHERE project_id = ${r.project_id} FOR UPDATE`;
      const [d] = await tx<{ drawn: string }[]>`
        SELECT coalesce(sum(amount), 0)::text AS drawn FROM ctl.contingency_draw WHERE project_id = ${r.project_id}`;
      const left = cents(c?.held ?? '0') - cents(d!.drawn);
      if (cents(input.amount) > left)
        throw new BadRequestException({
          code: 'beyond_contingency',
          message: `Only ₹${fromCents(left)} of contingency remains.`,
        });
      await tx`INSERT INTO ctl.contingency_draw (project_id, risk_id, amount, drawn_on, note, created_by)
        VALUES (${r.project_id}, ${riskId}, ${input.amount}, ${input.date}, ${input.note}, ${claims.sub})`;
      await audit(tx, claims.sub, 'risk.draw', 'risk', riskId, { amount: input.amount });
    });
    return this.register(claims, r.project_id);
  }

  async register(claims: TenantClaims, projectId: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    if (projectId) await this.projects.access(db, claims, projectId);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const scales = await this.scales(db);
    const rows = await db<
      {
        id: string;
        number: string;
        category: string;
        cause: string;
        event: string;
        effect: string;
        probability: number;
        impact: number;
        costImpact: string;
        timeImpact: number;
        owner: string | null;
        ownerId: string | null;
        wbs: string | null;
        status: string;
        rowVersion: number;
      }[]
    >`
      SELECT r.id, r.number, r.category, r.cause, r.event, r.effect, r.probability, r.impact, r.cost_impact::text AS "costImpact",
        r.time_impact AS "timeImpact", u.display_name AS owner, r.owner_id AS "ownerId", w.code AS wbs, r.status,
        r.row_version AS "rowVersion"
      FROM ctl.risk r LEFT JOIN platform."user" u ON u.id = r.owner_id LEFT JOIN proj.wbs w ON w.id = r.wbs_id
      WHERE r.project_id IS NOT DISTINCT FROM ${projectId}`;
    const actions = await db<
      { id: string; riskId: string; action: string; dueOn: string | null; doneOn: string | null }[]
    >`
      SELECT a.id, a.risk_id AS "riskId", a.action, to_char(a.due_on, 'YYYY-MM-DD') AS "dueOn", to_char(a.done_on, 'YYYY-MM-DD') AS "doneOn"
      FROM ctl.risk_action a JOIN ctl.risk r ON r.id = a.risk_id
      WHERE r.project_id IS NOT DISTINCT FROM ${projectId} ORDER BY a.due_on NULLS LAST`;
    const risks = rows
      .map((r) => {
        const s = score(r.probability, r.impact);
        const ev = expectedValue(cents(r.costImpact), r.probability, scales);
        const mine = actions.filter((a) => a.riskId === r.id);
        return {
          ...r,
          score: s,
          band: band(s),
          expectedValue: fromCents(ev),
          ev,
          actions: mine.map((a) => ({ ...a, overdue: !a.doneOn && !!a.dueOn && a.dueOn < today })),
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.ev > a.ev ? 1 : b.ev < a.ev ? -1 : 0) ||
          a.number.localeCompare(b.number),
      );
    const open = risks.filter((r) => r.status === 'open');
    let contingency = null;
    if (projectId) {
      const [c] = await db<
        { held: string }[]
      >`SELECT held::text FROM ctl.contingency WHERE project_id = ${projectId}`;
      const draws = await db<{ risk: string; amount: string; drawnOn: string; note: string }[]>`
        SELECT r.number AS risk, d.amount::text AS amount, to_char(d.drawn_on, 'YYYY-MM-DD') AS "drawnOn", d.note
        FROM ctl.contingency_draw d JOIN ctl.risk r ON r.id = d.risk_id WHERE d.project_id = ${projectId} ORDER BY d.drawn_on`;
      const drawn = draws.reduce((a, d) => a + cents(d.amount), 0n);
      contingency = {
        held: c?.held ?? '0.00',
        drawn: fromCents(drawn),
        remaining: fromCents(cents(c?.held ?? '0') - drawn),
        draws,
      };
    }
    return {
      scales,
      risks: risks.map(({ ev: _ev, ...r }) => r),
      heatMap: heatMap(open),
      top: open.slice(0, 5).map((r) => ({
        number: r.number,
        event: r.event,
        score: r.score,
        band: r.band,
        expectedValue: r.expectedValue,
      })),
      openExpectedValue: fromCents(open.reduce((a, r) => a + r.ev, 0n)),
      contingency,
      mayForecast: await this.permissions.can(claims, 'cost.forecast'),
    };
  }
}
