// Reports (docs/wave1-plan.md step 12, docs/04-features.md E11): the cost summary of a BOQ, the rate analyses
// behind it, and the bid pipeline. Each reads current data on demand and says when ("as of"); Excel versions are
// built from the same figures, and the app prints the same figures as PDF.
//
// Bid values are sensitive: the selected scenario's markups and bid, and the values we submitted, appear only for
// users with `pricing.edit`. What the BOQ itself costs is not: anyone who can open the BOQ sees its rates.
import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { PricingService } from '../pricing/pricing.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, div, fmt } from '../rates/decimal.js';
import { CycleError, TooDeepError, type Costing } from '../rates/engine.js';
import { RatesService } from '../rates/rates.service.js';
import {
  financialYear,
  OPEN_STATUSES,
  TENDER_STATUSES,
  type TenderStatus,
} from '../tender/tender-rules.js';
import { breakdown, type Breakdown } from './cost-breakdown.js';

export interface BoqHead {
  id: string;
  name: string;
  status: string;
  versionNo: number;
  rateDate: string;
  total: string;
  archived: boolean;
  tender: {
    id: string;
    number: string;
    title: string;
    client: string | null;
    estimatedValue: string | null;
  };
}

export interface CostSummary {
  asOf: string;
  boq: BoqHead;
  counts: { items: number; priced: number; unpriced: number; noQty: number; analysed: number };
  sections: { code: string | null; description: string; amount: string; pct: string | null }[];
  unsectioned: { amount: string; items: number };
  /** Items of other kinds: provisional sums (in the total), rate-only items and alternates (not in it). */
  kinds: {
    provisional: { items: number; amount: string };
    rateOnly: { items: number; priced: number };
    alternates: { items: number; value: string };
  };
  /** Items priced in other currencies, per currency: the exposure to its exchange rate. */
  currencies: { code: string; rate: string; items: number; foreignValue: string; value: string }[];
  breakdown: Breakdown;
  /** Analyses with a resource that has no rate on the BOQ's rate date: their split leaves that resource out. */
  incomplete: { code: string; description: string; missing: string[] }[];
  /** The selected scenario priced; null without one, or when the user may not see pricing (`pricingHidden`). */
  bid: {
    scenario: string;
    base: string;
    markups: { label: string; kind: string; pct: string | null; amount: string }[];
    markupTotal: string;
    beforeGst: string;
    gst: string;
    gstMode: string;
    bid: string;
    vsEstimatePct: string | null;
  } | null;
  pricingHidden: boolean;
}

export interface AnalysisReport {
  asOf: string;
  boq: BoqHead;
  analyses: {
    id: string;
    code: string;
    description: string;
    unit: string;
    outputQty: string;
    /** Linked from items of this BOQ (false: only used inside another analysis). */
    direct: boolean;
    items: number;
    qty: string | null;
    lines: {
      lineNo: number;
      kind: 'resource' | 'analysis' | 'lump_sum';
      code: string | null;
      description: string;
      unit: string | null;
      qty: string;
      wastagePct: string;
      unitCost: string | null;
      cost: string;
    }[];
    subtotal: string;
    additions: { label: string; pct: string; amount: string }[];
    total: string;
    unitRate: string;
    boqRate: string;
    missing: string[];
    error: string | null;
  }[];
}

export interface PipelineFilter {
  fy?: string | undefined;
  status?: string | undefined;
  vertical?: string | undefined;
  ownerId?: string | undefined;
}

export interface PipelineRow {
  id: string;
  number: string;
  title: string;
  client: string | null;
  vertical: string;
  status: TenderStatus;
  owner: string | null;
  estimatedValue: string | null;
  emdAmount: string | null;
  submissionDueAt: string | null;
  fy: string;
  ourBid: string | null;
  resultOn: string | null;
  awardedValue: string | null;
  awardedTo: string | null;
}

export interface Pipeline {
  asOf: string;
  filter: PipelineFilter;
  years: string[];
  owners: { id: string; name: string }[];
  rows: PipelineRow[];
  stages: { status: TenderStatus; count: number; estimatedValue: string }[];
  totals: {
    tenders: number;
    open: number;
    pipelineValue: string;
    submittedValue: string | null;
    won: number;
    wonValue: string;
  };
  pricingHidden: boolean;
}

