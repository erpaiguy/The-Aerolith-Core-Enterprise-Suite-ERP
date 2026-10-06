// Synthetic data generators that stream straight into COPY. No row is held in memory as an object graph.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Sql } from 'postgres';
import { childKey, segmentFor } from './sortkey.js';
import { one } from './stats.js';

/** Small deterministic PRNG (mulberry32) so runs are repeatable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORKS = [
  'Excavation in ordinary soil',
  'PCC M10 bed',
  'RCC M25 in columns',
  'RCC M30 in slabs',
  'TMT Fe500D reinforcement',
  'Shuttering for beams',
  'AAC block masonry 200mm',
  'Brickwork in CM 1:6',
  'Internal plaster 12mm',
  'External plaster 20mm',
  'Vitrified tile flooring 600x600',
  'Granite flooring 18mm',
  'Gypsum false ceiling',
  'Acrylic emulsion paint',
  'Waterproofing APP membrane',
  'uPVC sliding window',
  'Teak wood door frame',
  'CPVC water supply piping',
  'GI conduit 25mm',
  'FRLS copper wiring 2.5 sq mm',
  'Fire sprinkler pendant',
  'Modular kitchen carcass',
  'Wardrobe shutter laminate',
  'HVAC ducting GI 24G',
  'Anti-termite treatment',
];
const PLACES = [
  'basement',
  'ground floor',
  'first floor',
  'second floor',
  'terrace',
  'staircase',
  'lift core',
  'podium',
  'tower A',
  'tower B',
];
const UNITS = ['cum', 'sqm', 'rmt', 'kg', 'nos', 'MT', 'sqft', 'each'];

const esc = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
const cell = (v: string | number | null): string =>
  v === null ? '\\N' : typeof v === 'number' ? String(v) : esc(v);

export interface BoqShape {
  bills: number;
  sections: number;
  subsections: number;
  itemsPerSubsection: number;
}

/** 1,000,000 items: 10 bills x 20 sections x 50 subsections x 100 items, plus 10,210 section rows. */
export const SHAPE_1M: BoqShape = {
  bills: 10,
  sections: 20,
  subsections: 50,
  itemsPerSubsection: 100,
};
/** 200,000 items: 5 x 10 x 40 x 100. */
export const SHAPE_200K: BoqShape = {
  bills: 5,
  sections: 10,
  subsections: 40,
  itemsPerSubsection: 100,
};

export function itemCount(s: BoqShape): number {
  return s.bills * s.sections * s.subsections * s.itemsPerSubsection;
}

/**
 * Streams one BOQ through COPY into the unlogged staging table, then merges it into the real tables
 * (the import path from docs/05-database.md §4). Section subtotals are computed during generation.
 */
