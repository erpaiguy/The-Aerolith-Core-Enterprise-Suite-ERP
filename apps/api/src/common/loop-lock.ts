// One process at a time for an hourly loop (scheduled reports, backups, the morning email): with two API processes
// (a second container, a rolling restart) both would otherwise run the same work and send or take it twice. A
// session advisory lock on the control database, held on one reserved connection while the loop runs; a process
// that finds it taken skips this hour.
import type { Sql } from 'postgres';

export const LOOP_LOCK = { reports: 7_310_101, backups: 7_310_102, digest: 7_310_103 } as const;

/** Runs `fn` if no other process holds `key`; returns false when it was skipped. */
export async function exclusively(
  control: Sql,
  key: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const conn = await control.reserve();
  try {
    const [r] = await conn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${key}) AS ok`;
    if (!r?.ok) return false;
    try {
      await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(${key})`;
    }
    return true;
  } finally {
    conn.release();
  }
}
