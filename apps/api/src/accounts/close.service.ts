// Month-end close (docs/wave7-plan.md step 7c.6): for a company and a month, each close step's state worked out from
// the books, not ticked by hand: supplier bills entered and posted, certified client bills posted, payroll posted,
// depreciation run, and the bank statement matched. When every step is done (or does not apply) the month may be
// locked; a step still open blocks the lock.
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { LedgerService } from './ledger.service.js';

export type StepState = 'done' | 'open' | 'na';
export interface CloseStep {
  key: string;
  label: string;
  state: StepState;
  detail: string;
}

@Injectable()
export class CloseService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly ledger: LedgerService,
  ) {}

  async checklist(claims: TenantClaims, entityId: string, month: string) {
    if (claims.role !== 'admin' && claims.role !== 'manager')
      throw new ForbiddenException({ code: 'forbidden' });
    const db = await this.tenants.forTenant(claims.ten);
    const from = `${month}-01`;
    const [c] = await db<
      {
        held: number;
        unposted: number;
        staff: number;
        payroll: string | null;
        assets: number;
        depreciated: boolean;
        bank_lines: number;
        unmatched: number;
        locked: boolean;
      }[]
    >`
      WITH m AS (SELECT ${from}::date AS f, (${from}::date + interval '1 month' - interval '1 day')::date AS t)
      SELECT
        (SELECT count(*)::int FROM acc.vendor_bill b, m
          WHERE b.entity_id = ${entityId} AND b.status = 'held' AND b.bill_date BETWEEN m.f AND m.t) AS held,
        (SELECT count(*)::int FROM acc.client_bill b, m
          WHERE b.entity_id = ${entityId} AND b.status = 'certified' AND b.voucher_id IS NULL
            AND b.upto BETWEEN m.f AND m.t) AS unposted,
        (SELECT count(*)::int FROM hr.employee e, m WHERE e.entity_id = ${entityId} AND e.joined_on <= m.t
          AND (e.left_on IS NULL OR e.left_on >= m.f)) AS staff,
        (SELECT r.status FROM pay.run r WHERE r.entity_id = ${entityId} AND r.month = ${from}) AS payroll,
        (SELECT count(*)::int FROM acc.asset a WHERE a.entity_id = ${entityId}) AS assets,
        EXISTS (SELECT 1 FROM acc.depreciation_run d, m WHERE d.entity_id = ${entityId} AND d.upto >= m.t)
          AS depreciated,
        (SELECT count(*)::int FROM acc.bank_line l JOIN acc.account a ON a.id = l.account_id, m
          WHERE l.txn_date BETWEEN m.f AND m.t) AS bank_lines,
        (SELECT count(*)::int FROM acc.bank_line l, m WHERE l.txn_date BETWEEN m.f AND m.t
          AND NOT EXISTS (SELECT 1 FROM acc.bank_match x WHERE x.bank_line_id = l.id)) AS unmatched,
        EXISTS (SELECT 1 FROM acc.period_lock p WHERE p.entity_id = ${entityId} AND p.month = ${from}) AS locked`;
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    const steps: CloseStep[] = [
      {
        key: 'supplier_bills',
        label: 'Supplier bills posted',
        state: c!.held ? 'open' : 'done',
        detail: c!.held ? `${n(c!.held, 'bill', 'bills')} of the month still held.` : 'None held.',
      },
      {
        key: 'client_bills',
        label: 'Certified client bills posted',
        state: c!.unposted ? 'open' : 'done',
        detail: c!.unposted
          ? `${n(c!.unposted, 'certified bill', 'certified bills')} not yet posted.`
          : 'All certified bills are in the books.',
      },
      {
        key: 'payroll',
        label: 'Payroll posted',
        state: !c!.staff
          ? 'na'
          : c!.payroll === 'posted' || c!.payroll === 'paid'
            ? 'done'
            : 'open',
        detail: !c!.staff
          ? 'No staff on the rolls.'
          : c!.payroll
            ? `The month's payroll is ${c!.payroll}.`
            : 'No payroll run for the month yet.',
      },
      {
        key: 'depreciation',
        label: 'Depreciation run',
        state: !c!.assets ? 'na' : c!.depreciated ? 'done' : 'open',
        detail: !c!.assets
          ? 'No fixed assets.'
          : c!.depreciated
            ? 'Charged up to the month end.'
            : 'Not yet charged up to the month end.',
      },
      {
        key: 'bank',
        label: 'Bank statement matched',
        state: !c!.bank_lines ? 'na' : c!.unmatched ? 'open' : 'done',
        detail: !c!.bank_lines
          ? 'No statement lines for the month.'
          : c!.unmatched
            ? `${n(c!.unmatched, 'line', 'lines')} not matched to the books.`
            : 'Every line matched.',
      },
    ];
    return {
      entityId,
      month,
      steps,
      ready: steps.every((s) => s.state !== 'open'),
      locked: c!.locked,
      mayLock: claims.role === 'admin',
    };
  }

  /** Locks the month once every step is done. */
  async lock(claims: TenantClaims, entityId: string, month: string) {
    const list = await this.checklist(claims, entityId, month);
    if (!list.ready)
      throw new ConflictException({
        code: 'close_not_ready',
        message: `Still open: ${list.steps
          .filter((s) => s.state === 'open')
          .map((s) => s.label.toLowerCase())
          .join(', ')}.`,
      });
    await this.ledger.lockMonth(claims, { entityId, month: `${month}-01` });
    return this.checklist(claims, entityId, month);
  }
}
