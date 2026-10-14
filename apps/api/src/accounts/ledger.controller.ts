import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { moneyCol, reportXlsx } from '../procurement/procurement-report-excel.js';
import { TYPED_IN, VOUCHER_TYPES, type VoucherType } from './accounts-rules.js';
import { CloseService } from './close.service.js';
import { LedgerService } from './ledger.service.js';

const date = z.iso.date();
const text = (max: number) => z.string().trim().max(max);
const optional = (re: RegExp, message: string) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v || null)
    .refine((v) => v === null || re.test(v), { message })
    .nullable()
    .default(null);
const company = z.object({
  name: z.string().trim().min(2).max(200),
  legalName: text(200).default(''),
  gstin: optional(/^[0-9]{2}[A-Z0-9]{13}$/, 'A GSTIN: 15 characters, starting with the state code'),
  pan: optional(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN: 5 letters, 4 digits, a letter'),
  tan: optional(/^[A-Z]{4}[0-9]{5}[A-Z]$/, 'A TAN: 4 letters, 5 digits, a letter'),
  stateCode: optional(/^[0-9]{2}$/, 'A two-digit state code'),
  address: text(1000).default(''),
  city: text(100).default(''),
  pincode: optional(/^[1-9][0-9]{5}$/, 'A PIN code: 6 digits'),
  eInvoicing: z.boolean().default(false),
  booksFrom: date.nullable().default(null),
});
const rowVersion = z.object({ rowVersion: z.number().int().positive() });
const accountBody = z.object({
  parentId: z.uuid(),
  code: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9./-]{0,19}$/,
      'Up to 20 letters, digits, dots, slashes or dashes',
    ),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['ordinary', 'bank', 'cash', 'tax']).default('ordinary'),
  needsProject: z.boolean().default(false),
  itcBlocked: z.boolean().default(false),
});
const amount = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,16}(\.\d{1,2})?$/.test(v), { message: 'An amount with up to 2 decimals' });
const line = z.object({
  accountId: z.uuid().nullable().default(null),
  partyId: z.uuid().nullable().default(null),
  debit: amount.default('0'),
  credit: amount.default('0'),
  projectId: z.uuid().nullable().default(null),
  siteId: z.uuid().nullable().default(null),
  costCodeId: z.uuid().nullable().default(null),
  note: text(500).default(''),
});
export const voucherBody = z.object({
  entityId: z.uuid(),
  type: z.enum(TYPED_IN as [VoucherType, ...VoucherType[]]),
  date,
  narration: text(2000).default(''),
  reference: text(100).default(''),
  lines: z.array(line).min(2).max(500),
});
const format = z.object({ format: z.enum(['json', 'xlsx']).default('json') });
const range = format.extend({ entityId: z.uuid(), from: date, to: date });

type Rows<K extends keyof LedgerService> = Awaited<ReturnType<LedgerService[K]>>;

/** Reads the first sheet: the header row naming the ledger, debit and credit columns, then a row per balance. */
async function openingRows(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException({ code: 'not_xlsx', message: 'Send an Excel workbook (.xlsx).' });
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new BadRequestException({ code: 'empty', message: 'The workbook has no sheet.' });
  const cell = (r: ExcelJS.Row, c: number) => {
    const v = r.getCell(c).value as unknown;
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && v && 'result' in v)
      return String((v as { result: unknown }).result ?? '');
    if (typeof v === 'object' && v && 'richText' in v)
      return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
    return String(v);
  };
  let cols: { ledger: number; debit: number; credit: number } | null = null;
  const rows: { rowNo: number; ledger: string; debit: string; credit: string }[] = [];
  ws.eachRow((r, rowNo) => {
    if (!cols) {
      const heads = Array.from({ length: r.cellCount }, (_, i) =>
        cell(r, i + 1)
          .trim()
          .toLowerCase(),
      );
      const find = (...names: string[]) => heads.findIndex((h) => names.includes(h)) + 1;
      const ledger = find(
        'ledger',
        'account',
        'code',
        'ledger code',
        'name',
        'ledger name',
        'particulars',
      );
      const debit = find('debit', 'dr', 'debit (₹)', 'dr amount');
      const credit = find('credit', 'cr', 'credit (₹)', 'cr amount');
      if (ledger && debit && credit) cols = { ledger, debit, credit };
      return;
    }
    const ledger = cell(r, cols.ledger).trim();
    if (ledger)
      rows.push({ rowNo, ledger, debit: cell(r, cols.debit), credit: cell(r, cols.credit) });
  });
  if (!cols)
    throw new BadRequestException({
      code: 'no_header',
      message: 'Head the columns Ledger, Debit and Credit (the ledger by its code or its name).',
    });
  return rows;
}

