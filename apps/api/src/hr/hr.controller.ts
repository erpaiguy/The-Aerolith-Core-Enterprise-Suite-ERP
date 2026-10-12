import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseCsv } from '../accounts/bank-parse.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AttendanceService, type Mark } from './attendance.service.js';
import { IFSC, PAN } from './hr-rules.js';
import { HrService, type EmployeeInput } from './hr.service.js';
import { LeaveService, type ApplyInput, type LeaveTypeInput } from './leave.service.js';

const date = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month: YYYY-MM');
const year = z.coerce.number().int().min(2000).max(2100);
const text = (max: number) => z.string().trim().max(max);
/** An optional text: blank is none. */
const maybe = <T extends z.ZodType<string>>(t: T) =>
  z.union([z.literal('').transform(() => null), t, z.null()]);
const days = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,3}(\.[05])?$/.test(v), { message: 'Days, in halves' });
const coordinate = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d{1,3}(\.\d{1,6})?$/.test(v), { message: 'Degrees, to six places' });

const employeeFields = {
  code: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9./-]{0,19}$/,
      'Up to 20 letters, digits, dots, slashes or dashes',
    ),
  name: z.string().trim().min(2).max(200),
  kind: z.enum(['staff', 'worker']),
  gender: z.enum(['female', 'male', 'other']).nullable(),
  birthDate: date.nullable(),
  phone: maybe(
    z
      .string()
      .trim()
      .regex(/^[0-9+ -]{6,20}$/, 'A phone number'),
  ),
  email: maybe(z.email().max(200)),
  address: maybe(text(1000)),
  joinedOn: date,
  leftOn: date.nullable(),
  grade: text(40),
  designationId: z.uuid().nullable(),
  department: text(100),
  managerId: z.uuid().nullable(),
  userId: z.uuid().nullable(),
  pan: maybe(
    z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => PAN.test(v), { message: 'A PAN: five letters, four digits, a letter' }),
  ),
  uan: maybe(
    z
      .string()
      .trim()
      .regex(/^\d{12}$/, 'A UAN: 12 digits'),
  ),
  esiNumber: maybe(
    z
      .string()
      .trim()
      .regex(/^\d{10,17}$/, 'An ESI number: 10 to 17 digits'),
  ),
  aadhaarLast4: maybe(
    z
      .string()
      .trim()
      .regex(/^\d{4}$/, "Only Aadhaar's last four digits"),
  ),
  aadhaarConsentOn: date.nullable(),
  bankAccount: maybe(
    z
      .string()
      .trim()
      .regex(/^\d{6,18}$/, 'An account number: 6 to 18 digits'),
  ),
  bankIfsc: maybe(
    z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => IFSC.test(v), { message: 'An IFSC: four letters, 0, six letters or digits' }),
  ),
  bankName: text(100),
};
const employee = z.object({
  entityId: z.uuid(),
  ...employeeFields,
  gender: employeeFields.gender.default(null),
  birthDate: employeeFields.birthDate.default(null),
  phone: employeeFields.phone.default(null),
  email: employeeFields.email.default(null),
  address: employeeFields.address.default(null),
  kind: employeeFields.kind.default('staff'),
  leftOn: employeeFields.leftOn.default(null),
  grade: employeeFields.grade.default(''),
  designationId: employeeFields.designationId.default(null),
  department: employeeFields.department.default(''),
  managerId: employeeFields.managerId.default(null),
  userId: employeeFields.userId.default(null),
  pan: employeeFields.pan.default(null),
  uan: employeeFields.uan.default(null),
  esiNumber: employeeFields.esiNumber.default(null),
  aadhaarLast4: employeeFields.aadhaarLast4.default(null),
  aadhaarConsentOn: employeeFields.aadhaarConsentOn.default(null),
  bankAccount: employeeFields.bankAccount.default(null),
  bankIfsc: employeeFields.bankIfsc.default(null),
  bankName: employeeFields.bankName.default(''),
});
// A masked number sent back as it was shown is not a change.
const unmasked = <T extends z.ZodType>(t: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.includes('•') ? undefined : v), t.optional());
const employeeUpdate = z.object({
  ...Object.fromEntries(Object.entries(employeeFields).map(([k, v]) => [k, v.optional()])),
  pan: unmasked(employeeFields.pan),
  bankAccount: unmasked(employeeFields.bankAccount),
  rowVersion: z.number().int(),
});
const designation = z.object({
  name: z.string().trim().min(2).max(100),
  permissions: z.array(z.string()).max(50).default([]),
  rowVersion: z.number().int().optional(),
});
const calendar = z.object({
  entityId: z.uuid(),
  name: z.string().trim().min(2).max(100),
  workWeek: z.number().int().min(1).max(127),
  isDefault: z.boolean().default(false),
});
const holiday = z.object({ day: date, name: z.string().trim().min(2).max(100).nullable() });
const site = z.object({
  calendarId: z.uuid().nullable().default(null),
  latitude: maybe(coordinate).default(null),
  longitude: maybe(coordinate).default(null),
  radiusM: z.number().int().min(20).max(5000).nullable().default(null),
});
const deployment = z.object({
  from: date,
  projectId: z.uuid().nullable().default(null),
  siteId: z.uuid().nullable().default(null),
});
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time: HH:MM')
  .nullable()
  .default(null);
