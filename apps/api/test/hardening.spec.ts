// Hardening (docs/wave9-plan.md step 9b.5): the connection budget, and log lines a collector can search by the
// reference a person quotes.
import { describe, expect, it } from 'vitest';
import { JsonLogger } from '../src/common/json-logger.js';
import { connectionBudget } from '../src/health/health.controller.js';

describe('the connection budget', () => {
  it('fits a single company easily, and warns for many companies on a default Postgres', () => {
    expect(connectionBudget({ maxTenantPools: 1, tenantPoolMax: 5 }, 100)).toEqual({
      needed: 20,
      allowed: 100,
      ok: true,
    });
    expect(connectionBudget({ maxTenantPools: 50, tenantPoolMax: 5 }, 100).ok).toBe(false);
  });
});

describe('JSON logs', () => {
  it('writes one object per line, with the context and the request reference', () => {
    const lines: string[] = [];
    const log = new JsonLogger((l) => lines.push(l));
    log.error('K7M2PQ9XWA POST /api/tenant/orders -> 500', 'Error: boom\n    at x', 'Request');
    log.log('Started', 'Bootstrap');
    const [a, b] = lines.map((l) => JSON.parse(l) as Record<string, string>);
    expect(a).toMatchObject({
      level: 'error',
      context: 'Request',
      ref: 'K7M2PQ9XWA',
      stack: 'Error: boom\n    at x',
    });
    expect(b).toMatchObject({ level: 'log', context: 'Bootstrap', msg: 'Started' });
    expect(b).not.toHaveProperty('ref');
  });
});
