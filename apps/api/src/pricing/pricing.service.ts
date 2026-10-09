// Bid pricing (docs/wave1-plan.md step 6): pricing scenarios per BOQ, the BOQ and tender bid summaries, and the
// factor that loads item rates for an item-rate submission.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { refuseArchived } from '../boq/archived.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, div, fmt, mul } from '../rates/decimal.js';
import { priceBid, type GstMode, type Markup, type Priced } from './pricing.js';

export interface ScenarioInput {
  name: string;
  notes: string;
  markups: Markup[];
  gstPct: string;
  gstMode: GstMode;
}

interface ScenarioRow {
  id: string;
  boqId: string;
  name: string;
  notes: string;
  markups: Markup[];
  gstPct: string;
  gstMode: GstMode;
  selected: boolean;
  rowVersion: number;
  updatedAt: Date;
}

const SCENARIO = `s.id, s.boq_id AS "boqId", s.name, s.notes, s.markups, s.gst_pct::text AS "gstPct",
  s.gst_mode AS "gstMode", s.selected, s.row_version AS "rowVersion", s.updated_at AS "updatedAt"`;

function friendly(err: unknown): never {
  if ((err as { code?: string }).code === '23505')
    throw new ConflictException({
      code: 'name_taken',
      message: 'This BOQ already has a scenario with that name.',
    });
  throw err;
}

@Injectable()
export class PricingService {
  constructor(private readonly tenants: TenantConnections) {}

  /** Everything the pricing screen needs: base, warnings, sections and every scenario priced. */
  async summary(claims: TenantClaims, boqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db<
      {
        id: string;
        name: string;
        status: string;
        total: string;
        tender: { id: string; number: string; title: string; estimatedValue: string | null };
      }[]
    >`
      SELECT b.id, b.name, b.status, b.total::text AS total,
        json_build_object('id', t.id, 'number', t.number, 'title', t.title,
          'estimatedValue', t.estimated_value::text) AS tender
      FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id WHERE b.id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    const [counts] = await db<
      { items: number; unpriced: number; noQty: number; measured: number }[]
    >`
      SELECT count(*) FILTER (WHERE node_type = 'item')::int AS items,
        count(*) FILTER (WHERE node_type = 'item' AND rate IS NULL AND coalesce(qty, 0) <> 0)::int AS unpriced,
        count(*) FILTER (WHERE node_type = 'item' AND coalesce(qty, 0) = 0)::int AS "noQty",
        count(*) FILTER (WHERE measured)::int AS measured
      FROM est.boq_node WHERE boq_id = ${boqId}`;
    const sections = await db`
      SELECT n.id::text AS id, n.code, t.description, n.subtotal::text AS subtotal, n.child_count AS "childCount"
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ${boqId} AND n.depth = 0 AND n.node_type = 'section' ORDER BY n.sort_key LIMIT 500`;
    const [loose] = await db<{ amount: string; items: number }[]>`
      SELECT coalesce(sum(amount), 0)::text AS amount, count(*)::int AS items FROM est.boq_node
      WHERE boq_id = ${boqId} AND depth = 0 AND node_type = 'item'`;
    const scenarios = await this.scenarios(db, boqId);
    const priced = scenarios.map((s) => ({
      ...s,
      result: priceBid(b.total, s, b.tender.estimatedValue),
    }));
    const selected = priced.find((s) => s.selected);
    return {
      boq: { id: b.id, name: b.name, status: b.status, base: b.total },
      tender: b.tender,
      counts: counts!,
      sections,
      unsectioned: loose!,
      scenarios: priced,
      // What an item-rate submission adds up to once each loaded rate is rounded to paise.
      quoted: selected ? await this.quotedTotal(db, boqId, selected.result) : null,
    };
  }

  private async quotedTotal(db: Sql, boqId: string, p: Priced) {
    const [q] = await db<{ total: string }[]>`
      SELECT coalesce(sum(round(qty * round(rate * ${p.factor}::numeric, 2), 2)), 0)::text AS total
      FROM est.boq_node WHERE boq_id = ${boqId} AND node_type = 'item' AND rate IS NOT NULL AND qty IS NOT NULL`;
    return {
      factor: p.factor,
      total: q!.total,
      difference: fmt(dec(q!.total) - dec(p.beforeGst), 2),
    };
  }

  private scenarios(db: Sql | TransactionSql, boqId: string) {
    return db<ScenarioRow[]>`SELECT ${db.unsafe(SCENARIO)} FROM est.pricing_scenario s
      WHERE s.boq_id = ${boqId} ORDER BY s.created_at`;
  }

  /** Prices an unsaved scenario: the editor's live totals. */
  async preview(claims: TenantClaims, boqId: string, input: ScenarioInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db<{ total: string; estimate: string | null }[]>`
      SELECT b.total::text AS total, t.estimated_value::text AS estimate
      FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id WHERE b.id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    return priceBid(b.total, input, b.estimate);
  }

