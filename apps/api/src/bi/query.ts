// A report spec into SQL (docs/wave6-plan.md step 3). Identifiers come only from the registry (views.ts), quoted;
// every value from the spec is a numbered parameter. Anything not in the view is refused, never escaped.
import { VIEWS, type Field, type View } from './views.js';

export type Op = 'eq' | 'ne' | 'gt' | 'lt' | 'between' | 'contains' | 'in';
export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max';
export interface Spec {
  view: string;
  fields: string[];
  filters: { field: string; op: Op; value: string | string[] }[];
  groupBy: string[];
  aggregates: { field: string; fn: Agg }[];
  sort: { field: string; dir: 'asc' | 'desc' } | null;
  limit: number;
}

export class SpecError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const DATEISH = new Set(['date', 'month']);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d{1,15}(\.\d{1,4})?$/;

/** The result's column for an aggregate: "sum_value", or "count" for a count of rows. */
export const aggName = (a: { field: string; fn: Agg }) =>
  a.fn === 'count' ? 'count' : `${a.fn}_${a.field}`;

function check(f: Field, name: string, value: string) {
  if ((f.type === 'number' || f.type === 'money') && !NUMBER.test(value))
    throw new SpecError('bad_value', `${f.label}: a number.`);
  if (f.type === 'date' && !DATE.test(value))
    throw new SpecError('bad_value', `${f.label}: a date.`);
  if (f.type === 'month' && !MONTH.test(value))
    throw new SpecError('bad_value', `${f.label}: a month, YYYY-MM.`);
  if (value.length > 200) throw new SpecError('bad_value', `${name}: too long.`);
}

/**
 * The SQL and its parameters. `scope` is the projects the person may see (null: all); it is applied inside, before
 * any filter or grouping, so no total ever includes another project's rows.
 */
export function build(
  spec: Spec,
  scope: string[] | null,
): { view: View; sql: string; params: unknown[]; columns: string[] } {
  const view = VIEWS[spec.view];
  if (!view) throw new SpecError('no_such_view', 'No such view.');
  const field = (name: string) => {
    const f = view.fields[name];
    if (!f) throw new SpecError('no_such_field', `"${name}" is not a field of ${view.label}.`);
    return f;
  };
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (view.projectScoped && scope !== null)
    where.push(`v.project_id = ANY(${bind(scope)}::uuid[])`);
  for (const f of spec.filters) {
    const def = field(f.field);
    const col = `v.${q(f.field)}`;
    const values = Array.isArray(f.value) ? f.value : [f.value];
    values.forEach((x) => check(def, f.field, x));
    const cast =
      def.type === 'number' || def.type === 'money'
        ? '::numeric'
        : def.type === 'date'
          ? '::date'
          : '';
    switch (f.op) {
      case 'eq':
      case 'ne':
      case 'gt':
      case 'lt': {
        if (values.length !== 1) throw new SpecError('bad_value', `${def.label}: one value.`);
        if ((f.op === 'gt' || f.op === 'lt') && def.type === 'text')
          throw new SpecError('bad_op', `${def.label}: text is not compared by size.`);
        const sym = { eq: '=', ne: '<>', gt: '>', lt: '<' }[f.op];
        where.push(`${col} ${sym} ${bind(values[0])}${cast}`);
        break;
      }
      case 'between':
        if (values.length !== 2 || def.type === 'text')
          throw new SpecError('bad_value', `${def.label}: between two values.`);
        where.push(`${col} BETWEEN ${bind(values[0])}${cast} AND ${bind(values[1])}${cast}`);
        break;
      case 'contains':
        if (def.type !== 'text' || values.length !== 1)
          throw new SpecError('bad_op', `${def.label}: "contains" is for text.`);
        where.push(
          `${col} ILIKE '%' || ${bind(values[0]!.replace(/[\\%_]/g, (c) => `\\${c}`))} || '%'`,
        );
        break;
      case 'in':
        if (values.length < 1 || values.length > 50)
          throw new SpecError('bad_value', `${def.label}: 1 to 50 values.`);
        where.push(
          `${col}${cast ? '' : '::text'} = ANY(${bind(values)}${cast ? `${cast}[]` : '::text[]'})`,
        );
        break;
      default:
        throw new SpecError('bad_op', 'No such comparison.');
    }
  }
  const grouped = spec.groupBy.length > 0;
  const select: string[] = [];
  const columns: string[] = [];
  if (grouped) {
    if (!spec.aggregates.length)
      throw new SpecError('no_aggregate', 'Grouping needs a total: a sum, count or average.');
    for (const g of spec.groupBy) {
      const def = field(g);
      if (!def.group) throw new SpecError('not_groupable', `${def.label} cannot be grouped.`);
      select.push(`v.${q(g)}`);
      columns.push(g);
    }
  } else {
    if (!spec.fields.length && !spec.aggregates.length)
      throw new SpecError('no_fields', 'Choose some fields.');
    for (const f of spec.fields) {
      field(f);
      select.push(`v.${q(f)}`);
      columns.push(f);
    }
  }
  for (const a of spec.aggregates) {
    if (a.fn === 'count') {
      select.push(`count(*)::int AS ${q('count')}`);
      columns.push('count');
      continue;
    }
    const def = field(a.field);
    if (a.fn === 'min' || a.fn === 'max') {
      if (!def.sum && !DATEISH.has(def.type))
        throw new SpecError('not_summable', `${def.label} has no smallest or largest.`);
    } else if (!def.sum) throw new SpecError('not_summable', `${def.label} cannot be added up.`);
    const expr = a.fn === 'avg' ? `round(avg(v.${q(a.field)}), 2)` : `${a.fn}(v.${q(a.field)})`;
    select.push(`${expr} AS ${q(aggName(a))}`);
    columns.push(aggName(a));
  }
  if (!grouped && spec.aggregates.length && spec.fields.length)
    throw new SpecError('mixed', 'Choose fields or totals; to total by a field, group by it.');
  let order = '';
  if (spec.sort) {
    if (!columns.includes(spec.sort.field))
      throw new SpecError('bad_sort', 'Sort by a column of the result.');
    order = ` ORDER BY ${q(spec.sort.field)} ${spec.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  } else if (grouped) order = ` ORDER BY ${spec.groupBy.map((_, i) => i + 1).join(', ')}`;
  const limit = Math.max(1, Math.min(spec.limit, 100_000));
  const sql =
    `SELECT ${select.join(', ')} FROM (${view.source}) v` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    (grouped ? ` GROUP BY ${spec.groupBy.map((g) => `v.${q(g)}`).join(', ')}` : '') +
    order +
    ` LIMIT ${limit}`;
  return { view, sql, params, columns };
}
