// What every part of the demo history shares: the in-process API, who is signed in, the ids made so far, a calendar
// of things still to do, and a tally of steps that failed (reported once per kind, the rest carry on).
import type { Sql } from 'postgres';
import type { Seeder } from '../demo-seed.js';
import type { ProjectPlan } from './plan.js';
import { type Day, type Rng, atWork } from './util.js';
import { setClock } from './clock.js';

export type H = Record<string, string>;

export interface Person {
  id: string;
  h: H;
  username: string;
}

export interface ItemState {
  code: string;
  nodeId: string;
  lineKey: string;
  unit: string;
  qty: number;
  rate: number;
  window: [number, number];
  analysis?: string;
  labourRate?: number;
  /** Quantity measured so far (contract book) and on each work order. */
  measured: number;
  woMeasured: Record<string, number>;
}

export interface ProjectState {
  plan: ProjectPlan;
  id: string;
  tenderId: string;
  rowVersion: number;
  siteId: string;
  storeId?: string;
  contractBoqId?: string;
  budgetBoqId?: string;
  contractValue: number;
  items: ItemState[];
  wbs: Record<string, string>; // section code → WBS code
  scheduleId?: string;
  activities: Record<string, string>; // section code → activity id
  contractId?: string;
  /** Work orders by contractor key. */
  wo: Record<string, { id: string; lines: Record<string, string>; number: string }>;
  /** Stock on hand in the site store, by resource code (kept here so issues never exceed it). */
  stock: Record<string, number>;
  /** Material ordered and not yet received or issued, by resource code. */
  onOrder: Record<string, number>;
  end: Day; // when the work is (or will be) complete
  team: string[];
  status: 'planned' | 'active' | 'completed';
  billedUpto?: Day;
  bills: { id: string; net: number; tds: number; certifiedOn: Day; received: boolean }[];
  advanceLeft: number;
}

export interface Failure {
  count: number;
  first: string[];
}

export class Scheduler {
  private readonly q = new Map<Day, { order: number; label: string; fn: () => Promise<unknown> }[]>();
  at(day: Day, order: number, label: string, fn: () => Promise<unknown>): void {
    const list = this.q.get(day) ?? [];
    list.push({ order, label, fn });
    this.q.set(day, list);
  }
  take(day: Day, upto: number) {
    const list = this.q.get(day) ?? [];
    const now = list.filter((e) => e.order <= upto).sort((a, b) => a.order - b.order);
    this.q.set(
      day,
      list.filter((e) => e.order > upto),
    );
    return now;
  }
}

export interface Ctx {
  s: Seeder;
  db: Sql;
  r: Rng;
  admin: H;
  users: Record<string, Person>;
  entityId: string;
  today: Day;
  bank: string;
  acc: Record<string, string>;
  party: Record<string, string>;
  res: Record<string, { id: string; rate: (d: Day) => number }>;
  ana: Record<string, string>;
  projects: Record<string, ProjectState>;
  emp: Record<string, { id: string; rowVersion: number; userId?: string }>;
  sched: Scheduler;
  failures: Map<string, Failure>;
  paths: string[];
  costCodes: Record<string, string>;
  counts: Record<string, number>;
  /** When each record was made, by id (shared with the seeder, which notes every new id). */
  stamps: Map<string, number>;
}

export const as = (c: Ctx, username: string): H => c.users[username]?.h ?? c.admin;

/** One step; a failure is tallied under its label and the history carries on. */
export async function step<T>(
  c: Ctx,
  label: string,
  f: () => Promise<T>,
  /** Answers that only mean "nothing to do today". */
  quiet?: RegExp,
): Promise<T | undefined> {
  try {
    return await f();
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 400) : String(err);
    if (quiet?.test(msg)) return undefined;
    const kind = label.replace(/ [0-9a-f-]{8,}.*$/, '');
    const f0 = c.failures.get(kind) ?? { count: 0, first: [] };
    f0.count++;
    if (f0.first.length < 3) {
      f0.first.push(`${label}: ${msg}`);
      process.stdout.write(`  ! ${label}: ${msg}\n`);
    }
    c.failures.set(kind, f0);
    return undefined;
  }
}

export const bump = (c: Ctx, what: string, n = 1) => {
  c.counts[what] = (c.counts[what] ?? 0) + n;
};

/** Sets the simulated clock to the working day. */
export const on = (d: Day, hour = 11) => setClock(atWork(d, hour));

/** Waits for in-process background work (the tender BOQ copy). */
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
