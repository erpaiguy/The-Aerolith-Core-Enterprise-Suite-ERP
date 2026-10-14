// Bulk imports (docs/wave7-plan.md step 7c.8): parties, employees, contract workers and resources from an Excel
// sheet. The first row names the columns (in any order, with the usual spellings); each row is checked and shown
// before anything is saved, and then saved through the same services as a screen entry, so every rule still holds.
// A row that fails is reported with its reason; the others are saved.
import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { HrService } from '../hr/hr.service.js';
import { LabourService } from '../labour/labour.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { RatesService } from '../rates/rates.service.js';
import { TenderService } from '../tender/tender.service.js';

export const IMPORT_KINDS = ['parties', 'employees', 'workers', 'resources'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Each kind's columns: the field, the headings it may go by, and whether it must be there. */
const COLUMNS: Record<ImportKind, { field: string; heads: string[]; required?: boolean }[]> = {
  parties: [
    { field: 'name', heads: ['name', 'party', 'party name'], required: true },
    { field: 'kinds', heads: ['kind', 'kinds', 'type', 'role'] },
    { field: 'gstin', heads: ['gstin', 'gst', 'gst no'] },
    { field: 'pan', heads: ['pan'] },
    { field: 'contactName', heads: ['contact', 'contact name', 'contact person'] },
    { field: 'email', heads: ['email', 'e-mail'] },
    { field: 'phone', heads: ['phone', 'mobile', 'phone no'] },
    { field: 'address', heads: ['address'] },
    { field: 'city', heads: ['city', 'town'] },
  ],
  employees: [
    { field: 'code', heads: ['code', 'employee code', 'emp code'], required: true },
    { field: 'name', heads: ['name', 'employee', 'employee name'], required: true },
    { field: 'joinedOn', heads: ['joined', 'joined on', 'date of joining', 'doj'], required: true },
    { field: 'kind', heads: ['kind', 'type', 'staff or worker'] },
    { field: 'department', heads: ['department', 'dept'] },
    { field: 'grade', heads: ['grade'] },
    { field: 'phone', heads: ['phone', 'mobile'] },
    { field: 'email', heads: ['email', 'e-mail'] },
    { field: 'pan', heads: ['pan'] },
    { field: 'uan', heads: ['uan'] },
    { field: 'bankAccount', heads: ['bank account', 'account no', 'a/c no'] },
    { field: 'bankIfsc', heads: ['ifsc', 'bank ifsc'] },
  ],
  workers: [
    { field: 'contractor', heads: ['contractor', 'labour contractor'], required: true },
    { field: 'name', heads: ['name', 'worker', 'worker name'], required: true },
    { field: 'relative', heads: ['father or husband', "father's name", 'relative', 'guardian'] },
    { field: 'trade', heads: ['trade'], required: true },
    { field: 'skill', heads: ['skill', 'skill level'] },
    { field: 'dailyWage', heads: ['daily wage', 'wage', 'rate'], required: true },
    { field: 'joinedOn', heads: ['joined', 'joined on', 'date of joining'], required: true },
  ],
  resources: [
    { field: 'code', heads: ['code', 'resource code'], required: true },
    { field: 'name', heads: ['name', 'description', 'resource'], required: true },
    { field: 'kind', heads: ['kind', 'type', 'category'], required: true },
    { field: 'unit', heads: ['unit', 'uom'], required: true },
    { field: 'rate', heads: ['rate', 'rate (₹)', 'price'] },
    { field: 'effectiveFrom', heads: ['from', 'rate from', 'effective from'] },
  ],
};

const text = (v: unknown) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && 'result' in (v as object))
    return text((v as { result: unknown }).result);
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'text' in (v as object))
    return String((v as { text: unknown }).text);
  return String(v).trim();
};
/** 2026-04-01, 01/04/2026 or 1-4-2026 (Indian day first) as an ISO date. */
const day = (v: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : v;
};
const opt = (v: string) => (v === '' ? null : v);
const money = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/, 'An amount like 650 or 650.50');
const iso = z.iso.date('A date like 2026-04-01 or 01/04/2026');

