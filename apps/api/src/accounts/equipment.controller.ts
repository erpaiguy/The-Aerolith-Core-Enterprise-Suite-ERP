import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { EquipmentService, type EquipmentInput, type LogInput } from './equipment.service.js';

const date = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month: YYYY-MM');
const num = (places: number) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v).replace(/,/g, ''))
    .refine((v) => new RegExp(`^\\d{1,12}(\\.\\d{1,${places}})?$`).test(v), {
      message: 'A number',
    });
const optional = (places: number) =>
  z.union([num(places), z.literal('').transform(() => null), z.null()]).default(null);
const equipment = z.object({
  entityId: z.uuid(),
  code: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9./-]{0,29}$/,
      'Up to 30 letters, digits, dots, slashes or dashes',
    ),
  name: z.string().trim().min(2).max(200),
  category: z.enum(['excavator', 'crane', 'mixer', 'vehicle', 'pump', 'other']),
  meter: z.enum(['hours', 'km']).default('hours'),
  ownership: z.enum(['own', 'hired']),
  assetId: z.uuid().nullable().default(null),
  internalRate: optional(2),
  partyId: z.uuid().nullable().default(null),
  hireBasis: z.enum(['hour', 'day', 'month']).nullable().default(null),
  hireRate: optional(2),
  minHours: num(1).default('0'),
  operatorBy: z.enum(['own', 'hirer']).default('own'),
  fuelBy: z.enum(['own', 'hirer']).default('own'),
  fuelNorm: optional(2),
});
const log = z.object({
  date,
  startReading: optional(1),
  endReading: optional(1),
  worked: optional(1),
  idleHours: num(1).default('0'),
  idleReason: z.string().trim().max(300).default(''),
  breakdownHours: num(1).default('0'),
  operator: z.string().trim().max(120).default(''),
});

/** Equipment and fleet (docs/wave3-plan.md step 10). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class EquipmentController {
  constructor(private readonly equipment: EquipmentService) {}

  @Get('equipment')
  list(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.equipment.list(c, q.entityId);
  }

  @Post('equipment')
  @HttpCode(200)
  @RequiresFeatures()
  create(@Auth() c: TenantClaims, @Body(new ZodPipe(equipment)) b: EquipmentInput) {
    return this.equipment.create(c, b);
  }

  @Get('equipment/fuel')
  fuel(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: date, to: date })))
    q: { entityId: string; from: string; to: string },
  ) {
    return this.equipment.fuel(c, q);
  }

  @Get('equipment/costing')
  costing(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), month })))
    q: { entityId: string; month: string },
  ) {
    return this.equipment.costingPreview(c, q);
  }

  @Post('equipment/costing')
  @HttpCode(200)
  @RequiresFeatures()
  postCosting(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ entityId: z.uuid(), month })))
    b: { entityId: string; month: string },
  ) {
    return this.equipment.costingPost(c, b);
  }

  @Get('equipment/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.equipment.get(c, id);
  }

  @Post('equipment/:id/allocate')
  @HttpCode(200)
  @RequiresFeatures()
  allocate(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          date,
          projectId: z.uuid().nullable().default(null),
          siteId: z.uuid().nullable().default(null),
        }),
      ),
    )
    b: { date: string; projectId: string | null; siteId: string | null },
  ) {
    return this.equipment.allocate(c, id, b);
  }

  @Get('equipment/:id/logs')
  logs(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ from: date, to: date }))) q: { from: string; to: string },
  ) {
    return this.equipment.logs(c, id, q);
  }

  @Post('equipment/:id/logs')
  @HttpCode(200)
  @RequiresFeatures()
  log(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(log)) b: LogInput,
  ) {
    return this.equipment.log(c, id, b);
  }

  @Get('equipment/:id/maintenance')
  maintenance(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ asOf: date }))) q: { asOf: string },
  ) {
    return this.equipment.maintenance(c, id, q.asOf);
  }

  @Post('equipment/:id/maintenance-plans')
  @HttpCode(200)
  @RequiresFeatures()
  addPlan(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          name: z.string().trim().min(2).max(120),
          everyHours: optional(1),
          everyDays: z.number().int().positive().nullable().default(null),
          fromDate: date,
          fromReading: num(1).default('0'),
        }),
      ),
    )
    b: {
      name: string;
      everyHours: string | null;
      everyDays: number | null;
      fromDate: string;
      fromReading: string;
    },
  ) {
    return this.equipment.addPlan(c, id, b);
  }

  @Post('equipment/:id/maintenance-records')
  @HttpCode(200)
  @RequiresFeatures()
  addRecord(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          planId: z.uuid().nullable().default(null),
          kind: z.enum(['service', 'breakdown']),
          doneOn: date,
          reading: optional(1),
          description: z.string().trim().min(2).max(1000),
          downtimeHours: num(1).default('0'),
          cost: num(2).default('0'),
        }),
      ),
    )
    b: {
      planId: string | null;
      kind: 'service' | 'breakdown';
      doneOn: string;
      reading: string | null;
      description: string;
      downtimeHours: string;
      cost: string;
    },
  ) {
    return this.equipment.addRecord(c, id, b);
  }
}
