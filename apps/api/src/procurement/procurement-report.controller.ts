import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { moneyCol, qtyCol, reportXlsx, type Column } from './procurement-report-excel.js';
import { ProcurementReportService } from './procurement-report.service.js';

const format = z.object({ format: z.enum(['json', 'xlsx']).default('json') });
const scoped = format.extend({ projectId: z.uuid().optional() });
const STAGE: Record<string, string> = {
  not_asked: 'Not asked yet',
  asked: 'Asked vendors',
  part_ordered: 'Partly ordered',
  ordered: 'Ordered',
  part_received: 'Partly received',
  received: 'Received',
};

type Rows<K extends keyof ProcurementReportService> = Awaited<
  ReturnType<ProcurementReportService[K]>
>;

/**
 * Procurement reports (docs/wave2b-plan.md step 9), on screen and as Excel (`?format=xlsx`). Kept to the projects the
 * user sees by the service.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ProcurementReportController {
  constructor(private readonly reports: ProcurementReportService) {}

  private async send<T>(
    reply: FastifyReply,
    name: string,
    sheet: string,
    lines: string[],
    columns: Column<T>[],
    rows: T[],
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(await reportXlsx(sheet, lines, columns, rows), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(`${name}.xlsx`),
    });
  }

  @Get('projects/:id/reports/requisitions')
  async requisitions(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(format)) q: z.infer<typeof format>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.reports.requisitions(c, id);
    if (q.format === 'json') return r;
    type L = Rows<'requisitions'>['lines'][number];
    return this.send<L>(
      reply,
      'Requisition tracker',
      'Requisitions',
      ['Requisition to order to receipt'],
      [
        { header: 'Requisition', value: (l) => l.number, width: 20 },
        { header: 'Title', value: (l) => l.title, width: 30 },
        { header: 'Line', value: (l) => l.description, width: 30 },
        { header: 'Unit', value: (l) => l.unit, width: 8 },
        qtyCol<L>('Asked for', (l) => l.qty),
        qtyCol<L>('Ordered', (l) => l.ordered),
        qtyCol<L>('Received', (l) => l.received),
        qtyCol<L>('Still to come', (l) => l.outstanding),
        { header: 'Stage', value: (l) => STAGE[l.stage] ?? l.stage },
        { header: 'Enquiries', value: (l) => l.enquiries.join(', ') },
        { header: 'Orders', value: (l) => l.orders.join(', ') },
        { header: 'Approved on', value: (l) => l.approvedOn, width: 12 },
        { header: 'Needed by', value: (l) => l.neededBy, width: 12 },
        { header: 'Days open', value: (l) => l.ageDays, width: 10 },
      ],
      r.lines,
    );
  }

  @Get('reports/open-orders')
  async openOrders(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(scoped)) q: z.infer<typeof scoped>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.reports.openOrders(c, q.projectId);
    if (q.format === 'json') return r;
    type L = Rows<'openOrders'>['lines'][number];
    return this.send<L>(
      reply,
      'Open orders',
      'Open orders',
      ['Open purchase orders: what is still owed'],
      [
        { header: 'Order', value: (l) => l.number, width: 20 },
        { header: 'Project', value: (l) => `${l.project.number} ${l.project.name}`, width: 30 },
        { header: 'Supplier', value: (l) => l.vendor, width: 28 },
        { header: 'Line', value: (l) => l.description, width: 30 },
        { header: 'Unit', value: (l) => l.unit, width: 8 },
        qtyCol<L>('Ordered', (l) => l.ordered),
        qtyCol<L>('Received', (l) => l.received),
        qtyCol<L>('Still owed', (l) => l.outstanding),
        moneyCol<L>('Value owed (before GST)', (l) => l.value),
        { header: 'Deliver by', value: (l) => l.deliverBy, width: 12 },
        { header: 'Days late', value: (l) => l.daysLate, width: 10 },
      ],
      r.lines,
    );
  }

  @Get('projects/:id/reports/materials')
  async materials(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(format)) q: z.infer<typeof format>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.reports.materials(c, id);
    if (q.format === 'json') return r;
    type L = Rows<'materials'>['lines'][number];
    return this.send<L>(
      reply,
      'Material reconciliation',
      'Materials',
      ['Material reconciliation and wastage'],
      [
        { header: 'Code', value: (l) => l.code, width: 12 },
        { header: 'Material', value: (l) => l.name, width: 30 },
        { header: 'Unit', value: (l) => l.unit, width: 8 },
        qtyCol<L>('Budget', (l) => l.budget),
        qtyCol<L>('Requisitioned', (l) => l.requisitioned),
        qtyCol<L>('Ordered', (l) => l.ordered),
        qtyCol<L>('Received', (l) => l.received),
        qtyCol<L>('Issued', (l) => l.issued),
        qtyCol<L>('In stock', (l) => l.inStock),
        qtyCol<L>('Should have taken', (l) => l.theoretical),
        qtyCol<L>('Wastage', (l) => l.wastage),
        {
          header: 'Wastage %',
          value: (l) => (l.wastagePct === null ? null : Number(l.wastagePct)),
          format: '0.0',
          width: 10,
        },
      ],
      r.lines,
    );
  }

  @Get('reports/suppliers')
  async suppliers(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(scoped)) q: z.infer<typeof scoped>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.reports.suppliers(c, q.projectId);
    if (q.format === 'json') return r;
    type L = Rows<'suppliers'>['suppliers'][number];
    const pct = (v: string | null) => (v === null ? null : Number(v));
    return this.send<L>(
      reply,
      'Supplier performance',
      'Suppliers',
      ['Supplier performance'],
      [
        { header: 'Supplier', value: (l) => l.vendor, width: 30 },
        { header: 'Orders', value: (l) => l.orders, width: 8 },
        moneyCol<L>('Ordered (with GST)', (l) => l.orderedValue),
        { header: 'Receipt lines', value: (l) => l.receiptLines, width: 10 },
        { header: 'On time %', value: (l) => pct(l.onTimePct), format: '0.0', width: 10 },
        { header: 'Rejected %', value: (l) => pct(l.rejectedPct), format: '0.0', width: 10 },
        {
          header: 'Above lowest quote %',
          value: (l) => pct(l.overL1Pct),
          format: '0.0',
          width: 12,
        },
      ],
      r.suppliers,
    );
  }
}