const ROW: Record<ImportKind, z.ZodType> = {
  parties: z.object({
    name: z.string().min(2).max(200),
    kinds: z.string(),
    gstin: z.string().nullable(),
    pan: z.string().nullable(),
    contactName: z.string().nullable(),
    email: z.email().nullable(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
    city: z.string(),
  }),
  employees: z.object({
    code: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9./-]{0,19}$/,
        'Up to 20 letters, digits, dots, slashes or dashes',
      ),
    name: z.string().min(2).max(200),
    joinedOn: iso,
    kind: z.enum(['staff', 'worker']),
    department: z.string(),
    grade: z.string(),
    phone: z.string().nullable(),
    email: z.email().nullable(),
    pan: z.string().nullable(),
    uan: z.string().nullable(),
    bankAccount: z.string().nullable(),
    bankIfsc: z.string().nullable(),
  }),
  workers: z.object({
    contractor: z.string().min(2),
    name: z.string().min(2).max(200),
    relative: z.string(),
    trade: z.string().min(1).max(100),
    skill: z.enum(['unskilled', 'semi_skilled', 'skilled', 'highly_skilled']),
    dailyWage: money,
    joinedOn: iso,
  }),
  resources: z.object({
    code: z.string().min(1).max(40),
    name: z.string().min(1).max(500),
    kind: z.enum(['material', 'labour', 'equipment', 'subcontract', 'other']),
    unit: z.string().min(1).max(20),
    rate: money.nullable(),
    effectiveFrom: iso.nullable(),
  }),
};