const marks = z.object({
  date,
  marks: z
    .array(
      z.object({
        employeeId: z.uuid(),
        status: z.enum(['present', 'half_day', 'absent', 'on_duty']).nullable(),
        inTime: time,
        outTime: time,
        note: text(300).default(''),
      }),
    )
    .max(2000),
});
const punch = z.object({
  action: z.enum(['in', 'out']),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const leaveType = z.object({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{1,6}$/.test(v), { message: 'Up to six letters' }),
  name: z.string().trim().min(2).max(60),
  paid: z.boolean().default(true),
  daysPerYear: days.default('0'),
  accrual: z.enum(['annual', 'monthly']).default('annual'),
  carryForwardMax: days.default('0'),
  active: z.boolean().default(true),
});
const apply = z.object({
  employeeId: z.uuid().nullable().default(null),
  leaveTypeId: z.uuid(),
  from: date,
  to: date,
  halfDay: z.boolean().default(false),
  reason: text(500).default(''),
});
const opening = z.object({ year, leaveTypeId: z.uuid(), days });
const entity = z.object({ entityId: z.uuid() });

/** A device's export as rows of text: Excel (dates and times as the device wrote them) or CSV. */
async function tableRows(buf: Buffer) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException({
        code: 'not_xlsx',
        message: 'Not a readable Excel workbook.',
      });
    }
    const rows: string[][] = [];
    wb.worksheets[0]?.eachRow((row) => {
      rows.push(
        Array.from(row.values as ExcelJS.CellValue[], (v) => {
          if (v instanceof Date) {
            // Excel keeps wall-clock times; a time alone sits on 30 December 1899.
            const iso = v.toISOString();
            return iso.startsWith('1899-12-3')
              ? iso.slice(11, 16)
              : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
          }
          if (v === null || v === undefined) return '';
          if (typeof v === 'object' && 'result' in v) return String(v.result);
          if (typeof v === 'object' && 'text' in v) return String(v.text);
          return String(v);
        }).slice(1),
      );
    });
    return rows;
  }
  return parseCsv(buf.toString('utf8').replace(/^\uFEFF/, ''));
}

/** HR (docs/wave3-plan.md step 11). Who may do what is checked by the services. */
@Controller('tenant/hr')
@UseGuards(TenantAuthGuard)
export class HrController {
  constructor(
    private readonly hr: HrService,
    private readonly attendance: AttendanceService,
    private readonly leave: LeaveService,
  ) {}

  // --- designations ---

  /** What a designation may add (for whoever keeps the designations, not only admins). */
  @Get('permissions')
  permissions() {
    return Object.entries(PERMISSIONS).map(([key, p]) => ({ key, label: p.label }));
  }

  @Get('designations')
  designations(@Auth() c: TenantClaims) {
    return this.hr.designations(c);
  }

