// Dashboard tiles (docs/08-dashboard.md §2.6): three fixed headline numbers per dashboard, and a catalogue each user
// adds from. Every tile is a built-in query: one aggregate over indexed tables, so a dashboard stays well inside the
// 300 ms rule; none is a user-written formula. A tile that shows bid values is marked `pricing` and offered only to
// users with the pricing permission.
import type { PendingQuery, Row, Sql } from 'postgres';

export type DashboardName = 'tender' | 'estimation';
export const DASHBOARDS: DashboardName[] = ['tender', 'estimation'];

export interface DashboardFilter {
  /** Indian financial year, "2026-27": for tiles about results and submissions. */
  fy: string;
  vertical?: string | undefined;
  ownerId?: string | undefined;
}

export interface TileValue {
  value: string;
  kind: 'count' | 'money' | 'pct';
  /** A second line: "₹12.5 L in 3 guarantees". */
  detail?: string | undefined;
  tone?: 'danger' | 'warning' | undefined;
  /** Where clicking the tile goes in the app (drill-down). */
  link?: string | undefined;
}

interface TileContext {
  db: Sql;
  f: DashboardFilter;
  now: Date;
  /** fy start and end, as instants. */
  from: string;
  to: string;
  /** "AND t.vertical = … AND t.owner_id = …" on tender.tender t. */
  scope: PendingQuery<Row[]>;
}

export interface TileDef {
  key: string;
  dashboard: DashboardName;
  label: string;
  hint: string;
  fixed?: boolean;
  pricing?: boolean;
  compute: (c: TileContext) => Promise<TileValue>;
}

const OPEN = ['lead', 'evaluating', 'bidding', 'submitted'];
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const fyQuery = (f: DashboardFilter) => `fy=${f.fy}`;
const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
export const inr = (v: string) => INR.format(Number(v));
/** "14 Oct", in IST. */
const shortDate = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

async function one<T>(q: Promise<T[]>): Promise<T> {
  const [row] = await q;
  return row!;
}

const count = (n: number, link?: string, extra: Partial<TileValue> = {}): TileValue => ({
  value: String(n),
  kind: 'count',
  link,
  ...extra,
});

/** The draft BOQs of open tenders: what the estimation dashboard calls "in progress". */
const inProgress = (c: TileContext) => c.db`
  SELECT b.id, b.total, b.rate_date FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id
  WHERE b.status = 'draft' AND b.archived_at IS NULL AND t.status IN ${c.db(OPEN)} ${c.scope}`;