export async function importBoq(
  sql: Sql,
  boqId: string,
  shape: BoqShape,
  seed: number,
): Promise<number> {
  const rand = rng(seed);
  const total = itemCount(shape) + shape.bills * (1 + shape.sections * (1 + shape.subsections));
  const { start } = one(
    await sql<{ start: string }[]>`
    SELECT setval('est.boq_node_id_seq', nextval('est.boq_node_id_seq') + ${total}) - ${total} + 1 AS start`,
  );
  let nextId = Number(start);

  async function* rows(): AsyncGenerator<string> {
    const buf: string[] = [];
    const line = (
      id: number,
      parent: number | null,
      path: string,
      key: string,
      depth: number,
      type: string,
      code: string,
      unit: string | null,
      qty: number | null,
      rate: number | null,
      amount: number | null,
      subtotal: number | null,
      description: string,
    ) => {
      const values = [
        id,
        randomUUID(),
        parent,
        path,
        key,
        depth,
        type,
        code,
        unit,
        qty,
        rate,
        amount,
        subtotal,
        description,
      ];
      buf.push(values.map(cell).join('\t') + '\n');
    };
    // Sections are written after their children so their subtotal is known; row order in the table doesn't matter.
    for (let b = 0; b < shape.bills; b++) {
      const billId = nextId++;
      const billKey = segmentFor(b + 1);
      const billPath = `n${billId}`;
      let billTotal = 0;
      for (let s = 0; s < shape.sections; s++) {
        const secId = nextId++;
        const secKey = childKey(billKey, segmentFor(s + 1));
        const secPath = `${billPath}.n${secId}`;
        let secTotal = 0;
        for (let ss = 0; ss < shape.subsections; ss++) {
          const subId = nextId++;
          const subKey = childKey(secKey, segmentFor(ss + 1));
          const subPath = `${secPath}.n${subId}`;
          let subTotal = 0;
          for (let i = 0; i < shape.itemsPerSubsection; i++) {
            const id = nextId++;
            const qty = Math.round(rand() * 100000) / 100;
            const rate = Math.round(rand() * 500000) / 100;
            const amount = Math.round(qty * rate * 100) / 100;
            subTotal += amount;
            const work = WORKS[Math.floor(rand() * WORKS.length)]!;
            const place = PLACES[Math.floor(rand() * PLACES.length)]!;
            line(
              id,
              subId,
              `${subPath}.n${id}`,
              childKey(subKey, segmentFor(i + 1)),
              3,
              'item',
              `${b + 1}.${s + 1}.${ss + 1}.${i + 1}`,
              UNITS[Math.floor(rand() * UNITS.length)]!,
              qty,
              rate,
              amount,
              null,
              `${work} at ${place}, including all labour, materials, tools and tackles complete as per specification ${Math.floor(rand() * 9000) + 1000}`,
            );
            if (buf.length >= 2000) yield buf.splice(0).join('');
          }
          line(
            subId,
            secId,
            subPath,
            subKey,
            2,
            'section',
            `${b + 1}.${s + 1}.${ss + 1}`,
            null,
            null,
            null,
            null,
            round2(subTotal),
            `Sub-section ${b + 1}.${s + 1}.${ss + 1}`,
          );
          secTotal += subTotal;
        }
        line(
          secId,
          billId,
          secPath,
          secKey,
          1,
          'section',
          `${b + 1}.${s + 1}`,
          null,
          null,
          null,
          null,
          round2(secTotal),
          `Section ${b + 1}.${s + 1}`,
        );
        billTotal += secTotal;
      }
      line(
        billId,
        null,
        billPath,
        billKey,
        0,
        'section',
        `${b + 1}`,
        null,
        null,
        null,
        null,
        round2(billTotal),
        `Bill ${b + 1}`,
      );
    }
    if (buf.length > 0) yield buf.join('');
  }

  await sql`TRUNCATE est.boq_import_stage`;
  const writable = await sql`COPY est.boq_import_stage
    (id, line_key, parent_id, path, sort_key, depth, node_type, code, unit, qty, rate, amount, subtotal, description)
    FROM STDIN`.writable();
  await pipeline(Readable.from(rows()), writable);

  await sql.begin(async (tx) => {
    await tx`INSERT INTO est.boq_node
      (boq_id, id, line_key, parent_id, path, sort_key, depth, node_type, code, unit, qty, rate, amount, subtotal)
      SELECT ${boqId}::uuid, id, line_key, parent_id, path::ltree, sort_key, depth, node_type, code, unit, qty, rate, amount, subtotal
      FROM est.boq_import_stage`;
    await tx`INSERT INTO est.boq_node_text (boq_id, node_id, description)
      SELECT ${boqId}::uuid, id, description FROM est.boq_import_stage`;
    await tx`UPDATE est.boq b SET node_count = ${total},
      total = (SELECT coalesce(sum(subtotal), 0) FROM est.boq_node WHERE boq_id = ${boqId}::uuid AND depth = 0)
      WHERE id = ${boqId}::uuid`;
  });
  await sql`TRUNCATE est.boq_import_stage`;
  return total;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A schedule network: each activity depends on 1-3 earlier activities within a 60-activity window. */
export async function importSchedule(
  sql: Sql,
  planId: string,
  activities: number,
  seed: number,
): Promise<number> {
  const rand = rng(seed);
  const types = ['FS', 'FS', 'FS', 'FS', 'SS', 'FF'] as const;
  async function* acts(): AsyncGenerator<string> {
    const buf: string[] = [];
    for (let i = 0; i < activities; i++) {
      buf.push(
        `${planId}\t${i}\tA${String(i).padStart(6, '0')}\tActivity ${i}\t${1 + Math.floor(rand() * 20)}\n`,
      );
      if (buf.length >= 5000) yield buf.splice(0).join('');
    }
    if (buf.length > 0) yield buf.join('');
  }
  let relationCount = 0;
  async function* rels(): AsyncGenerator<string> {
    const buf: string[] = [];
    for (let i = 1; i < activities; i++) {
      const k = 1 + Math.floor(rand() * 3);
      const seen = new Set<number>();
      for (let j = 0; j < k; j++) {
        const pred = Math.max(0, i - 1 - Math.floor(rand() * 60));
        if (seen.has(pred)) continue;
        seen.add(pred);
        const type = types[Math.floor(rand() * types.length)]!;
        buf.push(`${planId}\t${pred}\t${i}\t${type}\t${Math.floor(rand() * 4)}\n`);
        relationCount++;
      }
      if (buf.length >= 5000) yield buf.splice(0).join('');
    }
    if (buf.length > 0) yield buf.join('');
  }
  await pipeline(
    Readable.from(acts()),
    await sql`COPY sched.activity (plan_id, id, code, name, duration) FROM STDIN`.writable(),
  );
  await pipeline(
    Readable.from(rels()),
    await sql`COPY sched.relation (plan_id, pred_id, succ_id, type, lag) FROM STDIN`.writable(),
  );
  return relationCount;
}
