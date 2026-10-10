// BOQ templates (migration 0017): a BOQ's lines saved as a company template, per vertical, and new BOQs started from
// one. Saving copies the lines (with quantities and rates only if asked); starting from a template writes all its
// lines in a few set-based statements, like an import, so a 20,000-line template takes seconds, not minutes.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { childKey, segmentFor } from '@aerolith/shared';
import type { TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { amountPaise, paiseToString } from './import/builder.js';
import { counted, type ItemKind } from './kinds.js';

export const MAX_TEMPLATE_LINES = 50_000;
const CHUNK = 5000;

export interface TemplateInput {
  name: string;
  vertical: string;
  description: string;
  withQuantities: boolean;
  withRates: boolean;
}

interface TemplateLine {
  seq: number;
  depth: number;
  node_type: 'section' | 'item' | 'note';
  item_kind: ItemKind;
  code: string | null;
  description: string;
  notes: string;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  rate_analysis_id: string | null;
}

const TEMPLATE = `t.id, t.name, t.vertical, t.description, t.with_quantities AS "withQuantities",
  t.with_rates AS "withRates", t.line_count AS "lineCount", t.item_count AS "itemCount",
  t.archived_at AS "archivedAt", t.updated_at AS "updatedAt", t.row_version AS "rowVersion",
  u.display_name AS "createdBy"`;

function friendly(err: unknown): never {
  if ((err as { code?: string }).code === '23505')
    throw new ConflictException({
      code: 'name_taken',
      message: 'There is already a template with that name.',
    });
  throw err;
}

@Injectable()
export class TemplateService {
  constructor(private readonly tenants: TenantConnections) {}

  async list(claims: TenantClaims, opts: { vertical?: string | undefined; archived: boolean }) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT ${db.unsafe(TEMPLATE)} FROM est.boq_template t LEFT JOIN platform."user" u ON u.id = t.created_by
      WHERE (t.archived_at IS NOT NULL) = ${opts.archived}
        ${opts.vertical ? db`AND t.vertical = ${opts.vertical}` : db``}
      ORDER BY lower(t.name)`;
  }

  /** The template's first lines, for a preview before use. */
  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db`
      SELECT ${db.unsafe(TEMPLATE)} FROM est.boq_template t LEFT JOIN platform."user" u ON u.id = t.created_by
      WHERE t.id = ${id}`;
    if (!t) throw new NotFoundException({ code: 'template_not_found' });
    const lines = await db`
      SELECT seq, depth, node_type AS type, item_kind AS kind, code, description, unit, qty::text AS qty,
        rate::text AS rate
      FROM est.boq_template_line WHERE template_id = ${id} ORDER BY seq LIMIT 200`;
    return { ...t, lines };
  }

  /** Saves the BOQ's current lines as a new template. */
  async saveFrom(claims: TenantClaims, boqId: string, input: TemplateInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        const [b] = await tx<{ node_count: number; name: string }[]>`
          SELECT node_count, name FROM est.boq WHERE id = ${boqId}`;
        if (!b) throw new NotFoundException({ code: 'boq_not_found' });
        if (b.node_count === 0)
          throw new BadRequestException({
            code: 'boq_empty',
            message: 'The BOQ has no lines to save.',
          });
        if (b.node_count > MAX_TEMPLATE_LINES)
          throw new BadRequestException({
            code: 'too_many_lines',
            message: `A template holds up to ${MAX_TEMPLATE_LINES.toLocaleString('en-IN')} lines.`,
          });
        const [t] = await tx<{ id: string }[]>`
          INSERT INTO est.boq_template (name, vertical, description, with_quantities, with_rates, line_count,
            item_count, created_by, updated_by)
          SELECT ${input.name}, ${input.vertical}, ${input.description}, ${input.withQuantities},
            ${input.withRates}, node_count, item_count, ${claims.sub}, ${claims.sub}
          FROM est.boq WHERE id = ${boqId}
          RETURNING id`;
        await tx`
          INSERT INTO est.boq_template_line (template_id, seq, depth, node_type, item_kind, code, description,
            notes, unit, qty, rate, rate_analysis_id)
          SELECT ${t!.id}, row_number() OVER (ORDER BY n.sort_key)::int, n.depth, n.node_type, n.item_kind, n.code,
            x.description, x.notes, n.unit,
            CASE WHEN ${input.withQuantities} THEN n.qty END,
            CASE WHEN ${input.withRates} THEN n.rate END,
            CASE WHEN ${input.withRates} THEN n.rate_analysis_id END
          FROM est.boq_node n JOIN est.boq_node_text x ON x.boq_id = n.boq_id AND x.node_id = n.id
          WHERE n.boq_id = ${boqId}`;
        await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
          VALUES (${claims.sub}, 'boq_template.create', 'boq_template', ${t!.id},
            ${tx.json({ boqId, name: input.name })})`;
        return t!.id;
      })
      .catch(friendly);
    return this.get(claims, id);
  }

  async update(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: {
      name?: string | undefined;
      vertical?: string | undefined;
      description?: string | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    await db
      .begin(async (tx) => {
        const [t] = await tx`
          UPDATE est.boq_template SET ${tx(fields)}, updated_at = now(), updated_by = ${claims.sub},
            row_version = row_version + 1
          WHERE id = ${id} AND row_version = ${rowVersion} RETURNING id`;
        if (!t) {
          const [exists] = await tx`SELECT 1 FROM est.boq_template WHERE id = ${id}`;
          if (!exists) throw new NotFoundException({ code: 'template_not_found' });
          throw new ConflictException({
            code: 'stale_row',
            message: 'Someone else changed this template. Reload.',
          });
        }
      })
      .catch(friendly);
    return this.get(claims, id);
  }

  async archive(claims: TenantClaims, id: string, archived: boolean) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db`
      UPDATE est.boq_template SET archived_at = ${archived ? db`now()` : null}, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1
      WHERE id = ${id} RETURNING id`.catch(friendly);
    if (!t) throw new NotFoundException({ code: 'template_not_found' });
    return this.get(claims, id);
  }

  /** A new BOQ of the tender, with the template's lines. */
  async createBoq(
    claims: TenantClaims,
    tenderId: string,
    input: { templateId: string; name: string; notes: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const [tender] = await tx`SELECT 1 FROM tender.tender WHERE id = ${tenderId}`;
      if (!tender) throw new NotFoundException({ code: 'tender_not_found' });
      const [t] = await tx<{ name: string; archived: boolean }[]>`
        SELECT name, archived_at IS NOT NULL AS archived FROM est.boq_template WHERE id = ${input.templateId}`;
      if (!t) throw new NotFoundException({ code: 'template_not_found' });
      if (t.archived)
        throw new ConflictException({
          code: 'template_archived',
          message: 'That template is archived.',
        });
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO est.boq (tender_id, name, notes, created_by, updated_by)
        VALUES (${tenderId}, ${input.name}, ${input.notes}, ${claims.sub}, ${claims.sub}) RETURNING id`;
      const lines = await tx<TemplateLine[]>`
        SELECT seq, depth, node_type, item_kind, code, description, notes, unit, qty::text, rate::text,
          rate_analysis_id::text
        FROM est.boq_template_line WHERE template_id = ${input.templateId} ORDER BY seq`;
      const written = await writeLines(tx, b!.id, lines);
      await tx`UPDATE est.boq SET node_count = ${written.lines}, item_count = ${written.items},
          total = ${written.total}::numeric WHERE id = ${b!.id}`;
      const data = { boqId: b!.id, name: input.name, template: t.name };
      await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
        VALUES (${tenderId}, 'boq_created', ${tx.json(data)}, ${claims.sub})`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'boq.create', 'boq', ${b!.id}, ${tx.json({ ...data, tenderId })})`;
      return { id: b!.id, ...written };
    });
  }
}

/**
 * Writes lines (in tree order, with depths) into an empty BOQ: ids from the sequence, fixed-width sort keys, section
 * subtotals and child counts worked out on the way, as the importer does.
 */
async function writeLines(tx: TransactionSql, boqId: string, lines: TemplateLine[]) {
  const width = lines.length < 36 ** 3 ? 3 : lines.length < 36 ** 4 ? 4 : 5;
  const ids = (
    await tx<{ id: string }[]>`
      SELECT nextval('est.boq_node_id_seq')::text AS id FROM generate_series(1, ${Math.max(1, lines.length)})`
  ).map((r) => r.id);
  const stack: { id: string; key: string; next: number; depth: number }[] = [];
  const sections = new Map<string, { subtotal: bigint; children: number }>();
  let top = 0;
  let total = 0n;
  let items = 0;
  const rows = lines.map((l, i) => {
    // A depth deeper than its parent allows (a template saved before a move) attaches to the nearest section.
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= l.depth) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const depth = parent ? parent.depth + 1 : 0;
    const key = childKey(parent?.key ?? '', segmentFor(parent ? parent.next++ : top++, width));
    const id = ids[i]!;
    if (parent) sections.get(parent.id)!.children++;
    const isItem = l.node_type === 'item';
    const amount =
      isItem && counted(l.item_kind) && l.qty !== null && l.rate !== null
        ? amountPaise(l.qty, l.rate)
        : null;
    if (amount !== null) {
      total += amount;
      for (const s of stack) sections.get(s.id)!.subtotal += amount;
    }
    if (isItem) items++;
    if (l.node_type === 'section') {
      stack.push({ id, key, next: 0, depth });
      sections.set(id, { subtotal: 0n, children: 0 });
    }
    return {
      id,
      parent_id: parent?.id ?? null,
      sort_key: key,
      depth,
      node_type: l.node_type,
      item_kind: isItem ? l.item_kind : 'normal',
      code: l.code,
      unit: l.unit,
      qty: isItem ? l.qty : null,
      rate: isItem ? l.rate : null,
      amount: amount === null ? null : paiseToString(amount),
      rate_analysis_id: isItem ? l.rate_analysis_id : null,
      description: l.description,
      notes: l.notes,
    };
  });
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => {
      const s = sections.get(r.id);
      return {
        ...r,
        subtotal: s ? paiseToString(s.subtotal) : '0',
        child_count: s?.children ?? 0,
      };
    });
    await tx`
      WITH r AS (
        SELECT * FROM jsonb_to_recordset(${tx.json(chunk)}) AS r(
          id bigint, parent_id bigint, sort_key text, depth smallint, node_type text, item_kind text, code text,
          unit text, qty numeric, rate numeric, amount numeric, rate_analysis_id uuid, description text, notes text,
          subtotal numeric, child_count int)
      ), n AS (
        INSERT INTO est.boq_node (boq_id, id, parent_id, sort_key, depth, node_type, item_kind, code, unit, qty,
          rate, amount, rate_analysis_id, subtotal, child_count, created_version)
        SELECT ${boqId}, id, parent_id, sort_key, depth, node_type, item_kind, code, unit, qty, rate, amount,
          rate_analysis_id, subtotal, child_count, 1
        FROM r
      )
      INSERT INTO est.boq_node_text (boq_id, node_id, description, notes)
      SELECT ${boqId}, id, description, notes FROM r`;
  }
  return { lines: rows.length, items, total: paiseToString(total) };
}
