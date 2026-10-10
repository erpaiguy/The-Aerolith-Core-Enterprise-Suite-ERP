// The company's own tender settings (docs/wave1-plan.md step 13): the bid/no-bid criteria with their weights, and the
// standard document checklist added to a tender. Kept in platform.setting; until the admin changes them, the
// built-in lists apply (tender-rules.ts). A decision stores the criteria it was scored on, so changing them later does
// not change past scores.
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import {
  CHECKLIST_TEMPLATE,
  DEFAULT_CRITERIA,
  type Criterion,
  type Envelope,
} from './tender-rules.js';

export type CriterionDef = Omit<Criterion, 'score'>;
export interface ChecklistDef {
  envelope: Envelope;
  title: string;
  required: boolean;
}

const KEY = { criteria: 'tender.bid_criteria', checklist: 'tender.checklist_template' } as const;

/** A label as a stable key: "Client payment record" -> "client_payment_record". */
export const keyOf = (label: string) =>
  label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'criterion';

@Injectable()
export class TenderSettingsService {
  constructor(private readonly tenants: TenantConnections) {}

  private async read<T>(db: Sql | TransactionSql, key: string): Promise<T | null> {
    const [r] = await db<{ value: T }[]>`SELECT value FROM platform.setting WHERE key = ${key}`;
    return r?.value ?? null;
  }

  async criteria(db: Sql | TransactionSql): Promise<CriterionDef[]> {
    return (await this.read<CriterionDef[]>(db, KEY.criteria)) ?? [...DEFAULT_CRITERIA];
  }

  async checklist(db: Sql | TransactionSql): Promise<ChecklistDef[]> {
    return (await this.read<ChecklistDef[]>(db, KEY.checklist)) ?? [...CHECKLIST_TEMPLATE];
  }

  async get(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const [criteria, checklist, custom] = await Promise.all([
      this.criteria(db),
      this.checklist(db),
      db<
        { key: string }[]
      >`SELECT key FROM platform.setting WHERE key IN ${db([KEY.criteria, KEY.checklist])}`,
    ]);
    const own = new Set(custom.map((c) => c.key));
    return {
      criteria,
      checklist,
      criteriaCustomised: own.has(KEY.criteria),
      checklistCustomised: own.has(KEY.checklist),
    };
  }

  /**
   * Replaces the bid/no-bid criteria. A criterion keeps its key when its label is edited (pass the key), so reports
   * can follow it; new ones get a key from their label. `null` restores the built-in list.
   */
  async setCriteria(
    claims: TenantClaims,
    list: { key?: string | undefined; label: string; weight: number }[] | null,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (list === null) await this.write(db, claims, KEY.criteria, null);
    else {
      const used = new Set<string>();
      const defs = list.map((c) => {
        let key = c.key ?? keyOf(c.label);
        for (let n = 2; used.has(key); n++) key = `${(c.key ?? keyOf(c.label)).slice(0, 36)}_${n}`;
        used.add(key);
        return { key, label: c.label.trim(), weight: c.weight };
      });
      if (defs.every((d) => d.weight === 0))
        throw new BadRequestException({
          code: 'no_weight',
          message: 'At least one criterion needs a weight above 0.',
        });
      await this.write(db, claims, KEY.criteria, defs);
    }
    return this.get(claims);
  }

  /** Replaces the standard checklist; `null` restores the built-in list. */
  async setChecklist(claims: TenantClaims, list: ChecklistDef[] | null) {
    const db = await this.tenants.forTenant(claims.ten);
    if (list !== null) {
      const seen = new Set<string>();
      for (const c of list) {
        const t = c.title.trim().toLowerCase();
        if (seen.has(t))
          throw new BadRequestException({
            code: 'duplicate_item',
            message: `"${c.title}" is in the list twice.`,
          });
        seen.add(t);
      }
    }
    await this.write(
      db,
      claims,
      KEY.checklist,
      list?.map((c) => ({ ...c, title: c.title.trim() })) ?? null,
    );
    return this.get(claims);
  }

  private async write(db: Sql, claims: TenantClaims, key: string, value: unknown) {
    await db.begin(async (tx) => {
      if (value === null) await tx`DELETE FROM platform.setting WHERE key = ${key}`;
      else
        await tx`INSERT INTO platform.setting (key, value) VALUES (${key}, ${tx.json(value as never)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'setting.set', 'setting', ${key}, ${tx.json({ reset: value === null })})`;
    });
  }
}
