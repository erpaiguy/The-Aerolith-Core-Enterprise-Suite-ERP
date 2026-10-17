// Schedule-of-rates tendering (docs/wave8-plan.md step 8f.2). The company's own copies of schedules of rates (CPWD
// DSR, a state PWD's SOR), imported from its spreadsheet: none is shipped with the app. Estimate items cite an SOR
// item and take its rate; a percentage-rate tender is quoted at so many percent above or below that estimate; the
// item-wise comparative sets each bidder's item rates side by side; and past percentage tenders show where the
// winning percentages fell and how often each competitor came lowest.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { TenantClaims } from '../auth/auth.service.js';
import { BoqService, type Op } from '../boq/boq.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from './tender-records.js';

export const SOR_MAX = 10 * 1024 * 1024;
const HEADERS: Record<string, 'code' | 'description' | 'unit' | 'rate' | 'chapter'> = {
  code: 'code',
  'item no': 'code',
  'item no.': 'code',
  'sr no': 'code',
  description: 'description',
  'description of item': 'description',
  item: 'description',
  unit: 'unit',
  rate: 'rate',
  'rate (rs)': 'rate',
  'rate (₹)': 'rate',
  chapter: 'chapter',
  'sub head': 'chapter',
};

/** The rows of an SOR workbook's first sheet, by its header row (code, description, unit, rate; chapter if any). */
export async function readSorWorkbook(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException({
      code: 'not_xlsx',
      message: 'This file could not be read as an Excel workbook. Save it as .xlsx and try again.',
    });
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new BadRequestException({ code: 'empty', message: 'The workbook has no sheet.' });
  const cell = (v: ExcelJS.CellValue) =>
    v === null || v === undefined
      ? ''
      : typeof v === 'object' && 'result' in v
        ? String(v.result ?? '')
        : typeof v === 'object' && 'richText' in v
          ? v.richText.map((r) => r.text).join('')
          : String(v);
  let cols: Partial<Record<'code' | 'description' | 'unit' | 'rate' | 'chapter', number>> = {};
  let headerRow = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 20) && !headerRow; r++) {
    const found: typeof cols = {};
    ws.getRow(r).eachCell((c, i) => {
      const k = HEADERS[cell(c.value).trim().toLowerCase()];
      if (k && found[k] === undefined) found[k] = i;
    });
    if (found.code && found.description && found.unit && found.rate) {
      cols = found;
      headerRow = r;
    }
  }
  if (!headerRow)
    throw new BadRequestException({
      code: 'no_header',
      message: 'Put a header row with Code, Description, Unit and Rate (and Chapter if you like).',
    });
  const items: {
    code: string;
    description: string;
    unit: string;
    rate: string;
    chapter: string;
  }[] = [];
  const problems: string[] = [];
  let chapter = '';
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k: keyof typeof cols) => (cols[k] ? cell(row.getCell(cols[k]!).value).trim() : '');
    const [code, description, unit, rate] = [
      get('code'),
      get('description'),
      get('unit'),
      get('rate'),
    ];
    if (cols.chapter && get('chapter')) chapter = get('chapter');
    if (!code && !description) continue;
    // A heading row (a chapter title with no unit or rate) sets the chapter for the items under it.
    if (!unit && !rate) {
      if (description) chapter = description.slice(0, 200);
      continue;
    }
    const n = Number(rate.replace(/,/g, ''));
    if (!code || !unit || !Number.isFinite(n) || n < 0) {
      problems.push(`Row ${r}: needs a code, a unit and a rate.`);
      continue;
    }
    items.push({
      code: code.slice(0, 40),
      description: description.slice(0, 4000),
      unit: unit.slice(0, 20),
      rate: n.toFixed(4),
      chapter,
    });
  }
  return { items, problems };
}

