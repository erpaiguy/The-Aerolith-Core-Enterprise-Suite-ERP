export const APP_NAME = 'Aerolith Core';

export type ServiceStatus = 'ok' | 'degraded' | 'down';

export interface HealthReport {
  service: string;
  status: ServiceStatus;
  version: string;
  time: string;
}

export function buildHealthReport(
  service: string,
  version: string,
  now: Date = new Date(),
): HealthReport {
  return { service, status: 'ok', version, time: now.toISOString() };
}

export * from './licence-key.js';
export * from './sort-key.js';
export * from './schedule.js';
export * from './legal.js';
export * from './release.js';