export const TILES: TileDef[] = [
  // --- tender and bid: the three fixed (decision 08-dashboard.md §4.1) ---
  {
    key: 'deadlines',
    dashboard: 'tender',
    label: 'Submissions due in 14 days',
    hint: 'Tenders not yet submitted whose submission is due in the next 14 days',
    fixed: true,
    compute: async (c) => {
      const r = await one(c.db<{ n: number; first: Date | null }[]>`
        SELECT count(*)::int AS n, min(t.submission_due_at) AS first FROM tender.tender t
        WHERE t.status IN ('lead', 'evaluating', 'bidding')
          AND t.submission_due_at BETWEEN ${c.now} AND ${addDays(c.now, 14)} ${c.scope}`);
      return count(r.n, '/tenders', {
        tone:
          r.n > 0 && r.first && r.first.getTime() - c.now.getTime() < 3 * 86_400_000
            ? 'danger'
            : undefined,
        detail: r.first ? `next on ${shortDate(r.first)}` : undefined,
      });
    },
  },
  {
    key: 'pipeline_value',
    dashboard: 'tender',
    label: 'Pipeline value',
    hint: "The client's estimates of all open tenders (lead to submitted)",
    fixed: true,
    compute: async (c) => {
      const r = await one(c.db<{ v: string; n: number }[]>`
        SELECT round(coalesce(sum(t.estimated_value), 0), 2)::text AS v, count(*)::int AS n FROM tender.tender t
        WHERE t.status IN ${c.db(OPEN)} ${c.scope}`);
      return {
        value: r.v,
        kind: 'money',
        detail: `${r.n} open tender${r.n === 1 ? '' : 's'}`,
        link: '/reports/pipeline?status=open',
      };
    },
  },
  {
    key: 'security_expiries',
    dashboard: 'tender',
    label: 'EMD/BG expiring in 30 days',
    hint: 'Bank guarantees, FDRs and bonds still with the client that expire in 30 days or have expired',
    fixed: true,
    compute: async (c) => {
      const r = await one(c.db<{ n: number; amount: string; expired: number }[]>`
        SELECT count(*)::int AS n, round(coalesce(sum(s.amount), 0), 2)::text AS amount,
          count(*) FILTER (WHERE s.valid_until < ${day(c.now)}::date)::int AS expired
        FROM tender.security_instrument s JOIN tender.tender t ON t.id = s.tender_id
        WHERE s.status IN ('issued', 'submitted') AND s.form IN ('bank_guarantee', 'fdr', 'insurance_bond')
          AND s.valid_until <= ${day(addDays(c.now, 30))}::date ${c.scope}`);
      return count(r.n, '/', {
        tone: r.expired > 0 ? 'danger' : r.n > 0 ? 'warning' : undefined,
        detail: r.n
          ? `${inr(r.amount)}${r.expired ? `, ${r.expired} already expired` : ''}`
          : undefined,
      });
    },
  },
  // --- tender and bid: catalogue ---
  {
    key: 'open_tenders',
    dashboard: 'tender',
    label: 'Open tenders',
    hint: 'Lead, evaluating, bidding and submitted',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(*)::int AS n FROM tender.tender t WHERE t.status IN ${c.db(OPEN)} ${c.scope}`)
        ).n,
        '/reports/pipeline?status=open',
      ),
  },
  {
    key: 'bidding_now',
    dashboard: 'tender',
    label: 'Bids being prepared',
    hint: 'Tenders decided "bid" and not yet submitted',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(*)::int AS n FROM tender.tender t WHERE t.status = 'bidding' ${c.scope}`)
        ).n,
        '/reports/pipeline?status=bidding',
      ),
  },
  {
    key: 'prebid_14d',
    dashboard: 'tender',
    label: 'Pre-bid meetings in 14 days',
    hint: 'Pre-bid meetings of open tenders in the next 14 days',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(*)::int AS n FROM tender.tender t WHERE t.status IN ('lead', 'evaluating', 'bidding')
              AND t.prebid_at BETWEEN ${c.now} AND ${addDays(c.now, 14)} ${c.scope}`)
        ).n,
        '/',
      ),
  },
  {
    key: 'queries_unanswered',
    dashboard: 'tender',
    label: 'Pre-bid queries unanswered',
    hint: 'Queries sent to clients without an answer yet, on open tenders',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(*)::int AS n FROM tender.query q JOIN tender.tender t ON t.id = q.tender_id
            WHERE q.status = 'sent' AND t.status IN ${c.db(OPEN)} ${c.scope}`)
        ).n,
      ),
  },
  {
    key: 'securities_to_return',
    dashboard: 'tender',
    label: 'EMD to get back',
    hint: 'EMD still with clients on tenders lost, withdrawn, cancelled or not bid',
    compute: async (c) => {
      const r = await one(c.db<{ n: number; amount: string }[]>`
        SELECT count(*)::int AS n, round(coalesce(sum(s.amount), 0), 2)::text AS amount
        FROM tender.security_instrument s JOIN tender.tender t ON t.id = s.tender_id
        WHERE s.purpose = 'emd' AND s.status IN ('issued', 'submitted')
          AND t.status IN ('lost', 'withdrawn', 'cancelled', 'no_bid') ${c.scope}`);
      return count(r.n, undefined, {
        detail: r.n ? inr(r.amount) : undefined,
        tone: r.n ? 'warning' : undefined,
      });
    },
  },
  {
    key: 'submitted_fy',
    dashboard: 'tender',
    label: 'Bids submitted this year',
    hint: 'Tenders submitted in the financial year chosen',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(DISTINCT t.id)::int AS n FROM tender.tender t JOIN tender.submission s ON s.tender_id = t.id
            WHERE s.kind = 'original' AND s.submitted_at >= ${c.from} AND s.submitted_at < ${c.to} ${c.scope}`)
        ).n,
        `/reports/pipeline?${fyQuery(c.f)}`,
      ),
  },
  {
    key: 'win_rate_fy',
    dashboard: 'tender',
    label: 'Win rate this year',
    hint: 'Won ÷ (won + lost), by count, for results recorded in the financial year chosen',
    compute: async (c) => {
      const r = await one(c.db<{ won: number; lost: number }[]>`
        SELECT count(*) FILTER (WHERE t.status = 'won')::int AS won,
          count(*) FILTER (WHERE t.status = 'lost')::int AS lost
        FROM tender.tender t WHERE t.status IN ('won', 'lost')
          AND coalesce(t.result_on::timestamptz, t.updated_at) >= ${c.from}
          AND coalesce(t.result_on::timestamptz, t.updated_at) < ${c.to} ${c.scope}`);
      const decided = r.won + r.lost;
      return {
        value: decided ? ((r.won / decided) * 100).toFixed(1) : '',
        kind: 'pct',
        detail: `${r.won} won of ${decided}`,
        link: '/tenders/win-loss',
      };
    },
  },
  {
    key: 'won_value_fy',
    dashboard: 'tender',
    label: 'Work won this year',
    hint: 'Contract values awarded to us, for results recorded in the financial year chosen',
    compute: async (c) => {
      const r = await one(c.db<{ v: string; n: number }[]>`
        SELECT round(coalesce(sum(t.awarded_value), 0), 2)::text AS v, count(*)::int AS n FROM tender.tender t
        WHERE t.status = 'won' AND coalesce(t.result_on::timestamptz, t.updated_at) >= ${c.from}
          AND coalesce(t.result_on::timestamptz, t.updated_at) < ${c.to} ${c.scope}`);
      return {
        value: r.v,
        kind: 'money',
        detail: `${r.n} tender${r.n === 1 ? '' : 's'}`,
        link: `/reports/pipeline?status=won`,
      };
    },
  },
  {
    key: 'bid_value_fy',
    dashboard: 'tender',
    label: 'Value bid this year',
    hint: 'Our latest bid value of each tender submitted in the financial year chosen',
    pricing: true,
    compute: async (c) => {
      const r = await one(c.db<{ v: string }[]>`
        SELECT round(coalesce(sum(x.v), 0), 2)::text AS v FROM (
          SELECT (SELECT s2.bid_value FROM tender.submission s2 WHERE s2.tender_id = t.id
            AND s2.bid_value IS NOT NULL ORDER BY s2.submitted_at DESC LIMIT 1) AS v
          FROM tender.tender t WHERE EXISTS (SELECT 1 FROM tender.submission s WHERE s.tender_id = t.id
            AND s.kind = 'original' AND s.submitted_at >= ${c.from} AND s.submitted_at < ${c.to}) ${c.scope}) x`);
      return { value: r.v, kind: 'money', link: `/reports/pipeline?${fyQuery(c.f)}` };
    },
  },
  {
    key: 'rfqs_open',
    dashboard: 'tender',
    label: 'Enquiries awaiting quotes',
    hint: 'RFQs sent to vendors and not closed, with how many quotes are in',
    compute: async (c) => {
      const r = await one(c.db<{ n: number; vendors: number; quoted: number }[]>`
        SELECT count(DISTINCT r.id)::int AS n, count(v.party_id)::int AS vendors,
          count(v.party_id) FILTER (WHERE v.status = 'quoted')::int AS quoted
        FROM tender.rfq r JOIN tender.tender t ON t.id = r.tender_id
        LEFT JOIN tender.rfq_vendor v ON v.rfq_id = r.id
        WHERE r.status = 'sent' ${c.scope}`);
      return count(r.n, undefined, {
        detail: r.vendors ? `${r.quoted} of ${r.vendors} vendors quoted` : undefined,
      });
    },
  },

  // --- estimation: the three fixed ---
  {
    key: 'boqs_in_progress',
    dashboard: 'estimation',
    label: 'BOQs in progress',
    hint: 'Draft BOQs of open tenders',
    fixed: true,
    compute: async (c) =>
      count(
        (await one(c.db<{ n: number }[]>`SELECT count(*)::int AS n FROM (${inProgress(c)}) b`)).n,
      ),
  },
  {
    key: 'estimate_value',
    dashboard: 'estimation',
    label: 'Value being estimated',
    hint: 'The current totals of the BOQs in progress, before markups',
    fixed: true,
    compute: async (c) => ({
      value: (
        await one(
          c.db<
            { v: string }[]
          >`SELECT round(coalesce(sum(b.total), 0), 2)::text AS v FROM (${inProgress(c)}) b`,
        )
      ).v,
      kind: 'money',
    }),
  },
  {
    key: 'items_unpriced',
    dashboard: 'estimation',
    label: 'Items not priced',
    hint: 'Items with a quantity and no rate, in the BOQs in progress',
    fixed: true,
    compute: async (c) => {
      const r = await one(c.db<{ n: number; boqs: number }[]>`
        SELECT count(*)::int AS n, count(DISTINCT n.boq_id)::int AS boqs FROM est.boq_node n
        WHERE n.boq_id IN (SELECT id FROM (${inProgress(c)}) b) AND n.node_type = 'item' AND n.rate IS NULL
          AND coalesce(n.qty, 0) <> 0`);
      return count(r.n, undefined, {
        tone: r.n ? 'warning' : undefined,
        detail: r.n ? `in ${r.boqs} BOQ${r.boqs === 1 ? '' : 's'}` : undefined,
      });
    },
  },
  // --- estimation: catalogue ---
  {
    key: 'rate_changes_30d',
    dashboard: 'estimation',
    label: 'Resource rates added, 30 days',
    hint: 'New rates entered in the resource library in the last 30 days',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(*)::int AS n FROM est.resource_rate WHERE created_at >= ${addDays(c.now, -30)}`)
        ).n,
        '/resources',
      ),
  },
  {
    key: 'analyses_changed_30d',
    dashboard: 'estimation',
    label: 'Rate analyses changed, 30 days',
    hint: 'Rate analyses created or edited in the last 30 days',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(*)::int AS n FROM est.rate_analysis WHERE updated_at >= ${addDays(c.now, -30)}`)
        ).n,
        '/rate-analyses',
      ),
  },
  {
    key: 'resources_without_rate',
    dashboard: 'estimation',
    label: 'Resources without a rate',
    hint: 'Active resources with no rate effective today',
    compute: async (c) => {
      const n = (
        await one(c.db<{ n: number }[]>`
          SELECT count(*)::int AS n FROM est.resource r WHERE r.active AND NOT EXISTS (
            SELECT 1 FROM est.resource_rate rr WHERE rr.resource_id = r.id AND rr.effective_from <= ${day(c.now)}::date)`)
      ).n;
      return count(n, '/resources', { tone: n ? 'warning' : undefined });
    },
  },
  {
    key: 'versions_frozen_30d',
    dashboard: 'estimation',
    label: 'Versions frozen, 30 days',
    hint: 'BOQ versions frozen (submitted or internal) in the last 30 days',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(*)::int AS n FROM est.boq_version v JOIN est.boq b ON b.id = v.boq_id
            JOIN tender.tender t ON t.id = b.tender_id WHERE v.frozen_at >= ${addDays(c.now, -30)} ${c.scope}`)
        ).n,
      ),
  },
  {
    key: 'quotes_received_30d',
    dashboard: 'estimation',
    label: 'Vendor quotes received, 30 days',
    hint: 'Quotes received against RFQs in the last 30 days',
    compute: async (c) =>
      count(
        (
          await one(c.db<{ n: number }[]>`
            SELECT count(*)::int AS n FROM tender.rfq_quote q JOIN tender.rfq r ON r.id = q.rfq_id
            JOIN tender.tender t ON t.id = r.tender_id
            WHERE q.received_on >= ${day(addDays(c.now, -30))}::date ${c.scope}`)
        ).n,
      ),
  },
];

export const tilesOf = (d: DashboardName) => TILES.filter((t) => t.dashboard === d);
export const tileByKey = new Map(TILES.map((t) => [t.key, t]));

/** "2026-27" → its first and last instants (IST). */
export function fyRange(fy: string): { from: string; to: string } {
  const y = Number(fy.slice(0, 4));
  return { from: `${y}-04-01T00:00:00+05:30`, to: `${y + 1}-04-01T00:00:00+05:30` };
}