const sum = (xs: (string | null)[]) =>
  fmt(
    xs.reduce((a, x) => a + dec(x ?? '0'), 0n),
    2,
  );

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly rates: RatesService,
    private readonly pricing: PricingService,
  ) {}

  private async head(claims: TenantClaims, boqId: string): Promise<BoqHead> {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db<BoqHead[]>`
      SELECT b.id, b.name, b.status, b.version_no AS "versionNo", b.rate_date::text AS "rateDate",
        b.total::text AS total, b.archived_at IS NOT NULL AS archived,
        json_build_object('id', t.id, 'number', t.number, 'title', t.title, 'client', c.name,
          'estimatedValue', t.estimated_value::text) AS tender
      FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id
      LEFT JOIN platform.party c ON c.id = t.client_id
      WHERE b.id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    return b;
  }

  /** What the BOQ adds up to, by section and by resource kind, and (with the pricing permission) the bid. */
  async costSummary(claims: TenantClaims, boqId: string): Promise<CostSummary> {
    const asOf = new Date().toISOString();
    const boq = await this.head(claims, boqId);
    const db = await this.tenants.forTenant(claims.ten);
    const [counts] = await db<CostSummary['counts'][]>`
      SELECT count(*)::int AS items,
        count(*) FILTER (WHERE rate IS NOT NULL AND coalesce(qty, 0) <> 0)::int AS priced,
        count(*) FILTER (WHERE rate IS NULL AND coalesce(qty, 0) <> 0)::int AS unpriced,
        count(*) FILTER (WHERE coalesce(qty, 0) = 0)::int AS "noQty",
        count(*) FILTER (WHERE rate_analysis_id IS NOT NULL)::int AS analysed
      FROM est.boq_node WHERE boq_id = ${boqId} AND node_type = 'item'`;
    const sections = await db<{ code: string | null; description: string; amount: string }[]>`
      SELECT n.code, t.description, n.subtotal::text AS amount
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ${boqId} AND n.depth = 0 AND n.node_type = 'section' ORDER BY n.sort_key LIMIT 1000`;
    const [loose] = await db<{ amount: string; items: number }[]>`
      SELECT coalesce(sum(amount), 0)::text AS amount, count(*)::int AS items FROM est.boq_node
      WHERE boq_id = ${boqId} AND depth = 0 AND node_type = 'item'`;
    const groups = await db<{ analysisId: string | null; amount: string; provisional: boolean }[]>`
      SELECT rate_analysis_id::text AS "analysisId", coalesce(sum(amount), 0)::text AS amount,
        item_kind = 'provisional' AS provisional
      FROM est.boq_node WHERE boq_id = ${boqId} AND node_type = 'item'
      GROUP BY rate_analysis_id, item_kind = 'provisional'`;
    const [kinds] = await db<
      {
        psItems: number;
        psAmount: string;
        roItems: number;
        roPriced: number;
        altItems: number;
        altValue: string;
      }[]
    >`
      SELECT count(*) FILTER (WHERE item_kind = 'provisional')::int AS "psItems",
        coalesce(sum(amount) FILTER (WHERE item_kind = 'provisional'), 0)::text AS "psAmount",
        count(*) FILTER (WHERE item_kind = 'rate_only')::int AS "roItems",
        count(*) FILTER (WHERE item_kind = 'rate_only' AND rate IS NOT NULL)::int AS "roPriced",
        count(*) FILTER (WHERE item_kind = 'alternate')::int AS "altItems",
        coalesce(sum(round(qty * rate, 2)) FILTER (WHERE item_kind = 'alternate'), 0)::text AS "altValue"
      FROM est.boq_node WHERE boq_id = ${boqId} AND item_kind <> 'normal'`;
    const currencies = await db<CostSummary['currencies']>`
      SELECT c.code, c.rate::text AS rate, count(n.id)::int AS items,
        coalesce(sum(round(n.qty * n.foreign_rate, 2)) FILTER (WHERE n.amount IS NOT NULL), 0)::text AS "foreignValue",
        coalesce(sum(n.amount), 0)::text AS value
      FROM est.boq_currency c
      LEFT JOIN est.boq_node n ON n.boq_id = c.boq_id AND n.foreign_currency = c.code
      WHERE c.boq_id = ${boqId} GROUP BY c.code, c.rate ORDER BY c.code`;

    const ids = groups.map((g) => g.analysisId).filter((x): x is string => x !== null);
    const engine = await this.rates.engineFor(db, ids, boq.rateDate);
    const costed = new Map<string, Costing | null>();
    for (const id of ids) {
      try {
        costed.set(id, engine.hasAnalysis(id) ? engine.cost(id) : null);
      } catch (err) {
        if (!(err instanceof CycleError || err instanceof TooDeepError)) throw err;
        costed.set(id, null);
      }
    }
    const names = ids.length
      ? await db<{ id: string; code: string; description: string }[]>`
          SELECT id::text, code, description FROM est.rate_analysis WHERE id = ANY(${ids}::uuid[])`
      : [];
    const incomplete = names
      .map((a) => ({
        code: a.code,
        description: a.description,
        missing: (costed.get(a.id)?.missing ?? []).map((m) => m.code),
      }))
      .filter((a) => a.missing.length > 0)
      .sort((a, b) => a.code.localeCompare(b.code));

    const total = dec(boq.total);
    const pct = (amount: string) => (total === 0n ? null : fmt(div(dec(amount) * 100n, total), 2));

    const canPrice = await this.permissions.can(claims, 'pricing.edit');
    let bid: CostSummary['bid'] = null;
    if (canPrice) {
      const s = (await this.pricing.summary(claims, boqId)).scenarios.find((x) => x.selected);
      if (s)
        bid = {
          scenario: s.name,
          base: s.result.base,
          markups: s.result.markups.map((m) => ({
            label: m.label,
            kind: m.kind,
            pct: m.pct,
            amount: m.amount,
          })),
          markupTotal: s.result.markupTotal,
          beforeGst: s.result.beforeGst,
          gst: s.result.gst,
          gstMode: s.gstMode,
          bid: s.result.bid,
          vsEstimatePct: s.result.vsEstimatePct,
        };
    }
    return {
      asOf,
      boq,
      counts: counts!,
      sections: sections.map((s) => ({ ...s, pct: pct(s.amount) })),
      unsectioned: { amount: fmt(dec(loose!.amount), 2), items: loose!.items },
      kinds: {
        provisional: { items: kinds!.psItems, amount: fmt(dec(kinds!.psAmount), 2) },
        rateOnly: { items: kinds!.roItems, priced: kinds!.roPriced },
        alternates: { items: kinds!.altItems, value: fmt(dec(kinds!.altValue), 2) },
      },
      currencies: currencies.map((c) => ({
        ...c,
        foreignValue: fmt(dec(c.foreignValue), 2),
        value: fmt(dec(c.value), 2),
      })),
      breakdown: breakdown(groups, (id) => costed.get(id) ?? null),
      incomplete,
      bid,
      pricingHidden: !canPrice,
    };
  }

  /** Every rate analysis behind the BOQ's rates, costed on its rate date, with the sub-analyses they use. */
  async analysisReport(claims: TenantClaims, boqId: string): Promise<AnalysisReport> {
    const asOf = new Date().toISOString();
    const boq = await this.head(claims, boqId);
    const db = await this.tenants.forTenant(claims.ten);
    const used = await db<{ id: string; items: number; qty: string | null }[]>`
      SELECT rate_analysis_id::text AS id, count(*)::int AS items, sum(qty)::text AS qty
      FROM est.boq_node WHERE boq_id = ${boqId} AND rate_analysis_id IS NOT NULL GROUP BY rate_analysis_id`;
    const direct = new Map(used.map((u) => [u.id, u]));
    if (used.length === 0) return { asOf, boq, analyses: [] };
    const engine = await this.rates.engineFor(
      db,
      used.map((u) => u.id),
      boq.rateDate,
    );
    const defs = await db<
      {
        id: string;
        code: string;
        description: string;
        unit: string;
        outputQty: string;
        lines: AnalysisReport['analyses'][number]['lines'] | null;
      }[]
    >`
      WITH RECURSIVE tree(id) AS (
        SELECT unnest(${used.map((u) => u.id)}::uuid[])
        UNION
        SELECT l.sub_analysis_id FROM est.rate_analysis_line l JOIN tree t ON l.analysis_id = t.id
        WHERE l.sub_analysis_id IS NOT NULL
      )
      SELECT a.id::text, a.code, a.description, a.unit, a.output_qty::text AS "outputQty",
        (SELECT json_agg(json_build_object('lineNo', l.line_no, 'kind', l.kind,
            'code', coalesce(r.code, s.code), 'description', coalesce(nullif(l.description, ''), r.name,
              s.description, ''),
            'unit', coalesce(r.unit, s.unit), 'qty', l.qty::text, 'wastagePct', l.wastage_pct::text,
            'amount', l.amount::text) ORDER BY l.line_no)
          FROM est.rate_analysis_line l
          LEFT JOIN est.resource r ON r.id = l.resource_id
          LEFT JOIN est.rate_analysis s ON s.id = l.sub_analysis_id
          WHERE l.analysis_id = a.id) AS lines
      FROM est.rate_analysis a JOIN tree ON tree.id = a.id`;
    const analyses = defs.map((a) => {
      const u = direct.get(a.id);
      let c: Costing | null = null;
      let error: string | null = null;
      try {
        c = engine.cost(a.id);
      } catch (err) {
        if (!(err instanceof CycleError || err instanceof TooDeepError)) throw err;
        error = err.message;
      }
      const costs = new Map(c?.lines.map((l) => [l.lineNo, l]) ?? []);
      return {
        id: a.id,
        code: a.code,
        description: a.description,
        unit: a.unit,
        outputQty: a.outputQty,
        direct: u !== undefined,
        items: u?.items ?? 0,
        qty: u?.qty ?? null,
        lines: (a.lines ?? []).map((l) => ({
          lineNo: l.lineNo,
          kind: l.kind,
          code: l.code,
          description: l.description,
          unit: l.unit,
          qty: l.qty,
          wastagePct: l.wastagePct,
          unitCost: costs.get(l.lineNo)?.unitCost ?? null,
          cost: costs.get(l.lineNo)?.cost ?? '0.00',
        })),
        subtotal: c?.subtotal ?? '0.00',
        additions: c?.additions ?? [],
        total: c?.total ?? '0.00',
        unitRate: c?.unitRate ?? '0.0000',
        boqRate: c?.boqRate ?? '0.00',
        missing: (c?.missing ?? []).map((m) => m.code),
        error,
      };
    });
    analyses.sort(
      (a, b) =>
        Number(b.direct) - Number(a.direct) ||
        a.code.localeCompare(b.code, 'en', { numeric: true }),
    );
    return { asOf, boq, analyses };
  }

  /** Tenders by stage with their values and dates, filtered by financial year (of the due date), vertical, owner. */
  async pipeline(claims: TenantClaims, f: PipelineFilter): Promise<Pipeline> {
    const asOf = new Date().toISOString();
    const db = await this.tenants.forTenant(claims.ten);
    const canPrice = await this.permissions.can(claims, 'pricing.edit');
    const all = await db<
      (Omit<PipelineRow, 'fy' | 'submissionDueAt'> & {
        submissionDueAt: Date | null;
        at: Date;
        ownerId: string | null;
      })[]
    >`
      SELECT t.id, t.number, t.title, c.name AS client, t.vertical, t.status, u.display_name AS owner,
        t.owner_id AS "ownerId", t.estimated_value::text AS "estimatedValue", t.emd_amount::text AS "emdAmount",
        t.submission_due_at AS "submissionDueAt", coalesce(t.submission_due_at, t.created_at) AS at,
        (SELECT s.bid_value::text FROM tender.submission s WHERE s.tender_id = t.id AND s.bid_value IS NOT NULL
          ORDER BY s.submitted_at DESC LIMIT 1) AS "ourBid",
        to_char(t.result_on, 'YYYY-MM-DD') AS "resultOn", t.awarded_value::text AS "awardedValue",
        w.name AS "awardedTo"
      FROM tender.tender t
      LEFT JOIN platform.party c ON c.id = t.client_id
      LEFT JOIN platform.party w ON w.id = t.awarded_to
      LEFT JOIN platform."user" u ON u.id = t.owner_id
      ORDER BY t.submission_due_at DESC NULLS LAST, t.number`;
    const years = [...new Set(all.map((r) => financialYear(r.at)))].sort().reverse();
    const owners = [
      ...new Map(
        all.filter((r) => r.ownerId).map((r) => [r.ownerId!, { id: r.ownerId!, name: r.owner! }]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name));
    const rows: PipelineRow[] = all
      .filter(
        (r) =>
          (!f.fy || financialYear(r.at) === f.fy) &&
          (!f.vertical || r.vertical === f.vertical) &&
          (!f.ownerId || r.ownerId === f.ownerId) &&
          (!f.status ||
            f.status === 'all' ||
            (f.status === 'open' ? OPEN_STATUSES.includes(r.status) : r.status === f.status)),
      )
      .map(({ at, ownerId: _o, submissionDueAt, ...r }) => ({
        ...r,
        submissionDueAt: submissionDueAt ? submissionDueAt.toISOString() : null,
        fy: financialYear(at),
        ourBid: canPrice ? r.ourBid : null,
      }));
    const open = rows.filter((r) => OPEN_STATUSES.includes(r.status));
    const won = rows.filter((r) => r.status === 'won');
    return {
      asOf,
      filter: f,
      years,
      owners,
      rows,
      stages: TENDER_STATUSES.map((status) => {
        const rs = rows.filter((r) => r.status === status);
        return { status, count: rs.length, estimatedValue: sum(rs.map((r) => r.estimatedValue)) };
      }),
      totals: {
        tenders: rows.length,
        open: open.length,
        pipelineValue: sum(open.map((r) => r.estimatedValue)),
        submittedValue: canPrice ? sum(rows.map((r) => r.ourBid)) : null,
        won: won.length,
        wonValue: sum(won.map((r) => r.awardedValue ?? r.ourBid)),
      },
      pricingHidden: !canPrice,
    };
  }
}
