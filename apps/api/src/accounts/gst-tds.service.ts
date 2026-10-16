// GST TDS by government clients (docs/wave8-plan.md step 8b.2, CGST Act section 51): what the receipts say each
// client deducted, month by month, against what the deductor's return shows (GSTR-7A, entered by accounts as it is
// accepted on the portal). Accepting a month's credit moves it from the receivable to the electronic cash ledger.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';
import { fromDb } from './accounts-rules.js';
import { LedgerService, type LineInput } from './ledger.service.js';

type Db = Sql | TransactionSql;

export interface GstTdsRow {
  partyId: string;
  party: string;
  gstin: string | null;
  month: string;
  receipts: number;
  books: string;
  credit: { amount: string; deductorGstin: string; acceptedOn: string } | null;
  state: 'matched' | 'differs' | 'awaiting';
}

@Injectable()
export class GstTdsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          p === 'accounts.post'
            ? 'Only accounts may accept GST TDS.'
            : 'Only accounts may see this.',
      });
  }

  private async rows(db: Db, entityId: string, from: string, to: string): Promise<GstTdsRow[]> {
    const rows = await db<Omit<GstTdsRow, 'state'>[]>`
      WITH books AS (
        SELECT r.party_id, date_trunc('month', r.received_on)::date AS month, count(*)::int AS receipts,
          sum(r.gst_tds) AS amount
        FROM acc.client_receipt r
        WHERE r.entity_id = ${entityId} AND r.status = 'posted' AND r.gst_tds > 0
          AND r.received_on BETWEEN ${from} AND ${to}
        GROUP BY 1, 2),
      credits AS (
        SELECT * FROM acc.gst_tds_credit WHERE entity_id = ${entityId} AND month BETWEEN date_trunc('month', ${from}::date)
          AND ${to})
      SELECT p.id AS "partyId", p.name AS party, p.gstin, to_char(coalesce(b.month, c.month), 'YYYY-MM') AS month,
        coalesce(b.receipts, 0) AS receipts, coalesce(b.amount, 0)::text AS books,
        CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('amount', c.amount::text,
          'deductorGstin', c.deductor_gstin, 'acceptedOn', to_char(c.accepted_on, 'YYYY-MM-DD')) END AS credit
      FROM books b FULL JOIN credits c ON c.party_id = b.party_id AND c.month = b.month
      JOIN platform.party p ON p.id = coalesce(b.party_id, c.party_id)
      ORDER BY 4, p.name`;
    return rows.map((r) => ({
      ...r,
      state: !r.credit ? 'awaiting' : dec(r.credit.amount) === dec(r.books) ? 'matched' : 'differs',
    }));
  }

  async view(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await this.rows(db, q.entityId, q.from, q.to);
    const sum = (f: (r: GstTdsRow) => string | undefined) =>
      fmt(
        rows.reduce((s, r) => s + dec(f(r) ?? '0'), 0n),
        2,
      );
    return {
      ...q,
      rows,
      totals: { books: sum((r) => r.books), credited: sum((r) => r.credit?.amount) },
      mayPost: await this.permissions.can(claims, 'accounts.post'),
    };
  }

  /** A month's credit from one deductor, as GSTR-7A shows it, accepted into the cash ledger. */
  async accept(
    claims: TenantClaims,
    input: {
      entityId: string;
      partyId: string;
      month: string;
      deductorGstin: string;
      amount: string;
      acceptedOn: string;
    },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const month = `${input.month}-01`;
    if (input.acceptedOn < month)
      throw new BadRequestException({
        code: 'accepted_before_month',
        message: 'The credit is accepted after the month it was deducted in.',
      });
    await db
      .begin(async (tx) => {
        const [dup] = await tx`
          SELECT 1 FROM acc.gst_tds_credit WHERE entity_id = ${input.entityId} AND party_id = ${input.partyId}
            AND month = ${month}`;
        if (dup)
          throw new ConflictException({
            code: 'already_accepted',
            message: "That month's credit from this client is already accepted.",
          });
        const [party] = await tx<{ name: string }[]>`
          SELECT name FROM platform.party WHERE id = ${input.partyId} AND deleted_at IS NULL`;
        if (!party) throw new BadRequestException({ code: 'party_not_found' });
        const id = randomUUID();
        const line = (accountId: string, debit: string, credit: string): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId: null,
          siteId: null,
          costCodeId: null,
          note: `GSTR-7A ${input.month}, ${input.deductorGstin}`,
        });
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: input.entityId,
            type: 'journal',
            date: input.acceptedOn,
            narration: `GST TDS by ${party.name} for ${input.month} taken into the cash ledger`,
            reference: input.deductorGstin,
            lines: [
              line(
                await this.ledger.roleAccount(tx, input.entityId, 'gst_cash_ledger'),
                input.amount,
                '0',
              ),
              line(
                await this.ledger.roleAccount(tx, input.entityId, 'gst_tds_receivable'),
                '0',
                input.amount,
              ),
            ],
          },
          { kind: 'gst_tds_credit', id },
        );
        await tx`
          INSERT INTO acc.gst_tds_credit (id, entity_id, party_id, month, deductor_gstin, amount, accepted_on, voucher_id,
            created_by)
          VALUES (${id}, ${input.entityId}, ${input.partyId}, ${month}, ${input.deductorGstin}, ${input.amount},
            ${input.acceptedOn}, ${v!.id}, ${claims.sub})`;
      })
      .catch(fromDb);
    const [y, m] = input.month.split('-').map(Number) as [number, number];
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return this.view(claims, { entityId: input.entityId, from: month, to: end });
  }
}
