// A person's own settings for the interface (docs/wave9-plan.md step 9a.5): favourite and recent pages, and each
// grid's layout and saved views, kept on the server so they follow the person to any device.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { AllowWhilePasswordChangeRequired, Auth, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

const KEY = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const body = z.object({ value: z.unknown().refine((v) => v !== undefined, 'A value') });
const MAX_BYTES = 60_000;

@Controller('tenant/me/prefs')
@UseGuards(TenantAuthGuard)
export class PrefsController {
  constructor(private readonly tenants: TenantConnections) {}

  /** Everything the person has set, as one object: the app reads it once at start. */
  @Get()
  @AllowWhilePasswordChangeRequired()
  async all(@Auth() c: TenantClaims) {
    const db = await this.tenants.forTenant(c.ten);
    const rows = await db<{ key: string; value: unknown }[]>`
      SELECT key, value FROM platform.user_pref WHERE user_id = ${c.sub}`;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  @Post(':key')
  @HttpCode(204)
  async set(
    @Auth() c: TenantClaims,
    @Param('key') key: string,
    @Body(new ZodPipe(body)) b: z.infer<typeof body>,
  ) {
    if (!KEY.test(key)) throw badKey();
    if (JSON.stringify(b.value).length > MAX_BYTES) throw tooBig();
    const db = await this.tenants.forTenant(c.ten);
    if (b.value === null)
      await db`DELETE FROM platform.user_pref WHERE user_id = ${c.sub} AND key = ${key}`;
    else
      await db`INSERT INTO platform.user_pref (user_id, key, value) VALUES (${c.sub}, ${key}, ${db.json(b.value as never)})
        ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
}

const badKey = () =>
  new BadRequestException({ code: 'invalid_request', message: 'Not a setting name.' });
const tooBig = () =>
  new BadRequestException({ code: 'invalid_request', message: 'That setting is too large.' });
