import { describe, expect, it } from 'vitest';
import { buildHealthReport } from './index.js';

describe('buildHealthReport', () => {
  it('reports ok with an ISO timestamp', () => {
    const report = buildHealthReport('api', '0.0.0', new Date('2026-01-01T00:00:00Z'));
    expect(report).toEqual({
      service: 'api',
      status: 'ok',
      version: '0.0.0',
      time: '2026-01-01T00:00:00.000Z',
    });
  });
});