/** The books (docs/wave3-plan.md step 1). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly close: CloseService,
  ) {}

  private async xlsx<T>(
    reply: FastifyReply,
    name: string,
    lines: string[],
    columns: Parameters<typeof reportXlsx<T>>[2],
    rows: T[],
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(await reportXlsx(name, lines, columns, rows), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(`${name}.xlsx`),
    });
  }

  @Get('companies')
  companies(@Auth() c: TenantClaims) {
    return this.ledger.companies(c);
  }

  @Post('companies')
  @HttpCode(200)
  @RequiresFeatures()
  createCompany(@Auth() c: TenantClaims, @Body(new ZodPipe(company)) b: z.infer<typeof company>) {
    return this.ledger.createCompany(c, b);
  }

  @Post('companies/:id')
  @HttpCode(200)
  @RequiresFeatures()
  updateCompany(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(company.extend(rowVersion.shape)))
    b: z.infer<typeof company> & { rowVersion: number },
  ) {
    return this.ledger.updateCompany(c, id, b);
  }

  @Get('accounts/chart')
  chart(@Auth() c: TenantClaims) {
    return this.ledger.chart(c);
  }

  @Post('accounts/chart')
  @HttpCode(200)
  @RequiresFeatures()
  addAccount(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(accountBody.extend({ isGroup: z.boolean().default(false) })))
    b: z.infer<typeof accountBody> & { isGroup: boolean },
  ) {
    return this.ledger.addAccount(c, b);
  }

  @Post('accounts/chart/:id')
  @HttpCode(200)
  @RequiresFeatures()
  updateAccount(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(accountBody.extend({ closed: z.boolean().default(false), ...rowVersion.shape })),
    )
    b: z.infer<typeof accountBody> & { closed: boolean; rowVersion: number },
  ) {
    return this.ledger.updateAccount(c, id, b);
  }

  @Get('accounts/map')
  accountMap(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.ledger.accountMap(c, q.entityId);
  }

  @Post('accounts/map')
  @HttpCode(200)
  @RequiresFeatures()
  mapRole(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ entityId: z.uuid(), role: z.string(), accountId: z.uuid() })))
    b: { entityId: string; role: string; accountId: string },
  ) {
    return this.ledger.mapRole(c, b);
  }

  @Get('accounts/vouchers')
  vouchers(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({
          entityId: z.uuid(),
          type: z.enum(Object.keys(VOUCHER_TYPES) as [VoucherType, ...VoucherType[]]).optional(),
          from: date.optional(),
          to: date.optional(),
          q: z.string().trim().max(100).optional(),
        }),
      ),
    )
    q: { entityId: string; type?: VoucherType; from?: string; to?: string; q?: string },
  ) {
    return this.ledger.vouchers(c, q);
  }

  @Post('accounts/vouchers')
  @HttpCode(200)
  @RequiresFeatures()
  createVoucher(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(voucherBody)) b: z.infer<typeof voucherBody>,
  ) {
    return this.ledger.createVoucher(c, b);
  }

  @Get('accounts/vouchers/:id')
  voucher(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.voucher(c, id);
  }

  @Post('accounts/vouchers/:id/reverse')
  @HttpCode(200)
  @RequiresFeatures()
  reverse(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ date, reason: z.string().trim().min(3).max(500) })))
    b: { date: string; reason: string },
  ) {
    return this.ledger.reverse(c, id, b);
  }

  @Get('accounts/periods')
  periods(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), fy: z.string().regex(/^\d{4}-\d{2}$/) })))
    q: { entityId: string; fy: string },
  ) {
    return this.ledger.periods(c, q.entityId, q.fy);
  }

  @Post('accounts/periods/lock')
  @HttpCode(200)
  @RequiresFeatures()
  lock(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ entityId: z.uuid(), month: date })))
    b: { entityId: string; month: string },
  ) {
    return this.ledger.lockMonth(c, b);
  }

  /** The month-end close checklist (docs/wave7-plan.md step 7c.6). */
  @Get('accounts/close')
  closeChecklist(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({ entityId: z.uuid(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
      ),
    )
    q: { entityId: string; month: string },
  ) {
    return this.close.checklist(c, q.entityId, q.month);
  }

  @Post('accounts/close/lock')
  @HttpCode(200)
  @RequiresFeatures()
  closeAndLock(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({ entityId: z.uuid(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
      ),
    )
    b: { entityId: string; month: string },
  ) {
    return this.close.lock(c, b.entityId, b.month);
  }

  @Post('accounts/periods/reopen')
  @HttpCode(200)
  @RequiresFeatures()
  reopen(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({ entityId: z.uuid(), month: date, reason: z.string().trim().min(3).max(2000) }),
      ),
    )
    b: { entityId: string; month: string; reason: string },
  ) {
    return this.ledger.reopenMonth(c, b);
  }

  @Get('companies/:id/opening')
  opening(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.opening(c, id);
  }

  @Post('companies/:id/opening')
  @HttpCode(200)
  @RequiresFeatures()
  setOpening(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ lines: z.array(line).min(2).max(5000) })))
    b: { lines: z.infer<typeof line>[] },
  ) {
    return this.ledger.setOpening(c, id, b.lines);
  }

  /** multipart/form-data, field `file`: an Excel sheet of Ledger, Debit, Credit. `?post=true` saves it when clean. */
  @Post('companies/:id/opening/import')
  @HttpCode(200)
  @RequiresFeatures()
  async importOpening(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ post: z.enum(['true', 'false']).default('false') })))
    q: { post: 'true' | 'false' },
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the workbook as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No workbook was sent.' });
    const buf = await file.toBuffer();
    const r = await this.ledger.resolveOpening(c, await openingRows(buf));
    if (q.post === 'false' || r.problems.length || !r.balanced || r.lines.length < 2)
      return { ...r, posted: false };
    await this.ledger.setOpening(c, id, r.lines);
    return { ...r, posted: true };
  }

  @Get('accounts/day-book')
  async dayBook(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(range)) q: z.infer<typeof range>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.ledger.dayBook(c, q);
    if (q.format === 'json') return r;
    type L = {
      date: string;
      number: string;
      type: string;
      account: string;
      debit: string;
      credit: string;
      narration: string;
    };
    const rows: L[] = r.vouchers.flatMap((v) =>
      v.lines.map((l) => ({
        date: v.date,
        number: v.number,
        type: VOUCHER_TYPES[v.type as VoucherType].label,
        account: `${l.account.code} ${l.account.name}`,
        debit: l.debit,
        credit: l.credit,
        narration: l.note || v.narration,
      })),
    );
    return this.xlsx<L>(
      reply,
      'Day book',
      [`Day book: ${r.company}, ${q.from} to ${q.to}`],
      [
        { header: 'Date', value: (l) => l.date, width: 12 },
        { header: 'Voucher', value: (l) => l.number, width: 20 },
        { header: 'Type', value: (l) => l.type, width: 14 },
        { header: 'Ledger', value: (l) => l.account, width: 34 },
        moneyCol<L>('Debit', (l) => (Number(l.debit) ? l.debit : null)),
        moneyCol<L>('Credit', (l) => (Number(l.credit) ? l.credit : null)),
        { header: 'Narration', value: (l) => l.narration, width: 40 },
      ],
      rows,
    );
  }

  @Get('accounts/ledgers/:id')
  async ledgerStatement(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(range.extend({ projectId: z.uuid().optional() })))
    q: z.infer<typeof range> & { projectId?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.ledger.ledger(c, id, q);
    if (q.format === 'json') return r;
    type L = Rows<'ledger'>['lines'][number];
    return this.xlsx<L>(
      reply,
      `Ledger ${r.account.code}`,
      [
        `${r.account.code} ${r.account.name}: ${r.company}, ${q.from} to ${q.to}. Opening ${r.opening}, closing ${r.closing} (debit positive)`,
      ],
      [
        { header: 'Date', value: (l) => l.date, width: 12 },
        { header: 'Voucher', value: (l) => l.number, width: 20 },
        { header: 'Narration', value: (l) => l.note || l.narration, width: 40 },
        { header: 'Project', value: (l) => l.project, width: 16 },
        moneyCol<L>('Debit', (l) => (Number(l.debit) ? l.debit : null)),
        moneyCol<L>('Credit', (l) => (Number(l.credit) ? l.credit : null)),
        moneyCol<L>('Balance', (l) => l.balance),
      ],
      r.lines,
    );
  }

  @Get('accounts/trial-balance')
  async trialBalance(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        format.extend({ entityId: z.uuid(), asOf: date, projectId: z.uuid().optional() }),
      ),
    )
    q: { format: 'json' | 'xlsx'; entityId: string; asOf: string; projectId?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.ledger.trialBalance(c, q);
    if (q.format === 'json') return r;
    type L = Rows<'trialBalance'>['rows'][number];
    return this.xlsx<L>(
      reply,
      'Trial balance',
      [`Trial balance: ${r.company}, as at ${q.asOf}. Total debit ${r.debit}, credit ${r.credit}`],
      [
        { header: 'Code', value: (l) => l.code, width: 10 },
        { header: 'Account', value: (l) => `${'  '.repeat(l.depth)}${l.name}`, width: 40 },
        moneyCol<L>('Debit', (l) => l.debit),
        moneyCol<L>('Credit', (l) => l.credit),
      ],
      r.rows,
    );
  }
}
