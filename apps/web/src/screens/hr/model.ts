// HR's shapes (docs/wave3-plan.md step 11), as the API returns them.
import type { Approval } from '../../approvals/model';

export interface EmployeeRow {
  id: string;
  code: string;
  name: string;
  kind: 'staff' | 'worker';
  designation: string | null;
  department: string;
  grade: string;
  joinedOn: string;
  leftOn: string | null;
  manager: string | null;
  username: string | null;
  place: {
    from: string;
    project: string | null;
    projectName: string | null;
    site: string | null;
  } | null;
}
export interface Employee {
  id: string;
  entityId: string;
  code: string;
  name: string;
  kind: 'staff' | 'worker';
  gender: string | null;
  birthDate: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  joinedOn: string;
  leftOn: string | null;
  grade: string;
  designationId: string | null;
  designation: string | null;
  department: string;
  managerId: string | null;
  manager: string | null;
  userId: string | null;
  username: string | null;
  pan: string | null;
  uan: string | null;
  esiNumber: string | null;
  aadhaarLast4: string | null;
  aadhaarConsentOn: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  bankName: string;
  rowVersion: number;
  masked: boolean;
  deployments: {
    from: string;
    projectId: string | null;
    project: string | null;
    projectName: string | null;
    siteId: string | null;
    site: string | null;
  }[];
}
export interface Designation {
  id: string;
  name: string;
  permissions: string[];
  holders: number;
  rowVersion: number;
}
export interface Calendar {
  id: string;
  name: string;
  workWeek: number;
  isDefault: boolean;
  holidays: { day: string; name: string }[];
  sites: { siteId: string; site: string; project: string }[];
}
export interface HrSite {
  id: string;
  name: string;
  projectId: string;
  project: string;
  projectName: string;
  calendarId: string | null;
  calendar: string | null;
  latitude: string | null;
  longitude: string | null;
  radiusM: number | null;
}
export interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: string;
  accrual: 'annual' | 'monthly';
  carryForwardMax: string;
  active: boolean;
}
export interface Balance {
  leaveTypeId: string;
  code: string;
  name: string;
  paid: boolean;
  opening: string;
  carried: boolean;
  accrued: string;
  taken: string;
  pending: string;
  available: string | null;
}
export interface LeaveApplicationRow {
  id: string;
  employeeId?: string;
  employeeCode?: string;
  employee?: string;
  code: string;
  leaveType: string;
  from: string;
  to: string;
  halfDay: boolean;
  days: string;
  reason: string;
  status: string;
}
export interface EmployeeLeave {
  employee: { id: string; code: string; name: string };
  year: number;
  asOf: string;
  balances: Balance[];
  applications: LeaveApplicationRow[];
}
export interface LeaveDetail {
  id: string;
  employeeCode: string;
  employee: string;
  leaveType: string;
  paid: boolean;
  from: string;
  to: string;
  halfDay: boolean;
  days: string;
  reason: string;
  status: string;
  approval: Approval | null;
  mayWithdraw: boolean;
  mayCancel: boolean;
}
export interface MonthRow {
  employeeId: string;
  code: string;
  name: string;
  codes: string[];
  present: string;
  onDuty: string;
  halfDays: string;
  paidLeave: string;
  unpaidLeave: string;
  holidays: string;
  weeklyOffs: string;
  absent: string;
  payable: string;
  daysInService: string;
  flagged: number;
}
export interface RegisterRow {
  employeeId: string;
  code: string;
  name: string;
  day: 'work' | 'holiday' | 'week_off';
  holiday: string | null;
  leave: string | null;
  status: 'present' | 'half_day' | 'absent' | 'on_duty' | null;
  inTime: string | null;
  outTime: string | null;
  source: string | null;
  flag: string | null;
  note: string;
}
export interface Me {
  employee: { id: string; code: string; name: string } | null;
  day?: string;
  kind?: 'work' | 'holiday' | 'week_off';
  site?: { name: string; project: string; located: boolean } | null;
  today?: {
    status: string;
    inTime: string | null;
    outTime: string | null;
    source: string;
    flag: string | null;
    distanceM: number | null;
  } | null;
  recent?: {
    day: string;
    status: string;
    inTime: string | null;
    outTime: string | null;
    flag: string | null;
  }[];
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const STATUS_LABEL: Record<string, string> = {
  present: 'Present',
  half_day: 'Half day',
  absent: 'Absent',
  on_duty: 'On duty',
};
export const FLAG_LABEL: Record<string, string> = {
  single_punch: 'One punch only',
  outside_site: 'Away from the site',
  no_site_location: 'Site has no location',
};