  @Post('designations')
  @HttpCode(200)
  @RequiresFeatures()
  createDesignation(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(designation)) b: z.infer<typeof designation>,
  ) {
    return this.hr.saveDesignation(c, null, b);
  }

  @Put('designations/:id')
  @RequiresFeatures()
  updateDesignation(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(designation)) b: z.infer<typeof designation>,
  ) {
    return this.hr.saveDesignation(c, id, b);
  }

  // --- employees ---

  @Get('employees')
  employees(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(entity.extend({ all: z.stringbool().default(false) })))
    q: { entityId: string; all: boolean },
  ) {
    return this.hr.listEmployees(c, q.entityId, q.all);
  }

  @Post('employees')
  @HttpCode(200)
  @RequiresFeatures()
  createEmployee(@Auth() c: TenantClaims, @Body(new ZodPipe(employee)) b: EmployeeInput) {
    return this.hr.createEmployee(c, b);
  }

  @Get('employees/:id')
  employee(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.hr.getEmployee(c, id);
  }

  @Put('employees/:id')
  @RequiresFeatures()
  updateEmployee(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(employeeUpdate)) b: Partial<EmployeeInput> & { rowVersion: number },
  ) {
    return this.hr.updateEmployee(c, id, b);
  }

  @Post('employees/:id/deployments')
  @HttpCode(200)
  @RequiresFeatures()
  deploy(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(deployment)) b: z.infer<typeof deployment>,
  ) {
    return this.hr.deploy(c, id, b);
  }

  @Get('employees/:id/leave')
  employeeLeave(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ year, asOf: date.optional() })))
    q: { year: number; asOf?: string },
  ) {
    return this.leave.employeeLeave(c, id, q.year, q.asOf);
  }

  @Put('employees/:id/leave-openings')
  @RequiresFeatures()
  setOpening(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(opening)) b: z.infer<typeof opening>,
  ) {
    return this.leave.setOpening(c, id, b);
  }

  // --- calendars and sites ---

  @Get('calendars')
  calendars(@Auth() c: TenantClaims, @Query(new ZodPipe(entity)) q: { entityId: string }) {
    return this.hr.calendars(c, q.entityId);
  }

  @Post('calendars')
  @HttpCode(200)
  @RequiresFeatures()
  createCalendar(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(calendar)) b: z.infer<typeof calendar>,
  ) {
    return this.hr.saveCalendar(c, null, b);
  }

  @Put('calendars/:id')
  @RequiresFeatures()
  updateCalendar(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(calendar)) b: z.infer<typeof calendar>,
  ) {
    return this.hr.saveCalendar(c, id, b);
  }

  /** A holiday named, renamed, or (name null) taken off. */
  @Put('calendars/:id/holidays')
  @RequiresFeatures()
  holiday(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(holiday)) b: z.infer<typeof holiday>,
  ) {
    return this.hr.setHoliday(c, id, b.day, b.name);
  }

  @Get('sites')
  sites(@Auth() c: TenantClaims, @Query(new ZodPipe(entity)) q: { entityId: string }) {
    return this.hr.sites(c, q.entityId);
  }

  @Put('sites/:id')
  @RequiresFeatures()
  setSite(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(site)) b: z.infer<typeof site>,
  ) {
    return this.hr.setSite(c, id, b);
  }

  // --- attendance ---

  @Get('sites/:id/attendance')
  register(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ date }))) q: { date: string },
  ) {
    return this.attendance.register(c, id, q.date);
  }

  @Post('sites/:id/attendance')
  @HttpCode(200)
  @RequiresFeatures()
  mark(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(marks)) b: { date: string; marks: Mark[] },
  ) {
    return this.attendance.mark(c, id, b.date, b.marks);
  }

  /** multipart/form-data, field `file`: a biometric device's export (CSV or Excel). */
  @Post('attendance/import')
  @HttpCode(200)
  @RequiresFeatures()
  async importPunches(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(entity)) q: { entityId: string },
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the file as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
    return this.attendance.importPunches(c, q.entityId, await tableRows(await file.toBuffer()));
  }

  @Get('attendance/me')
  me(@Auth() c: TenantClaims) {
    return this.attendance.me(c);
  }

  @Post('attendance/me')
  @HttpCode(200)
  @RequiresFeatures()
  punch(@Auth() c: TenantClaims, @Body(new ZodPipe(punch)) b: z.infer<typeof punch>) {
    return this.attendance.punch(c, b);
  }

  @Get('attendance/month')
  month(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(entity.extend({ month }))) q: { entityId: string; month: string },
  ) {
    return this.attendance.month(c, q.entityId, q.month);
  }

  // --- leave ---

  @Get('leave-types')
  leaveTypes(@Auth() c: TenantClaims) {
    return this.leave.types(c);
  }

  @Post('leave-types')
  @HttpCode(200)
  @RequiresFeatures()
  createLeaveType(@Auth() c: TenantClaims, @Body(new ZodPipe(leaveType)) b: LeaveTypeInput) {
    return this.leave.saveType(c, null, b);
  }

  @Put('leave-types/:id')
  @RequiresFeatures()
  updateLeaveType(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(leaveType)) b: LeaveTypeInput,
  ) {
    return this.leave.saveType(c, id, b);
  }

  @Get('leave')
  leaveList(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        entity.extend({
          status: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'cancelled']).optional(),
        }),
      ),
    )
    q: { entityId: string; status?: string },
  ) {
    return this.leave.list(c, q.entityId, q.status ?? null);
  }

  @Post('leave')
  @HttpCode(200)
  @RequiresFeatures()
  applyLeave(@Auth() c: TenantClaims, @Body(new ZodPipe(apply)) b: ApplyInput) {
    return this.leave.apply(c, b);
  }

  @Get('leave/:id')
  leaveApplication(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.leave.application(c, id);
  }

  @Post('leave/:id/withdraw')
  @HttpCode(200)
  @RequiresFeatures()
  withdraw(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.leave.withdraw(c, id);
  }

  @Post('leave/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.leave.cancel(c, id);
  }

  @Post('leave/carry-forward')
  @HttpCode(200)
  @RequiresFeatures()
  carryForward(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(entity.extend({ year }))) b: { entityId: string; year: number },
  ) {
    return this.leave.carryForward(c, b.entityId, b.year);
  }
}