/** A sheet's cells as each kind's fields, normalised (dates, yes/no, lower-case choices). */
function shape(kind: ImportKind, raw: Record<string, string>) {
  const r = { ...raw };
  const lower = (k: string) => (r[k] ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (kind === 'parties')
    return {
      name: r.name ?? '',
      kinds: (r.kinds ?? '').toLowerCase() || 'client',
      gstin: opt((r.gstin ?? '').toUpperCase()),
      pan: opt((r.pan ?? '').toUpperCase()),
      contactName: opt(r.contactName ?? ''),
      email: opt(r.email ?? ''),
      phone: opt(r.phone ?? ''),
      address: opt(r.address ?? ''),
      city: r.city ?? '',
    };
  if (kind === 'employees')
    return {
      code: r.code ?? '',
      name: r.name ?? '',
      joinedOn: day(r.joinedOn ?? ''),
      kind: lower('kind') || 'staff',
      department: r.department ?? '',
      grade: r.grade ?? '',
      phone: opt(r.phone ?? ''),
      email: opt(r.email ?? ''),
      pan: opt((r.pan ?? '').toUpperCase()),
      uan: opt(r.uan ?? ''),
      bankAccount: opt(r.bankAccount ?? ''),
      bankIfsc: opt((r.bankIfsc ?? '').toUpperCase()),
    };
  if (kind === 'workers')
    return {
      contractor: r.contractor ?? '',
      name: r.name ?? '',
      relative: r.relative ?? '',
      trade: r.trade ?? '',
      skill: lower('skill') || 'unskilled',
      dailyWage: r.dailyWage ?? '',
      joinedOn: day(r.joinedOn ?? ''),
    };
  return {
    code: r.code ?? '',
    name: r.name ?? '',
    kind: lower('kind'),
    unit: r.unit ?? '',
    rate: opt(r.rate ?? ''),
    effectiveFrom: r.effectiveFrom ? day(r.effectiveFrom) : null,
  };
}

export interface ImportRow {
  rowNo: number;
  values: Record<string, unknown>;
  problem: string | null;
  saved?: boolean;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly tenders: TenderService,
    private readonly hr: HrService,
    private readonly labour: LabourService,
    private readonly rates: RatesService,
  ) {}

  /** The sheet read and each row checked; nothing saved. */
  async read(kind: ImportKind, buf: Buffer): Promise<{ columns: string[]; rows: ImportRow[] }> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException({
        code: 'not_xlsx',
        message: 'Send an Excel workbook (.xlsx).',
      });
    }
    const ws = wb.worksheets[0];
    if (!ws)
      throw new BadRequestException({ code: 'empty', message: 'The workbook has no sheet.' });
    const cols = COLUMNS[kind];
    let map: Map<number, string> | null = null;
    const rows: ImportRow[] = [];
    ws.eachRow((r, rowNo) => {
      const cells = Array.from({ length: r.cellCount }, (_, i) => text(r.getCell(i + 1).value));
      if (!map) {
        map = new Map();
        cells.forEach((h, i) => {
          const c = cols.find((x) => x.heads.includes(h.toLowerCase().trim()));
          if (c) map!.set(i, c.field);
        });
        const found = [...map.values()];
        const missing = cols.filter((c) => c.required && !found.includes(c.field));
        if (missing.length)
          throw new BadRequestException({
            code: 'missing_columns',
            message: `Head the columns ${missing.map((c) => c.heads[0]).join(', ')} in the first row.`,
          });
        return;
      }
      if (cells.every((c) => c === '')) return;
      const raw: Record<string, string> = {};
      for (const [i, f] of map) raw[f] = cells[i] ?? '';
      const values = shape(kind, raw);
      const ok = ROW[kind].safeParse(values);
      rows.push({
        rowNo,
        values,
        problem: ok.success
          ? null
          : ok.error.issues.map((x) => `${String(x.path[0] ?? '')}: ${x.message}`).join('; '),
      });
    });
    if (!map) throw new BadRequestException({ code: 'empty', message: 'The sheet is empty.' });
    if (rows.length > 2000)
      throw new BadRequestException({
        code: 'too_many',
        message: 'Import up to 2,000 rows at a time.',
      });
    return { columns: [...new Set([...(map as Map<number, string>).values()])], rows };
  }

  /** Checked rows saved one by one through the usual services; each row's outcome reported. */
  async apply(claims: TenantClaims, kind: ImportKind, entityId: string | null, rows: ImportRow[]) {
    const db = await this.tenants.forTenant(claims.ten);
    const contractors = new Map<string, string>();
    if (kind === 'workers')
      for (const c of await db<{ party_id: string; name: string }[]>`
        SELECT c.party_id, p.name FROM lab.contractor c JOIN platform.party p ON p.id = c.party_id`)
        contractors.set(c.name.toLowerCase(), c.party_id);
    if (kind === 'employees' && !entityId)
      throw new BadRequestException({
        code: 'no_company',
        message: 'Choose the company they work for.',
      });
    for (const row of rows) {
      if (row.problem) continue;
      const v = row.values as Record<string, string | null>;
      const g = (k: string): string | null => v[k] ?? null;
      try {
        if (kind === 'parties') {
          const k = (v.kinds ?? '').toString();
          await this.tenders.createParty(claims, {
            name: v.name!,
            isClient: /client|customer/.test(k),
            isVendor: /vendor|supplier/.test(k),
            isSubcontractor: /sub/.test(k),
            isCompetitor: /competitor/.test(k),
            gstin: g('gstin'),
            pan: g('pan'),
            contactName: g('contactName'),
            email: g('email'),
            phone: g('phone'),
            address: g('address'),
            notes: '',
            city: v.city ?? '',
          });
        } else if (kind === 'employees') {
          await this.hr.createEmployee(claims, {
            entityId: entityId!,
            code: v.code!,
            name: v.name!,
            kind: v.kind as 'staff' | 'worker',
            gender: null,
            birthDate: null,
            phone: g('phone'),
            email: g('email'),
            address: null,
            joinedOn: v.joinedOn!,
            leftOn: null,
            grade: v.grade ?? '',
            designationId: null,
            department: v.department ?? '',
            managerId: null,
            userId: null,
            pan: g('pan'),
            uan: g('uan'),
            esiNumber: null,
            aadhaarLast4: null,
            aadhaarConsentOn: null,
            bankAccount: g('bankAccount'),
            bankIfsc: g('bankIfsc'),
            bankName: '',
          });
        } else if (kind === 'workers') {
          const party = contractors.get((v.contractor ?? '').toLowerCase());
          if (!party) throw new Error(`No labour contractor called ${v.contractor}.`);
          await this.labour.addWorker(claims, party, {
            name: v.name!,
            relative: v.relative ?? '',
            gender: null,
            birthDate: null,
            trade: v.trade!,
            skill: v.skill as 'unskilled',
            dailyWage: v.dailyWage!,
            aadhaarLast4: null,
            aadhaarConsentOn: null,
            uan: null,
            esiNumber: null,
            joinedOn: v.joinedOn!,
          });
        } else {
          await this.rates.createResource(claims, {
            code: v.code!,
            name: v.name!,
            kind: v.kind as 'material',
            unit: v.unit!,
            ...(v.rate
              ? {
                  rate: v.rate,
                  effectiveFrom: v.effectiveFrom ?? new Date().toISOString().slice(0, 10),
                }
              : {}),
          });
        }
        row.saved = true;
      } catch (err) {
        const e = err as { response?: { message?: string; code?: string }; message?: string };
        row.problem = e.response?.message ?? e.response?.code ?? e.message ?? 'Could not be saved.';
        row.saved = false;
      }
    }
    return {
      rows,
      saved: rows.filter((r) => r.saved).length,
      failed: rows.filter((r) => r.problem).length,
    };
  }
}
