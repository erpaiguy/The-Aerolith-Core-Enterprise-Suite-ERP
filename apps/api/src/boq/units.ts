// The units master (platform.unit) as a lookup: lower-case code or alias -> unit code.
import type { Sql, TransactionSql } from 'postgres';

export async function loadUnitMap(
  db: Sql | TransactionSql,
  activeOnly = true,
): Promise<Map<string, string>> {
  const rows = await db<{ code: string; aliases: string[] }[]>`
    SELECT code, aliases FROM platform.unit ${activeOnly ? db`WHERE active` : db``}`;
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.code.toLowerCase(), r.code);
    for (const a of r.aliases) if (!map.has(a.toLowerCase())) map.set(a.toLowerCase(), r.code);
  }
  return map;
}

/** Two unit spellings name the same unit ("Cu.M" and "cum"); unknown units must match exactly (ignoring case). */
export const sameUnit = (map: Map<string, string>, a: string, b: string): boolean => {
  const norm = (u: string) => map.get(u.trim().toLowerCase()) ?? u.trim().toLowerCase();
  return norm(a) === norm(b);
};