@Injectable()
export class SorService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly boqs: BoqService,
  ) {}

  async books(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT b.id, b.name, b.issuer, b.state_code AS "stateCode", b.edition,
        (SELECT count(*)::int FROM est.sor_item i WHERE i.book_id = b.id) AS items
      FROM est.sor_book b ORDER BY b.name`;
  }

  async addBook(
    claims: TenantClaims,
    input: { name: string; issuer: string; stateCode: string | null; edition: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db`
      INSERT INTO est.sor_book (name, issuer, state_code, edition, created_by)
      VALUES (${input.name}, ${input.issuer}, ${input.stateCode}, ${input.edition}, ${claims.sub})`.catch(
      (err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'book_exists',
            message: 'There is a schedule by that name.',
          });
        throw err;
      },
    );
    return this.books(claims);
  }

  /** Items from the company's spreadsheet: new codes added, codes already there given the new rate. */
  async importItems(claims: TenantClaims, bookId: string, buffer: Buffer) {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db`SELECT 1 FROM est.sor_book WHERE id = ${bookId}`;
    if (!b) throw new NotFoundException({ code: 'not_found' });
    const { items, problems } = await readSorWorkbook(buffer);
    if (!items.length)
      throw new BadRequestException({
        code: 'no_items',
        message: problems[0] ?? 'No items found.',
      });
    await db.begin(async (tx) => {
      for (let i = 0; i < items.length; i += 500)
        await tx`
          INSERT INTO est.sor_item ${tx(items.slice(i, i + 500).map((x) => ({ ...x, book_id: bookId })))}
          ON CONFLICT (book_id, code) DO UPDATE SET description = EXCLUDED.description, unit = EXCLUDED.unit,
            rate = EXCLUDED.rate, chapter = EXCLUDED.chapter`;
      await audit(tx, claims.sub, 'sor.import', 'sor_book', bookId, { items: items.length });
    });
    return { imported: items.length, problems };
  }

  async search(claims: TenantClaims, q: { q?: string | undefined; bookId?: string | undefined }) {
    const db = await this.tenants.forTenant(claims.ten);
    const text = q.q?.trim();
    return db`
      SELECT i.id, i.code, i.description, i.unit, i.rate::text, i.chapter, b.name AS book
      FROM est.sor_item i JOIN est.sor_book b ON b.id = i.book_id
      WHERE true ${q.bookId ? db`AND i.book_id = ${q.bookId}` : db``}
        ${
          text
            ? db`AND (i.code ILIKE ${`${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}
                OR to_tsvector('simple', i.code || ' ' || i.description) @@ plainto_tsquery('simple', ${text}))`
            : db``
        }
      ORDER BY b.name, i.code LIMIT 50`;
  }

  /** A BOQ item cites an SOR item (or, with null, no longer does). */
  async cite(claims: TenantClaims, boqId: string, lineId: string, sorItemId: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const [n] = await db<{ line_key: string }[]>`
      SELECT line_key FROM est.boq_node WHERE boq_id = ${boqId} AND id = ${lineId} AND node_type = 'item'`;
    if (!n) throw new NotFoundException({ code: 'line_not_found' });
    if (sorItemId === null)
      await db`DELETE FROM est.boq_sor WHERE boq_id = ${boqId} AND line_key = ${n.line_key}`;
    else
      await db`
        INSERT INTO est.boq_sor (boq_id, line_key, sor_item_id) VALUES (${boqId}, ${n.line_key}, ${sorItemId})
        ON CONFLICT (boq_id, line_key) DO UPDATE SET sor_item_id = EXCLUDED.sor_item_id`.catch(
        (err: unknown) => {
          if ((err as { code?: string }).code === '23503')
            throw new BadRequestException({ code: 'sor_item_not_found' });
          throw err;
        },
      );
    return this.citations(claims, boqId);
  }

  /** The BOQ's items that cite an SOR item, with both rates and whether the units agree. */
  async citations(claims: TenantClaims, boqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT n.id::text AS "lineId", n.code, t.description, n.unit, n.qty::text, n.rate::text,
        i.id AS "sorItemId", i.code AS "sorCode", b.name AS book, i.unit AS "sorUnit", i.rate::text AS "sorRate",
        lower(coalesce(n.unit, '')) <> lower(i.unit) AS "unitDiffers",
        coalesce(n.rate, -1) <> i.rate AS "rateDiffers"
      FROM est.boq_sor s
      JOIN est.boq_node n ON n.boq_id = s.boq_id AND n.line_key = s.line_key AND n.node_type = 'item'
      JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      JOIN est.sor_item i ON i.id = s.sor_item_id JOIN est.sor_book b ON b.id = i.book_id
      WHERE s.boq_id = ${boqId} ORDER BY n.sort_key`;
  }

  /** Every citing item takes its SOR rate, as one change to the BOQ. */
  async applyRates(claims: TenantClaims, boqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<{ id: string; row_version: number; rate: string }[]>`
      SELECT n.id::text, n.row_version, i.rate::text AS rate
      FROM est.boq_sor s
      JOIN est.boq_node n ON n.boq_id = s.boq_id AND n.line_key = s.line_key AND n.node_type = 'item'
      JOIN est.sor_item i ON i.id = s.sor_item_id
      WHERE s.boq_id = ${boqId} AND coalesce(n.rate, -1) <> i.rate`;
    if (rows.length) {
      const ops: Op[] = rows.map((r) => ({
        op: 'update',
        id: r.id,
        rowVersion: r.row_version,
        rate: r.rate,
      }));
      await this.boqs.apply(claims, boqId, ops);
    }
    return { updated: rows.length, citations: await this.citations(claims, boqId) };
  }

  // --- percentage-rate tenders and the comparative ---

  async mode(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db<
      { mode: 'item_rate' | 'percentage'; pct: string | null; value: string | null }[]
    >`
      SELECT rate_mode AS mode, quoted_pct::text AS pct, estimated_value::text AS value
      FROM tender.tender WHERE id = ${tenderId}`;
    if (!t) throw new NotFoundException({ code: 'tender_not_found' });
    return {
      rateMode: t.mode,
      quotedPct: t.pct,
      estimate: t.value,
      quotedValue:
        t.mode === 'percentage' && t.value && t.pct !== null
          ? ((Number(t.value) * (100 + Number(t.pct))) / 100).toFixed(2)
          : null,
    };
  }

  async setMode(
    claims: TenantClaims,
    tenderId: string,
    input: { rateMode: 'item_rate' | 'percentage'; quotedPct: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db<{ value: string | null }[]>`
      UPDATE tender.tender SET rate_mode = ${input.rateMode},
        quoted_pct = ${input.rateMode === 'percentage' ? input.quotedPct : null}
      WHERE id = ${tenderId} RETURNING estimated_value::text AS value`;
    if (!t) throw new NotFoundException({ code: 'tender_not_found' });
    return {
      rateMode: input.rateMode,
      quotedPct: input.rateMode === 'percentage' ? input.quotedPct : null,
      estimate: t.value,
      quotedValue:
        input.rateMode === 'percentage' && t.value && input.quotedPct !== null
          ? ((Number(t.value) * (100 + Number(input.quotedPct))) / 100).toFixed(2)
          : null,
    };
  }

  /** A bidder's item rates (ours with no party), replacing what was there. */
  async setItemBids(
    claims: TenantClaims,
    tenderId: string,
    partyId: string | null,
    rates: { lineKey: string; rate: string }[],
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`
        DELETE FROM tender.item_bid WHERE tender_id = ${tenderId} AND party_id IS NOT DISTINCT FROM ${partyId}::uuid`;
      if (rates.length)
        await tx`INSERT INTO tender.item_bid ${tx(
          rates.map((r) => ({
            tender_id: tenderId,
            party_id: partyId,
            line_key: r.lineKey,
            rate: r.rate,
          })),
        )}`;
      await audit(tx, claims.sub, 'tender.item_bids', 'tender', tenderId, {
        partyId,
        lines: rates.length,
      });
    });
    return this.comparative(claims, tenderId);
  }

  /** Each item of the tender's estimate with every bidder's rate, the lowest, and each bidder's total and rank. */
  async comparative(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [boq] = await db<{ id: string }[]>`
      SELECT id FROM est.boq WHERE tender_id = ${tenderId} AND archived_at IS NULL ORDER BY created_at LIMIT 1`;
    if (!boq) return { boqId: null, lines: [], bidders: [] };
    const lines = await db<
      {
        lineId: string;
        lineKey: string;
        code: string | null;
        description: string;
        unit: string | null;
        qty: string;
        rate: string | null;
        sorCode: string | null;
      }[]
    >`
      SELECT n.id::text AS "lineId", n.line_key AS "lineKey",
        (SELECT i.code FROM est.boq_sor s JOIN est.sor_item i ON i.id = s.sor_item_id
          WHERE s.boq_id = n.boq_id AND s.line_key = n.line_key) AS "sorCode", n.code, t.description, n.unit, coalesce(n.qty, 0)::text AS qty, n.rate::text
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ${boq.id} AND n.node_type = 'item' ORDER BY n.sort_key`;
    const bids = await db<
      { partyId: string | null; name: string | null; lineKey: string; rate: string }[]
    >`
      SELECT b.party_id AS "partyId", p.name, b.line_key AS "lineKey", b.rate::text
      FROM tender.item_bid b LEFT JOIN platform.party p ON p.id = b.party_id WHERE b.tender_id = ${tenderId}`;
    const key = (id: string | null) => id ?? 'us';
    const names = new Map(bids.map((b) => [key(b.partyId), b.partyId ? b.name! : 'Us']));
    const bidders = [...names.entries()].map(([k, name]) => {
      const mine = new Map(
        bids.filter((b) => key(b.partyId) === k).map((b) => [b.lineKey, Number(b.rate)]),
      );
      const total = lines.reduce((s, l) => s + Number(l.qty) * (mine.get(l.lineKey) ?? 0), 0);
      return {
        key: k,
        name,
        total: total.toFixed(2),
        complete: lines.every((l) => mine.has(l.lineKey)),
      };
    });
    const ranked = bidders
      .filter((b) => b.complete)
      .sort((a, b) => Number(a.total) - Number(b.total))
      .map((b, i) => [b.key, i + 1] as const);
    const rank = new Map(ranked);
    return {
      boqId: boq.id,
      lines: lines.map((l) => {
        const rates = Object.fromEntries(
          bids.filter((b) => b.lineKey === l.lineKey).map((b) => [key(b.partyId), b.rate]),
        );
        const values = Object.values(rates).map(Number);
        const lowest = values.length ? Math.min(...values) : null;
        return {
          ...l,
          rates,
          lowest: lowest === null ? null : lowest.toFixed(4),
          lowestBy: Object.entries(rates)
            .filter(([, r]) => Number(r) === lowest)
            .map(([k]) => names.get(k)!),
        };
      }),
      // Lowest first; bidders who left lines unpriced come last, unranked.
      bidders: bidders
        .map((b) => ({ ...b, rank: rank.get(b.key) ?? null }))
        .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)),
    };
  }

  /**
   * Past percentage-rate tenders: our percentage against the lowest, won or lost; and per competitor how often they
   * bid, their average percentage and how often they came lowest.
   */
  async percentageHistory(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const tenders = await db<
      {
        id: string;
        number: string;
        title: string;
        status: string;
        ours: string | null;
        lowest: string | null;
      }[]
    >`
      SELECT t.id, t.number, t.title, t.status, t.quoted_pct::text AS ours,
        (SELECT min(b.quoted_pct)::text FROM tender.competitor_bid b WHERE b.tender_id = t.id AND b.qualified
          AND b.quoted_pct IS NOT NULL) AS lowest
      FROM tender.tender t WHERE t.rate_mode = 'percentage' AND t.status IN ('submitted', 'won', 'lost')
      ORDER BY t.number`;
    const bids = await db<{ tenderId: string; name: string; pct: string }[]>`
      SELECT b.tender_id AS "tenderId", p.name, b.quoted_pct::text AS pct
      FROM tender.competitor_bid b JOIN platform.party p ON p.id = b.party_id
      JOIN tender.tender t ON t.id = b.tender_id
      WHERE t.rate_mode = 'percentage' AND b.quoted_pct IS NOT NULL AND b.qualified`;
    const decided = tenders.filter((t) => t.status === 'won' || t.status === 'lost');
    const names = [...new Set(bids.map((b) => b.name))].sort();
    return {
      tenders: tenders.map((t) => ({
        ...t,
        gap:
          t.ours !== null && t.lowest !== null
            ? (Number(t.ours) - Number(t.lowest)).toFixed(2)
            : null,
      })),
      winRate: decided.length
        ? Math.round((decided.filter((t) => t.status === 'won').length / decided.length) * 100)
        : null,
      competitors: names.map((name) => {
        const mine = bids.filter((b) => b.name === name);
        const lowest = mine.filter((b) => {
          const t = tenders.find((x) => x.id === b.tenderId);
          return t?.lowest !== null && Number(b.pct) === Number(t?.lowest);
        }).length;
        return {
          name,
          bids: mine.length,
          averagePct: (mine.reduce((s, b) => s + Number(b.pct), 0) / mine.length).toFixed(2),
          lowest,
        };
      }),
    };
  }
}
