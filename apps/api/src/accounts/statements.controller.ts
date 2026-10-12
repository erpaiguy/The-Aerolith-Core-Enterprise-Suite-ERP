import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { StatementService } from './statements.service.js';

const date = z.iso.date();
const format = z.enum(['json', 'xlsx']).default('json');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** One statement as a sheet: its title, then head, line, this year and the previous. */
async function statementXlsx(title: string, lines: string[], rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aerolith Core';
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([title]).font = { bold: true, size: 13 };
  for (const l of lines) ws.addRow([l]);
  ws.addRow([]);
  ws.addRow(['', 'Particulars', 'This period', 'Previous']).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 40;
  for (const c of [3, 4]) {
    ws.getColumn(c).width = 18;
    ws.getColumn(c).numFmt = '#,##0.00';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Financial statements and the year end (docs/wave3-plan.md step 8a). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class StatementController {
  constructor(private readonly statements: StatementService) {}

  @Get('accounts/statements/profit-and-loss')
  async pl(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: date, to: date, format })))
    q: { entityId: string; from: string; to: string; format: 'json' | 'xlsx' },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.statements.profitAndLoss(c, q);
    if (q.format === 'json') return r;
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(
      await statementXlsx(
        'Profit and loss',
        [`${q.from} to ${q.to}`],
        [
          ...r.lines.map((l) => [l.head, l.label, Number(l.amount), Number(l.previous)]),
          ['', 'Total income', Number(r.income), Number(r.previous.income)],
          ['', 'Total expenses', Number(r.expenses), Number(r.previous.expenses)],
          ['', 'Profit for the period', Number(r.profit), Number(r.previous.profit)],
        ],
      ),
      { type: XLSX, disposition: attachment(`Profit-and-loss-${q.from}-${q.to}.xlsx`) },
    );
  }

  @Get('accounts/statements/balance-sheet')
  async bs(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), asOf: date, format })))
    q: { entityId: string; asOf: string; format: 'json' | 'xlsx' },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.statements.balanceSheet(c, q);
    if (q.format === 'json') return r;
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(
      await statementXlsx(
        'Balance sheet',
        [`As at ${q.asOf}`],
        [
          ...r.lines.map((l) => [l.head, l.label, Number(l.amount), Number(l.previous)]),
          [
            '',
            'Total equity and liabilities',
            Number(r.equityAndLiabilities),
            Number(r.previous.equityAndLiabilities),
          ],
          ['', 'Total assets', Number(r.assets), Number(r.previous.assets)],
        ],
      ),
      { type: XLSX, disposition: attachment(`Balance-sheet-${q.asOf}.xlsx`) },
    );
  }

  @Get('accounts/statements/cash-flow')
  cashFlow(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: date, to: date })))
    q: { entityId: string; from: string; to: string },
  ) {
    return this.statements.cashFlow(c, q);
  }

  @Get('accounts/statements/projects')
  projects(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: date, to: date })))
    q: { entityId: string; from: string; to: string },
  ) {
    return this.statements.projects(c, q);
  }

  @Get('accounts/year-end')
  yearEnd(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.statements.yearEnd(c, q.entityId);
  }

  @Post('accounts/year-end')
  @HttpCode(200)
  @RequiresFeatures()
  close(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({
          entityId: z.uuid(),
          fy: z.string().regex(/^\d{4}-\d{2}$/, 'A financial year: 2026-27'),
          closingStock: z
            .union([z.string().trim(), z.number()])
            .transform((v) => String(v).replace(/,/g, '') || '0')
            .refine((v) => /^\d{1,16}(\.\d{1,2})?$/.test(v), { message: 'An amount' })
            .default('0'),
        }),
      ),
    )
    b: { entityId: string; fy: string; closingStock: string },
  ) {
    return this.statements.closeYear(c, b);
  }
}
