// The hourly loops run in one process at a time (docs/debug-log.md D-4).
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exclusively } from '../src/common/loop-lock.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;

describe.skipIf(!controlUrl)('loop lock (integration)', () => {
  let a: Sql;
  let b: Sql;
  beforeAll(() => {
    // Two pools stand for two API processes.
    a = postgres(controlUrl!, { max: 2, onnotice: () => {} });
    b = postgres(controlUrl!, { max: 2, onnotice: () => {} });
  });
  afterAll(async () => {
    await a?.end();
    await b?.end();
  });

  it('lets one process run the loop while the other skips it, then frees it', async () => {
    const key = 7_399_001;
    let release!: () => void;
    const held = new Promise<void>((ok) => (release = ok));
    const ran: string[] = [];
    const first = exclusively(a, key, async () => {
      ran.push('a');
      await held;
    });
    await new Promise((ok) => setTimeout(ok, 100));
    expect(await exclusively(b, key, async () => void ran.push('b'))).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await exclusively(b, key, async () => void ran.push('b'))).toBe(true);
    expect(ran).toEqual(['a', 'b']);
  });

  it('frees the lock when the loop throws', async () => {
    const key = 7_399_002;
    await expect(
      exclusively(a, key, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await exclusively(b, key, async () => {})).toBe(true);
  });
});
