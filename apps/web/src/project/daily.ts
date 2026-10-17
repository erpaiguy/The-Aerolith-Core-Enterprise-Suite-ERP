// Daily site reports as the screens see them (docs/wave2b-plan.md step 7).
export type Weather = 'clear' | 'cloudy' | 'rain' | 'heavy_rain' | 'storm';
export type Cause =
  | 'rain'
  | 'drawings'
  | 'client_decision'
  | 'materials'
  | 'labour'
  | 'equipment'
  | 'power_water'
  | 'site_access'
  | 'other';
export type Account = 'client' | 'contractor' | 'neutral';
export type DsrStatus = 'draft' | 'submitted' | 'acknowledged';

export const WEATHER: Record<Weather, string> = {
  clear: 'Clear',
  cloudy: 'Cloudy',
  rain: 'Rain',
  heavy_rain: 'Heavy rain',
  storm: 'Storm',
};
export const CAUSE: Record<Cause, string> = {
  rain: 'Rain',
  drawings: 'Drawings awaited',
  client_decision: "Client's decision awaited",
  materials: 'Materials short',
  labour: 'Labour short',
  equipment: 'Equipment breakdown',
  power_water: 'Power or water',
  site_access: 'Site access',
  other: 'Other',
};
export const ACCOUNT: Record<Account, string> = {
  client: "Client's account",
  contractor: 'Our account',
  neutral: 'Neither (weather, force majeure)',
};
export const DSR_STATUS: Record<DsrStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  acknowledged: 'Acknowledged',
};
export const DSR_TONE: Record<DsrStatus, 'neutral' | 'warning' | 'success'> = {
  draft: 'neutral',
  submitted: 'warning',
  acknowledged: 'success',
};
export const TRADES = [
  'Mason',
  'Helper',
  'Carpenter',
  'Bar bender',
  'Fitter',
  'Welder',
  'Electrician',
  'Plumber',
  'Painter',
  'Tile layer',
  'Supervisor',
  'Engineer',
];

export interface ManpowerLine {
  trade: string;
  partyId: string | null;
  contractor?: string | null;
  headcount: number;
  note: string;
}
export interface EquipmentLine {
  name: string;
  ownership: 'own' | 'hired';
  count: number;
  hoursWorked: string;
  hoursIdle: string;
  idleReason: string;
}
export interface WorkLine {
  boqCode: string | null;
  description: string;
  qty: string | null;
  unit: string;
}
export interface HindranceLine {
  cause: Cause;
  description: string;
  hours: string;
  account: Account;
}

export interface DailyReport {
  id: string;
  reportDate: string;
  status: DsrStatus;
  weatherAm: Weather | null;
  weatherPm: Weather | null;
  rainHours: string | null;
  safety: string;
  visitors: string;
  notes: string;
  rowVersion: number;
  project: { id: string; number: string; name: string };
  site: { id: string; name: string };
  submittedBy: string | null;
  submittedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  updatedBy: string | null;
  updatedAt: string;
  manpower: ManpowerLine[];
  equipment: EquipmentLine[];
  /** The machines' log sheets at the site that day (docs/wave3-plan.md step 10). */
  equipmentLogs?: {
    code: string;
    name: string;
    ownership: 'own' | 'hired';
    worked: string;
    idleHours: string;
    idleReason: string;
    breakdownHours: string;
    operator: string;
  }[];
  /** The contract labour mustered at the site that day (docs/wave3-plan.md step 13). */
  muster?: {
    contractor: string;
    trade: string;
    present: number;
    halfDays: number;
    overtimeHours: string;
  }[];
  work: WorkLine[];
  hindrances: HindranceLine[];
  photos: {
    id: string;
    caption: string;
    mime: string;
    size: number;
    createdAt: string;
    /** When and where it was taken, as the phone gave them (step 8d.4). */
    takenAt: string | null;
    latitude: number | null;
    longitude: number | null;
    accuracyM: number | null;
  }[];
  events: {
    kind: 'submitted' | 'acknowledged' | 'corrected';
    comment: string | null;
    actor: string | null;
    at: string;
  }[];
  received: {
    receiptId: string;
    number: string;
    vendor: string;
    description: string;
    unit: string;
    qty: string;
    accepted: string;
    rejected: string;
    inspection: string;
  }[];
  issued: {
    issueId: string;
    number: string;
    wbsCode: string;
    name: string;
    unit: string;
    qty: string;
  }[];
  mayEdit: boolean;
  maySubmit: boolean;
  mayAcknowledge: boolean;
  mayCorrect: boolean;
}

export interface DailyReportRow {
  id: string;
  reportDate: string;
  status: DsrStatus;
  site: { id: string; name: string };
  headcount: number;
  hindranceHours: string;
  photos: number;
}

export interface DailyReportList {
  reports: DailyReportRow[];
  missing: { site: { id: string; name: string }; days: string[] }[];
  mayWrite: boolean;
}

export const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
