import { describe, expect, it } from 'vitest';
import { build, SpecError, type Spec } from '../src/bi/query.js';

const spec = (s: Partial<Spec>): Spec => ({
  view: 'purchase_orders',
  fields: [],
  filters: [],
  groupBy: [],
  aggregates: [],
  sort: null,
  limit: 1000,
  ...s,
});
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as SpecError).code;
  }
  return null;
};

describe('report query builder', () => {
  it('groups and sums, scoped to the projects one may see, with values bound', () => {
    const r = build(
      spec({
        groupBy: ['vendor'],
        aggregates: [
          { field: 'value', fn: 'sum' },
          { field: 'value', fn: 'count' },
        ],
        filters: [{ field: 'ordered_month', op: 'eq', value: '2026-09' }],
        sort: { field: 'sum_value', dir: 'desc' },
      }),
      ['00000000-0000-0000-0000-000000000001'],
    );
    expect(r.columns).toEqual(['vendor', 'sum_value', 'count']);
    expect(r.sql).toContain('v.project_id = ANY($1::uuid[])');
    expect(r.sql).toContain('v."ordered_month" = $2');
    expect(r.sql).toContain('GROUP BY v."vendor"');
    expect(r.sql).toContain('ORDER BY "sum_value" DESC NULLS LAST LIMIT 1000');
    expect(r.params).toEqual([['00000000-0000-0000-0000-000000000001'], '2026-09']);
  });

  it('never lets a name or value into the SQL text', () => {
    const r = build(
      spec({
        fields: ['vendor'],
        filters: [{ field: 'vendor', op: 'contains', value: "x'; DROP TABLE y; --" }],
      }),
      null,
    );
    expect(r.sql).not.toContain('DROP');
    expect(r.params).toEqual(["x'; DROP TABLE y; --"]);
    expect(code(() => build(spec({ fields: ['vendor"; DROP TABLE y; --'] }), null))).toBe(
      'no_such_field',
    );
    expect(code(() => build(spec({ view: 'pg_catalog' }), null))).toBe('no_such_view');
  });

  it('refuses what does not make sense', () => {
    expect(code(() => build(spec({ groupBy: ['vendor'] }), null))).toBe('no_aggregate');
    expect(
      code(() =>
        build(spec({ groupBy: ['number'], aggregates: [{ field: 'value', fn: 'sum' }] }), null),
      ),
    ).toBe('not_groupable');
    expect(
      code(() =>
        build(spec({ groupBy: ['vendor'], aggregates: [{ field: 'vendor', fn: 'sum' }] }), null),
      ),
    ).toBe('not_summable');
    expect(
      code(() =>
        build(
          spec({ fields: ['value'], filters: [{ field: 'value', op: 'gt', value: 'lots' }] }),
          null,
        ),
      ),
    ).toBe('bad_value');
    expect(
      code(() =>
        build(
          spec({ fields: ['vendor'], filters: [{ field: 'vendor', op: 'gt', value: 'a' }] }),
          null,
        ),
      ),
    ).toBe('bad_op');
    expect(
      code(() => build(spec({ fields: ['vendor'], sort: { field: 'value', dir: 'asc' } }), null)),
    ).toBe('bad_sort');
    expect(code(() => build(spec({}), null))).toBe('no_fields');
  });

  it('leaves unscoped views and admins unrestricted', () => {
    expect(build(spec({ view: 'leads', fields: ['number'] }), ['x']).sql).not.toContain(
      'project_id',
    );
    expect(build(spec({ fields: ['number'] }), null).sql).not.toContain('= ANY(');
  });
});

describe('report schedules', () => {
  it('runs at 07:00 IST on the next matching day', async () => {
    const { nextRun } = await import('../src/bi/bi.service.js');
    // Monday 12 October 2026, 06:00 IST: today at 07:00; at 08:00 IST: tomorrow.
    expect(
      nextRun(
        { cadence: 'daily', weekday: null, monthday: null },
        new Date('2026-10-12T00:30:00Z'),
      ).toISOString(),
    ).toBe('2026-10-12T01:30:00.000Z');
    expect(
      nextRun(
        { cadence: 'daily', weekday: null, monthday: null },
        new Date('2026-10-12T02:30:00Z'),
      ).toISOString(),
    ).toBe('2026-10-13T01:30:00.000Z');
    // Weekly on Friday (5): 16 October.
    expect(
      nextRun(
        { cadence: 'weekly', weekday: 5, monthday: null },
        new Date('2026-10-12T02:30:00Z'),
      ).toISOString(),
    ).toBe('2026-10-16T01:30:00.000Z');
    // Monthly on the 1st: 1 November.
    expect(
      nextRun(
        { cadence: 'monthly', weekday: null, monthday: 1 },
        new Date('2026-10-12T02:30:00Z'),
      ).toISOString(),
    ).toBe('2026-11-01T01:30:00.000Z');
  });
});
