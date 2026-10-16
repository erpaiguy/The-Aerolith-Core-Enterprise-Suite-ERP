// Rule 37 of the CGST Rules (docs/wave8-plan.md step 8b.1): input credit taken on a supplier's bill that is still
// unpaid 180 days after its date goes back, in proportion to what is unpaid, and is taken again once the bill is paid.
// A run on a date reverses what has fallen due and re-claims what has since been paid in full; each is a journal, and
// the reversed credit waits in its own ledger meanwhile. Reverse-charge tax is not reversed: the company paid it itself.
import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, div, fmt, mul } from '../rates/decimal.js';
import { LedgerService, type LineInput } from './ledger.service.js';
import { PayableService } from './payable.service.js';

type Db = Sql | TransactionSql;
const money = (v: bigint) => fmt(v, 2);
const r2 = (v: bigint) => dec(fmt(v, 2));

export interface DueRow {
  billId: string;
  billNo: string;
  billDate: string;
  party: string;
  payable: string;
  unpaid: string;
  cgst: string;
  sgst: string;
  igst: string;
}
export interface OpenRow {
  id: string;
  billId: string;
  billNo: string;
  billDate: string;
  party: string;
  reversedOn: string;
  unpaid: string;
  outstanding: string;
  cgst: string;
  sgst: string;
  igst: string;
  /** Debit notes on the bill since: they took their own GST back, so that much is not re-claimed. */
  noted: string;
  reclaimedOn: string | null;
}

/** On payment, the reversed credit comes back, less the share settled by debit notes since the reversal. */
export function reclaimOf(o: Pick<OpenRow, 'unpaid' | 'noted' | 'cgst' | 'sgst' | 'igst'>) {
  const paid = dec(o.unpaid) - dec(o.noted);
  const share = paid > 0n ? div(paid, dec(o.unpaid)) : 0n;
  const part = (v: string) => money(r2(mul(dec(v), share)));
  return { cgst: part(o.cgst), sgst: part(o.sgst), igst: part(o.igst) };
}

/** The credit on the unpaid share: the bill's own GST, less what was blocked, × unpaid ÷ payable. */
export function rule37Share(
  b: { cgst: string; sgst: string; igst: string; blocked: string; payable: string },
  unpaid: string,
) {
  const blocked = dec(b.blocked);
  const credit = dec(b.igst)
    ? { cgst: 0n, sgst: 0n, igst: dec(b.igst) - blocked }
    : { cgst: dec(b.cgst) - blocked / 2n, sgst: dec(b.sgst) - blocked / 2n, igst: 0n };
  const share = dec(b.payable) ? div(dec(unpaid), dec(b.payable)) : 0n;
  const part = (v: bigint) => money(r2(mul(v, share)));
  return { cgst: part(credit.cgst), sgst: part(credit.sgst), igst: part(credit.igst) };
}

