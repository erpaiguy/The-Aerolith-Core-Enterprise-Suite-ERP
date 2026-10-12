// Safety's fixed lists and arithmetic (docs/wave3-plan.md step 15): each permit type's precautions, and injury rates
// per million man-hours. Pure. [Guessing] IS 3786's definitions; a safety officer should confirm.

export type PermitKind = 'height' | 'hot_work' | 'confined_space' | 'excavation' | 'electrical';

/** What must be confirmed before a permit of each type is issued. */
export const PRECAUTIONS: Record<PermitKind, string[]> = {
  height: [
    'Full-body harness worn and anchored above the worker',
    'Scaffold or platform inspected and tagged',
    'Guard rails and toe boards in place',
    'Area below barricaded',
  ],
  hot_work: [
    'Combustibles removed or covered within 11 m',
    'Fire extinguisher at the spot',
    'Fire watch posted, staying 30 minutes after',
    'Gas cylinders upright, with flashback arrestors',
  ],
  confined_space: [
    'Atmosphere tested: oxygen, flammable gas, toxic gas',
    'Ventilation running',
    'Attendant outside with rescue equipment',
    'Entrants briefed and logged in and out',
  ],
  excavation: [
    'Underground services located and marked',
    'Sides shored, benched or sloped',
    'Spoil kept 1 m from the edge',
    'Edge barricaded, safe access and exit',
  ],
  electrical: [
    'Circuit isolated, locked and tagged out',
    'Absence of voltage tested',
    'Insulated tools and gloves in use',
    'Earthing in place',
  ],
};

/** Days charged for a fatality (IS 3786). */
export const FATAL_DAYS = 6000;
/** Hours counted for a day's attendance, and for a half day. */
export const DAY_HOURS = 8;

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Frequency rate (lost-time injuries per million man-hours) and severity rate (days lost per million man-hours), a
 * fatality being a lost-time injury with 6,000 days charged.
 */
export function rates(manHours: number, injuries: { kind: string; daysLost: number }[]) {
  const lost = injuries.filter((i) => i.kind === 'lost_time' || i.kind === 'fatal');
  const days = lost.reduce((s, i) => s + (i.kind === 'fatal' ? FATAL_DAYS : i.daysLost), 0);
  return {
    manHours,
    lostTimeInjuries: lost.length,
    daysLost: days,
    frequencyRate: manHours > 0 ? r2((lost.length * 1_000_000) / manHours) : null,
    severityRate: manHours > 0 ? r2((days * 1_000_000) / manHours) : null,
  };
}