  async create(claims: TenantClaims, boqId: string, input: ScenarioInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        await draftOnly(tx, boqId);
        // The first scenario of a BOQ becomes its bid until another is selected.
        const [current] = await tx`
          SELECT 1 FROM est.pricing_scenario WHERE boq_id = ${boqId} AND selected`;
        const n = current ? 1 : 0;
        const [s] = await tx<{ id: string }[]>`
          INSERT INTO est.pricing_scenario (boq_id, name, notes, markups, gst_pct, gst_mode, selected,
            created_by, updated_by)
          VALUES (${boqId}, ${input.name}, ${input.notes}, ${tx.json(toJson(input.markups))}, ${input.gstPct},
            ${input.gstMode}, ${n === 0}, ${claims.sub}, ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'pricing.create', s!.id, { boqId, name: input.name });
      })
      .catch(friendly);
    return this.summary(claims, boqId);
  }

  async update(claims: TenantClaims, id: string, rowVersion: number, input: ScenarioInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const boqId = await db
      .begin(async (tx) => {
        await draftOnly(tx, null, id);
        const [s] = await tx<{ boq_id: string }[]>`
          UPDATE est.pricing_scenario SET name = ${input.name}, notes = ${input.notes},
            markups = ${tx.json(toJson(input.markups))}, gst_pct = ${input.gstPct}, gst_mode = ${input.gstMode},
            updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
          WHERE id = ${id} AND row_version = ${rowVersion} RETURNING boq_id`;
        if (!s) await this.stale(tx, id);
        await audit(tx, claims.sub, 'pricing.update', id, { name: input.name });
        return s!.boq_id;
      })
      .catch(friendly);
    return this.summary(claims, boqId);
  }

  /** Marks the scenario as the bid for its BOQ (and no other). */
  async select(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const boqId = await db.begin(async (tx) => {
      const [s] = await tx<{ boq_id: string }[]>`
        SELECT boq_id FROM est.pricing_scenario WHERE id = ${id}`;
      if (!s) throw new NotFoundException({ code: 'scenario_not_found' });
      await draftOnly(tx, s.boq_id);
      await tx`UPDATE est.pricing_scenario SET selected = false, row_version = row_version + 1
        WHERE boq_id = ${s.boq_id} AND selected AND id <> ${id}`;
      await tx`UPDATE est.pricing_scenario SET selected = true, row_version = row_version + 1,
          updated_at = now(), updated_by = ${claims.sub}
        WHERE id = ${id} AND NOT selected`;
      await audit(tx, claims.sub, 'pricing.select', id, { boqId: s.boq_id });
      return s.boq_id;
    });
    return this.summary(claims, boqId);
  }

  async copy(claims: TenantClaims, id: string, name: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const boqId = await db
      .begin(async (tx) => {
        await draftOnly(tx, null, id);
        const [s] = await tx<{ id: string; boq_id: string }[]>`
          INSERT INTO est.pricing_scenario (boq_id, name, notes, markups, gst_pct, gst_mode, created_by,
            updated_by)
          SELECT boq_id, ${name}, notes, markups, gst_pct, gst_mode, ${claims.sub}, ${claims.sub}
          FROM est.pricing_scenario WHERE id = ${id} RETURNING id, boq_id`;
        if (!s) throw new NotFoundException({ code: 'scenario_not_found' });
        await audit(tx, claims.sub, 'pricing.copy', s.id, { from: id, name });
        return s.boq_id;
      })
      .catch(friendly);
    return this.summary(claims, boqId);
  }

  async remove(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const boqId = await db.begin(async (tx) => {
      await draftOnly(tx, null, id);
      const [s] = await tx<{ boq_id: string; name: string }[]>`
        DELETE FROM est.pricing_scenario WHERE id = ${id} RETURNING boq_id, name`;
      if (!s) throw new NotFoundException({ code: 'scenario_not_found' });
      await audit(tx, claims.sub, 'pricing.delete', id, { boqId: s.boq_id, name: s.name });
      return s.boq_id;
    });
    return this.summary(claims, boqId);
  }

  /** The bid for a whole tender: each BOQ priced by its selected scenario, against the client's estimate. */
  async tenderSummary(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db<{ estimatedValue: string | null }[]>`
      SELECT estimated_value::text AS "estimatedValue" FROM tender.tender WHERE id = ${tenderId}`;
    if (!t) throw new NotFoundException({ code: 'tender_not_found' });
    const boqs = await db<
      { id: string; name: string; total: string; unpriced: number; scenario: ScenarioRow | null }[]
    >`
      SELECT b.id, b.name, b.total::text AS total,
        (SELECT count(*)::int FROM est.boq_node n WHERE n.boq_id = b.id AND n.node_type = 'item'
          AND n.rate IS NULL AND coalesce(n.qty, 0) <> 0) AS unpriced,
        (SELECT row_to_json(x) FROM (SELECT ${db.unsafe(SCENARIO)} FROM est.pricing_scenario s
          WHERE s.boq_id = b.id AND s.selected) x) AS scenario
      FROM est.boq b WHERE b.tender_id = ${tenderId} AND b.archived_at IS NULL ORDER BY b.created_at`;
    const lines = boqs.map((b) => {
      const p = b.scenario ? priceBid(b.total, b.scenario) : null;
      return {
        id: b.id,
        name: b.name,
        base: b.total,
        unpriced: b.unpriced,
        scenario: b.scenario ? { id: b.scenario.id, name: b.scenario.name } : null,
        beforeGst: p?.beforeGst ?? null,
        gst: p?.gst ?? null,
        bid: p?.bid ?? null,
      };
    });
    const sum = (f: (l: (typeof lines)[number]) => string | null) =>
      fmt(
        lines.reduce((s, l) => s + dec(f(l) ?? '0'), 0n),
        2,
      );
    const beforeGst = sum((l) => l.beforeGst);
    const est = t.estimatedValue ? dec(t.estimatedValue) : 0n;
    return {
      estimatedValue: t.estimatedValue,
      boqs: lines,
      base: sum((l) => l.base),
      beforeGst,
      gst: sum((l) => l.gst),
      bid: sum((l) => l.bid),
      complete: lines.length > 0 && lines.every((l) => l.scenario !== null),
      vsEstimatePct:
        est > 0n && lines.some((l) => l.scenario)
          ? fmt(div(mul(dec(beforeGst) - est, dec('100')), est), 2)
          : null,
    };
  }

  /** The selected (or given) scenario's factor, for exporting loaded item rates. */
  async factorFor(claims: TenantClaims, boqId: string, scenarioId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<(ScenarioRow & { total: string })[]>`
      SELECT ${db.unsafe(SCENARIO)}, b.total::text AS total FROM est.pricing_scenario s
      JOIN est.boq b ON b.id = s.boq_id WHERE s.id = ${scenarioId} AND s.boq_id = ${boqId}`;
    if (!s) throw new BadRequestException({ code: 'scenario_not_found' });
    return { name: s.name, factor: priceBid(s.total, s).factor };
  }

  private async stale(tx: TransactionSql, id: string): Promise<never> {
    const [exists] = await tx`SELECT 1 FROM est.pricing_scenario WHERE id = ${id}`;
    if (!exists) throw new NotFoundException({ code: 'scenario_not_found' });
    throw new ConflictException({
      code: 'stale_row',
      message: 'Someone else changed this scenario. Reload.',
    });
  }
}

/**
 * Pricing changes only while the BOQ is a draft: a frozen version keeps the bid it was frozen with (the version
 * record holds that scenario priced). Locks the BOQ row, so changes serialise with freezing.
 */
async function draftOnly(tx: TransactionSql, boqId: string | null, scenarioId?: string) {
  const [b] = boqId
    ? await tx<{ status: string; archived: boolean; version_no: number }[]>`
        SELECT status, archived_at IS NOT NULL AS archived, version_no FROM est.boq
        WHERE id = ${boqId} FOR UPDATE`
    : await tx<{ status: string; archived: boolean; version_no: number }[]>`
        SELECT b.status, b.archived_at IS NOT NULL AS archived, b.version_no
        FROM est.boq b JOIN est.pricing_scenario s ON s.boq_id = b.id
        WHERE s.id = ${scenarioId!} FOR UPDATE OF b`;
  if (!b) throw new NotFoundException({ code: boqId ? 'boq_not_found' : 'scenario_not_found' });
  refuseArchived(b);
  if (b.status !== 'draft')
    throw new ConflictException({
      code: 'boq_locked',
      message: `Version ${b.version_no} is frozen with its bid. Start a new revision to change pricing.`,
    });
}

const toJson = (markups: Markup[]) =>
  markups.map((m) => ({
    kind: m.kind,
    label: m.label,
    basis: m.basis,
    pct: m.pct ?? null,
    amount: m.amount ?? null,
  }));

async function audit(
  tx: TransactionSql,
  actorId: string,
  action: string,
  id: string,
  data: Record<string, unknown>,
) {
  await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
    VALUES (${actorId}, ${action}, 'pricing_scenario', ${id}, ${tx.json(JSON.parse(JSON.stringify(data)))})`;
}