@Injectable()
export class ItcReversalService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
    private readonly payables: PayableService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          p === 'accounts.post'
            ? 'Only accounts may post input credit reversals.'
            : 'Only accounts may see this.',
      });
  }

  /** Bills past 180 days with something unpaid and credit taken, not already reversed. */
  async due(db: Db, entityId: string, asOf: string): Promise<DueRow[]> {
    const rows = await db<
      {
        billId: string;
        billNo: string;
        billDate: string;
        party: string;
        payable: string;
        unpaid: string;
        cgst: string;
        sgst: string;
        igst: string;
        blocked: string;
      }[]
    >`
      SELECT * FROM (
        SELECT b.id AS "billId", b.bill_no AS "billNo", to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
          p.name AS party, b.payable::text AS payable, ${this.payables.outstandingSql(db)}::text AS unpaid,
          b.cgst::text AS cgst, b.sgst::text AS sgst, b.igst::text AS igst, b.itc_blocked::text AS blocked
        FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id
        WHERE b.entity_id = ${entityId} AND b.status = 'posted' AND b.bill_date + 180 < ${asOf}::date
          AND b.cgst + b.sgst + b.igst - b.itc_blocked > 0
          AND NOT EXISTS (SELECT 1 FROM acc.itc_reversal r WHERE r.bill_id = b.id AND r.reclaimed_on IS NULL)
      ) x WHERE unpaid::numeric > 0 ORDER BY "billDate", party, "billNo"`;
    return rows.map(({ blocked, ...r }) => ({
      ...r,
      ...rule37Share({ ...r, blocked }, r.unpaid),
    }));
  }

  private open(db: Db, entityId: string) {
    return db<OpenRow[]>`
      SELECT r.id, b.id AS "billId", b.bill_no AS "billNo", to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
        p.name AS party, to_char(r.reversed_on, 'YYYY-MM-DD') AS "reversedOn", r.unpaid::text AS unpaid,
        ${this.payables.outstandingSql(db)}::text AS outstanding, r.cgst::text AS cgst, r.sgst::text AS sgst,
        r.igst::text AS igst, to_char(r.reclaimed_on, 'YYYY-MM-DD') AS "reclaimedOn",
        coalesce((SELECT sum(d.total) FROM acc.debit_note d WHERE d.bill_id = b.id AND d.note_date >= r.reversed_on),
          0)::text AS noted
      FROM acc.itc_reversal r JOIN acc.vendor_bill b ON b.id = r.bill_id JOIN platform.party p ON p.id = b.party_id
      WHERE r.entity_id = ${entityId} AND r.reclaimed_on IS NULL ORDER BY r.reversed_on, p.name`;
  }

  async view(claims: TenantClaims, entityId: string, asOf: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const open = await this.open(db, entityId);
    return {
      entityId,
      asOf,
      due: await this.due(db, entityId, asOf),
      reversed: open.filter((o) => dec(o.outstanding) > 0n),
      // Paid in full since: taken back on the next run.
      toReclaim: open
        .filter((o) => dec(o.outstanding) <= 0n)
        .map((o) => ({ ...o, reclaim: reclaimOf(o) })),
      mayPost: await this.permissions.can(claims, 'accounts.post'),
    };
  }

  /** Reverse what is due and re-claim what has been paid, as on the date. */
  async run(claims: TenantClaims, entityId: string, asOf: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const role = (r: 'input_cgst' | 'input_sgst' | 'input_igst' | 'itc_rule37') =>
        this.ledger.roleAccount(tx, entityId, r);
      const line = (accountId: string, debit: string, credit: string, note: string): LineInput => ({
        accountId,
        partyId: null,
        debit,
        credit,
        projectId: null,
        siteId: null,
        costCodeId: null,
        note,
      });
      // One journal per bill, so each reversal and its re-claim pair up in the ledger.
      const post = async (
        t: { cgst: string; sgst: string; igst: string },
        reclaim: boolean,
        narration: string,
        reference: string,
        source: { kind: string; id: string },
      ) => {
        const tax = (['cgst', 'sgst', 'igst'] as const).filter((k) => dec(t[k]) > 0n);
        const total = money(tax.reduce((s, k) => s + dec(t[k]), 0n));
        const lines = [
          ...(await Promise.all(
            tax.map(async (k) =>
              line(
                await role(`input_${k}`),
                reclaim ? t[k] : '0',
                reclaim ? '0' : t[k],
                k.toUpperCase(),
              ),
            ),
          )),
          line(await role('itc_rule37'), reclaim ? '0' : total, reclaim ? total : '0', 'Rule 37'),
        ];
        return this.ledger.post(
          tx,
          claims,
          { entityId, type: 'journal', date: asOf, narration, reference, lines },
          source,
        );
      };
      for (const d of await this.due(tx, entityId, asOf)) {
        if (!(dec(d.cgst) + dec(d.sgst) + dec(d.igst))) continue;
        const id = randomUUID();
        const v = await post(
          d,
          false,
          `Input credit reversed (Rule 37): ${d.party} bill ${d.billNo} unpaid after 180 days`,
          d.billNo,
          { kind: 'itc_reversal', id },
        );
        await tx`
          INSERT INTO acc.itc_reversal (id, entity_id, bill_id, reversed_on, unpaid, cgst, sgst, igst, voucher_id,
            created_by)
          VALUES (${id}, ${entityId}, ${d.billId}, ${asOf}, ${d.unpaid}, ${d.cgst}, ${d.sgst}, ${d.igst}, ${v!.id},
            ${claims.sub})`;
      }
      for (const o of (await this.open(tx, entityId)).filter((x) => dec(x.outstanding) <= 0n)) {
        const back = reclaimOf(o);
        // Settled wholly by debit notes: nothing comes back, but the reversal is closed.
        const v =
          dec(back.cgst) + dec(back.sgst) + dec(back.igst) > 0n
            ? await post(
                back,
                true,
                `Input credit re-claimed (Rule 37): ${o.party} bill ${o.billNo} paid`,
                o.billNo,
                { kind: 'itc_reclaim', id: o.id },
              )
            : null;
        await tx`UPDATE acc.itc_reversal SET reclaimed_on = ${asOf}, reclaim_voucher_id = ${v?.id ?? null}
          WHERE id = ${o.id}`;
      }
    });
    return this.view(claims, entityId, asOf);
  }
}
