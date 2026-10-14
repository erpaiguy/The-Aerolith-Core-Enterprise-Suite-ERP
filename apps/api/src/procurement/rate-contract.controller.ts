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
import { type RateContractInput, RateContractService } from './rate-contract.service.js';

/** Rates agreed with suppliers for a period (docs/wave7-plan.md step 7c.5). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class RateContractController {
  constructor(private readonly contracts: RateContractService) {}

  @Get('rate-contracts')
  list(@Auth() c: TenantClaims) {
    return this.contracts.list(c);
  }

  @Get('rate-contracts/rate')
  rate(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ partyId: z.uuid(), resourceId: z.uuid(), on: z.iso.date() })))
    q: { partyId: string; resourceId: string; on: string },
  ) {
    return this.contracts.rate(c, q.partyId, q.resourceId, q.on);
  }

  @Post('rate-contracts')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z
          .object({
            partyId: z.uuid(),
            reference: z.string().trim().max(100).default(''),
            validFrom: z.iso.date(),
            validTo: z.iso.date(),
            notes: z.string().trim().max(2000).default(''),
            lines: z
              .array(
                z.object({
                  resourceId: z.uuid(),
                  rate: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/),
                  gstPct: z.enum(['0', '5', '12', '18', '28']).default('18'),
                  maxQty: z
                    .string()
                    .regex(/^\d{1,16}(\.\d{1,4})?$/)
                    .nullable()
                    .default(null),
                }),
              )
              .min(1)
              .max(500),
          })
          .refine((b) => b.validTo >= b.validFrom, {
            message: 'The contract ends before it starts.',
          }),
      ),
    )
    b: RateContractInput,
  ) {
    return this.contracts.create(c, b);
  }

  @Post('rate-contracts/:id/close')
  @HttpCode(200)
  @RequiresFeatures()
  close(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.contracts.close(c, id);
  }
}
