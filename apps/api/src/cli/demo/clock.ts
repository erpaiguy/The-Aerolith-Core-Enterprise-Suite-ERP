// The demo's history is replayed through the API's own routes on a simulated clock: while a day of 2024 is being
// replayed, `new Date()` and `Date.now()` in this process say it is that day, so document numbers carry that day's
// financial year and "not in the future" checks hold against that day. The database's own now() still says today;
// fixups.ts moves those stamps afterwards. Only this CLI process is affected, never the running server.
const RealDate = Date;
let simulated: number | null = null;

class SimulatedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(simulated ?? RealDate.now());
    else super(...(args as [string | number | Date]));
  }
  static override now(): number {
    return simulated ?? RealDate.now();
  }
}

let installed = false;
// Sign-ins made before the replay stay good while the simulated clock never passes the moment it started.
let startedAt = RealDate.now();
export function installClock(): void {
  if (installed) return;
  startedAt = RealDate.now();
  globalThis.Date = SimulatedDate as unknown as DateConstructor;
  installed = true;
}

/** Sets the simulated moment; null returns to the real clock. Never later than when the replay started. */
export function setClock(at: Date | number | null): void {
  if (at === null) {
    simulated = null;
    return;
  }
  const t = typeof at === 'number' ? at : at.getTime();
  simulated = Math.min(t, startedAt - 60_000);
}

export const realNow = (): number => RealDate.now();
