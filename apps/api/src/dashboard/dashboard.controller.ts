import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard } from '../auth/permissions.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { dashboardXlsx } from './dashboard-excel.js';
import { DashboardService } from './dashboard.service.js';

const name = z.enum(['tender', 'estimation']);
const filter = z.object({
  fy: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'A financial year looks like 2026-27')
    .optional(),
  vertical: z.enum(['buildings', 'interiors', 'joinery', 'mep', 'other']).optional(),
  owner: z.uuid().optional(),
});
const layout = z.object({ tiles: z.array(z.string().max(60)).max(24) });

type Claims = TenantClaims;
type Filter = z.infer<typeof filter>;
const toFilter = (q: Filter) => ({ fy: q.fy, vertical: q.vertical, ownerId: q.owner });

/**
 * Dashboards (docs/wave1-plan.md step 12 part 2). Reading: everyone signed in, also on a read-only licence; tiles
 * with bid values only for `pricing.edit`. Saving one's own tiles is a personal preference, not a change to data, so
 * it needs no permission and works on a read-only licence too.
 */
@Controller('tenant/dashboards')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class DashboardController {
  constructor(private readonly dashboards: DashboardService) {}

  @Get(':name')
  get(
    @Auth() c: Claims,
    @Param('name', new ZodPipe(name)) d: z.infer<typeof name>,
    @Query(new ZodPipe(filter)) q: Filter,
  ) {
    return this.dashboards.get(c, d, toFilter(q));
  }

  @Get(':name/export')
  async export(
    @Auth() c: Claims,
    @Param('name', new ZodPipe(name)) d: z.infer<typeof name>,
    @Query(new ZodPipe(filter)) q: Filter,
  ) {
    const data = await this.dashboards.get(c, d, toFilter(q));
    return new StreamableFile(await dashboardXlsx(data), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(
        `${d === 'tender' ? 'Tender dashboard' : 'Estimation dashboard'} ${data.filter.fy}.xlsx`,
      ),
    });
  }

  @Post(':name/tiles')
  @HttpCode(200)
  saveTiles(
    @Auth() c: Claims,
    @Param('name', new ZodPipe(name)) d: z.infer<typeof name>,
    @Body(new ZodPipe(layout)) b: z.infer<typeof layout>,
  ) {
    return this.dashboards.saveLayout(c, d, b.tiles);
  }
}
