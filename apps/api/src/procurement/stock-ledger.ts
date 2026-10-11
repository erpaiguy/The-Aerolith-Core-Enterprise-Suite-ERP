// The stock ledger (docs/wave2b-plan.md step 6): every movement in or out of a store goes through here, in the caller's
// transaction. It values what goes out (weighted average per store and resource, or FIFO lots when the tenant chose
// FIFO before the first movement), keeps the balance beside the ledger, and refuses to let stock go negative.
import { ConflictException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { dec, fmt, type Dec } from '../rates/decimal.js';

type Db = Sql | TransactionSql;
export type Valuation = 'average' | 'fifo';
export type MoveKind =
  | 'receipt'
  | 'receipt_cancelled'
  | 'issue'
  | 'issue_return'
  | 'transfer_out'
  | 'transfer_in'
  | 'transfer_back'
  | 'adjustment';

export const VALUATION_KEY = 'stock.valuation';

export interface MoveRef {
  storeId: string;
  resourceId: string;
  on: string;
  kind: MoveKind;
  docType: string;
  docId: string;
  docNumber: string;
  wbsId?: string | null;
  userId: string;
}

/** Rounded to the paisa, as stored. */
export const paise = (v: Dec): Dec => dec(fmt(v, 2));
/** a × b / c, to the paisa (c > 0). */
export const share = (a: Dec, b: Dec, c: Dec): Dec => paise((a * b) / c);

export async function valuation(db: Db): Promise<Valuation> {
  const [r] = await db<{ value: Valuation }[]>`
    SELECT value FROM platform.setting WHERE key = ${VALUATION_KEY}`;
  return r?.value === 'fifo' ? 'fifo' : 'average';
}

async function balance(tx: TransactionSql, storeId: string, resourceId: string) {
  await tx`INSERT INTO proc.stock_balance (store_id, resource_id, qty, value)
    VALUES (${storeId}, ${resourceId}, 0, 0) ON CONFLICT DO NOTHING`;
  const [b] = await tx<{ qty: string; value: string }[]>`
    SELECT qty::text AS qty, value::text AS value FROM proc.stock_balance
    WHERE store_id = ${storeId} AND resource_id = ${resourceId} FOR UPDATE`;
  return { qty: dec(b!.qty), value: dec(b!.value) };
}

async function record(tx: TransactionSql, m: MoveRef, qty: Dec, value: Dec) {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO proc.stock_move (store_id, resource_id, moved_on, qty, value, kind, doc_type, doc_id, doc_number,
      wbs_id, created_by)
    VALUES (${m.storeId}, ${m.resourceId}, ${m.on}, ${fmt(qty, 4)}, ${fmt(value, 2)}, ${m.kind}, ${m.docType},
      ${m.docId}, ${m.docNumber}, ${m.wbsId ?? null}, ${m.userId})
    RETURNING id::text AS id`;
  await tx`UPDATE proc.stock_balance SET qty = qty + ${fmt(qty, 4)}, value = value + ${fmt(value, 2)}
    WHERE store_id = ${m.storeId} AND resource_id = ${m.resourceId}`;
  return row!.id;
}

/** Stock in at a known value (a receipt at the order rate, a return at its issue value, a transfer at its cost). */
export async function stockIn(
  tx: TransactionSql,
  method: Valuation,
  m: MoveRef,
  qty: Dec,
  value: Dec,
) {
  await balance(tx, m.storeId, m.resourceId);
  const id = await record(tx, m, qty, value);
  if (method === 'fifo')
    await tx`INSERT INTO proc.stock_layer (store_id, resource_id, move_id, qty, qty_left, value_left)
      VALUES (${m.storeId}, ${m.resourceId}, ${id}, ${fmt(qty, 4)}, ${fmt(qty, 4)}, ${fmt(value, 2)})`;
  return id;
}

async function shortage(
  tx: TransactionSql,
  resourceId: string,
  have: Dec,
  want: Dec,
): Promise<never> {
  const [r] = await tx<{ name: string; unit: string }[]>`
    SELECT name, unit FROM est.resource WHERE id = ${resourceId}`;
  throw new ConflictException({
    code: 'not_in_stock',
    message: `${r?.name ?? 'That material'}: ${fmt(have, 4, 0)} ${r?.unit ?? ''} in the store, not ${fmt(want, 4, 0)}.`,
  });
}

/** Stock out, valued by the tenant's method. Returns the value taken out (positive). */
export async function stockOut(
  tx: TransactionSql,
  method: Valuation,
  m: MoveRef,
  qty: Dec,
): Promise<Dec> {
  const b = await balance(tx, m.storeId, m.resourceId);
  if (qty > b.qty) return shortage(tx, m.resourceId, b.qty, qty);
  let value: Dec;
  if (method === 'average') {
    value = qty === b.qty ? b.value : share(b.value, qty, b.qty);
  } else {
    value = 0n;
    let left = qty;
    const lots = await tx<{ id: string; qty_left: string; value_left: string }[]>`
      SELECT id::text AS id, qty_left::text AS qty_left, value_left::text AS value_left FROM proc.stock_layer
      WHERE store_id = ${m.storeId} AND resource_id = ${m.resourceId} AND qty_left > 0
      ORDER BY id FOR UPDATE`;
    for (const lot of lots) {
      if (left === 0n) break;
      const [q, v] = [dec(lot.qty_left), dec(lot.value_left)];
      const take = left < q ? left : q;
      const part = take === q ? v : share(v, take, q);
      await tx`UPDATE proc.stock_layer SET qty_left = qty_left - ${fmt(take, 4)},
        value_left = value_left - ${fmt(part, 2)} WHERE id = ${lot.id}`;
      value += part;
      left -= take;
    }
    if (left > 0n) return shortage(tx, m.resourceId, qty - left, qty);
  }
  await record(tx, m, -qty, -value);
  return value;
}

/**
 * Takes back exactly what a move brought in (a receipt cancelled): with FIFO its own lot, untouched; with the
 * average, its quantity at the value it came in at (all that is left when it is the last of it), so a cancelled
 * receipt leaves nothing behind in the store's value. Refused when there is not that much left.
 */
export async function reverseIn(tx: TransactionSql, method: Valuation, moveId: string, m: MoveRef) {
  const [mv] = await tx<{ qty: string; value: string }[]>`
    SELECT qty::text AS qty, value::text AS value FROM proc.stock_move WHERE id = ${moveId}`;
  const qty = dec(mv!.qty);
  if (method === 'average') {
    const b = await balance(tx, m.storeId, m.resourceId);
    if (qty > b.qty) return shortage(tx, m.resourceId, b.qty, qty);
    const came = dec(mv!.value);
    const value = qty === b.qty || came > b.value ? b.value : came;
    await record(tx, m, -qty, -value);
    return value;
  }
  const [lot] = await tx<{ id: string; qty_left: string; value_left: string }[]>`
    SELECT id::text AS id, qty_left::text AS qty_left, value_left::text AS value_left FROM proc.stock_layer
    WHERE move_id = ${moveId} FOR UPDATE`;
  if (!lot || dec(lot.qty_left) !== qty)
    throw new ConflictException({
      code: 'stock_used',
      message: 'Some of what it brought in has already gone out of the store.',
    });
  await balance(tx, m.storeId, m.resourceId);
  await tx`UPDATE proc.stock_layer SET qty_left = 0, value_left = 0 WHERE id = ${lot.id}`;
  await record(tx, m, -qty, -dec(lot.value_left));
  return dec(lot.value_left);
}

/** What a unit is worth in the store now (the average), or the last price it came in at, or the library rate. */
export async function unitCost(db: Db, storeId: string, resourceId: string): Promise<Dec> {
  const [b] = await db<{ qty: string; value: string }[]>`
    SELECT qty::text AS qty, value::text AS value FROM proc.stock_balance
    WHERE store_id = ${storeId} AND resource_id = ${resourceId}`;
  if (b && dec(b.qty) > 0n) return (dec(b.value) * 10n ** 12n) / dec(b.qty);
  const [last] = await db<{ qty: string; value: string }[]>`
    SELECT qty::text AS qty, value::text AS value FROM proc.stock_move
    WHERE resource_id = ${resourceId} AND qty > 0 AND kind IN ('receipt', 'transfer_in')
    ORDER BY id DESC LIMIT 1`;
  if (last) return (dec(last.value) * 10n ** 12n) / dec(last.qty);
  const [rate] = await db<{ rate: string }[]>`
    SELECT rate::text AS rate FROM est.resource_rate WHERE resource_id = ${resourceId}
    ORDER BY effective_from DESC LIMIT 1`;
  return rate ? dec(rate.rate) : 0n;
}
