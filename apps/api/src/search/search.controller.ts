import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SearchService } from './search.service.js';

/** Search everything (docs/wave7-plan.md step 7a.6). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class SearchController {
  constructor(private readonly searching: SearchService) {}

  @Get('search')
  search(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ q: z.string().trim().min(2).max(100) }))) { q }: { q: string },
  ) {
    return this.searching.search(c, q);
  }
}
