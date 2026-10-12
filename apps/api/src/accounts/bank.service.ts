// Bank reconciliation (docs/wave3-plan.md step 7): statements imported per bank ledger (a table by the saved mapping,
// OFX or MT940; a line seen before is skipped, a file seen before refused); each statement line matched to the
// ledger's voucher lines (suggested by amount, date and cheque or UTR number; confirmed by hand; undone with a reason);
// a line only the bank knows made a voucher in one click; the reconciliation statement as at a date.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';
import { audit } from '../tender/tender-records.js';
import { fromDb } from './accounts-rules.js';
import {
  fingerprints,
  parseCsv,
  parseMt940,
  parseOfx,
  readTable,
  type Mapping,
} from './bank-parse.js';
import { LedgerService } from './ledger.service.js';

type Db = Sql | TransactionSql;
const money = (v: bigint) => fmt(v, 2);
const WINDOW_DAYS = 7;
const days = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export interface BookLine {
  voucherId: string;
  position: number;
  number: string;
  date: string;
  narration: string;
  reference: string;
  /** Debits to the bank positive (money in), credits negative. */
  amount: string;
}

@Injectable()
export class BankService {
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
          p === 'accounts.view'
            ? 'The bank needs the accounts permission.'
            : 'This needs the permission to post.',
      });
  }

  private async bank(db: Db, accountId: string) {
    const [a] = await db<{ code: string; name: string; kind: string }[]>`
      SELECT code, name, kind FROM acc.account WHERE id = ${accountId}`;
    if (!a || a.kind !== 'bank')
      throw new NotFoundException({ code: 'not_a_bank', message: 'Choose a bank ledger.' });
    return a;
  }

  async mapping(claims: TenantClaims, accountId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    await this.bank(db, accountId);
    const [m] = await db<{ mapping: Mapping }[]>`
      SELECT mapping FROM acc.bank_mapping WHERE account_id = ${accountId}`;
    return { mapping: m?.mapping ?? null };
  }

  async setMapping(claims: TenantClaims, accountId: string, mapping: Mapping) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await this.bank(db, accountId);
    await db`
      INSERT INTO acc.bank_mapping (account_id, mapping, updated_by)
      VALUES (${accountId}, ${db.json(JSON.parse(JSON.stringify(mapping)))}, ${claims.sub})
      ON CONFLICT (account_id) DO UPDATE SET mapping = EXCLUDED.mapping, updated_at = now(),
        updated_by = EXCLUDED.updated_by`;
    return { mapping };
  }

  /** Reads the file by what it is: OFX, MT940, an Excel workbook or CSV (the last two by the saved mapping). */
  private async read(db: Db, accountId: string, buf: Buffer) {
    const head = buf.subarray(0, 4096).toString('utf8');
    if (/OFXHEADER|<OFX>/i.test(head))
      return { format: 'ofx' as const, lines: parseOfx(buf.toString('utf8')) };
    if (/:20:/.test(head) && /:61:/.test(buf.toString('utf8')))
      return { format: 'mt940' as const, lines: parseMt940(buf.toString('utf8')) };
    const [m] = await db<{ mapping: Mapping }[]>`
      SELECT mapping FROM acc.bank_mapping WHERE account_id = ${accountId}`;
    if (!m)
      throw new BadRequestException({
        code: 'no_mapping',
        message: "Say first which columns of this bank's statement hold what.",
      });
    let rows: string[][];
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      rows = [];
      wb.worksheets[0]?.eachRow((row) => {
        rows.push(
          Array.from(row.values as ExcelJS.CellValue[], (v) =>
            v instanceof Date
              ? v.toISOString().slice(0, 10)
              : v === null || v === undefined
                ? ''
                : typeof v === 'object' && 'result' in v
                  ? String(v.result)
                  : typeof v === 'object' && 'text' in v
                    ? String(v.text)
                    : String(v),
          ).slice(1),
        );
      });
    } else rows = parseCsv(buf.toString('utf8').replace(/^\uFEFF/, ''));
    return { format: 'table' as const, lines: readTable(rows, m.mapping) };
  }

  async import(claims: TenantClaims, accountId: string, input: { fileName: string; buf: Buffer }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await this.bank(db, accountId);
    const { format, lines } = await this.read(db, accountId, input.buf);
    if (!lines.length)
      throw new BadRequestException({
        code: 'empty_statement',
        message: 'No transactions in the file.',
      });
    const prints = fingerprints(lines);
    return db
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'bank ' + accountId}))`;
        const seen = new Set(
          (
            await tx<{ fingerprint: string }[]>`
              SELECT fingerprint FROM acc.bank_line WHERE account_id = ${accountId} AND fingerprint IN ${tx(prints)}`
          ).map((r) => r.fingerprint),
        );
        const fresh = lines.map((l, i) => ({ l, fp: prints[i]! })).filter((x) => !seen.has(x.fp));
        if (!fresh.length)
          throw new ConflictException({
            code: 'already_imported',
            message: 'Every line of this statement was imported before.',
          });
        const [s] = await tx<{ id: string }[]>`
          INSERT INTO acc.bank_statement (account_id, file_name, format, lines, skipped, imported_by)
          VALUES (${accountId}, ${input.fileName.slice(0, 200)}, ${format}, ${fresh.length},
            ${lines.length - fresh.length}, ${claims.sub})
          RETURNING id`;
        for (const [i, { l, fp }] of fresh.entries())
          await tx`INSERT INTO acc.bank_line (statement_id, account_id, position, txn_date, narration, reference, amount,
              balance, fingerprint)
            VALUES (${s!.id}, ${accountId}, ${i + 1}, ${l.date}, ${l.narration}, ${l.reference}, ${l.amount},
              ${l.balance}, ${fp})`;
        await audit(tx, claims.sub, 'bank.import', 'account', accountId, {
          format,
          lines: fresh.length,
          skipped: lines.length - fresh.length,
        });
        return {
          statementId: s!.id,
          format,
          imported: fresh.length,
          skipped: lines.length - fresh.length,
          from: fresh.map((x) => x.l.date).sort()[0],
          to: fresh
            .map((x) => x.l.date)
            .sort()
            .at(-1),
        };
      })
      .catch(fromDb);
  }

  /** The bank ledger's voucher lines for the company not yet matched (a voucher and its reversal left out). */
  private openBook(db: Db, entityId: string, accountId: string, to?: string) {
    return db<BookLine[]>`
      SELECT l.voucher_id AS "voucherId", l.position, v.number, to_char(v.voucher_date, 'YYYY-MM-DD') AS date,
        v.narration, v.reference, (l.debit - l.credit)::text AS amount
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id
      WHERE l.account_id = ${accountId} AND v.entity_id = ${entityId} ${to ? db`AND v.voucher_date <= ${to}` : db``}
        AND v.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM acc.voucher r WHERE r.reverses_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM acc.bank_match_line ml JOIN acc.bank_match m ON m.id = ml.match_id
          AND m.undone_at IS NULL WHERE ml.voucher_id = l.voucher_id AND ml.position = l.position)
      ORDER BY v.voucher_date, v.number, l.position`;
  }

  /** The statement lines of a period with their matches, the open book lines, and suggestions for each open line. */
  async statement(
    claims: TenantClaims,
    q: { entityId: string; accountId: string; from: string; to: string },
  ) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const bank = await this.bank(db, q.accountId);
    const lines = await db<
      {
        id: string;
        date: string;
        narration: string;
        reference: string;
        amount: string;
        balance: string | null;
        match: {
          id: string;
          vouchers: { voucherId: string; number: string; position: number }[];
        } | null;
      }[]
    >`
      SELECT b.id, to_char(b.txn_date, 'YYYY-MM-DD') AS date, b.narration, b.reference, b.amount::text AS amount,
        b.balance::text AS balance,
        (SELECT json_build_object('id', m.id, 'vouchers', (SELECT json_agg(json_build_object('voucherId', v.id,
            'number', v.number, 'position', ml.position) ORDER BY v.number) FROM acc.bank_match_line ml
            JOIN acc.voucher v ON v.id = ml.voucher_id WHERE ml.match_id = m.id))
          FROM acc.bank_match m WHERE m.bank_line_id = b.id AND m.undone_at IS NULL) AS match
      FROM acc.bank_line b JOIN acc.bank_statement s ON s.id = b.statement_id
      WHERE b.account_id = ${q.accountId} AND b.txn_date BETWEEN ${q.from} AND ${q.to}
      ORDER BY b.txn_date, s.imported_at, b.position`;
    const book = await this.openBook(db, q.entityId, q.accountId);
    const mentions = (l: { narration: string; reference: string }, v: BookLine) => {
      const hay = `${l.reference} ${l.narration}`.toUpperCase();
      const refs = [v.reference, v.number]
        .map((x) => x.trim().toUpperCase())
        .filter((x) => x.length >= 4);
      return (
        refs.some((r) => hay.includes(r)) ||
        (l.reference.trim().length >= 4 &&
          v.reference.toUpperCase().includes(l.reference.trim().toUpperCase()))
      );
    };
    const withSuggestions = lines.map((l) => ({
      ...l,
      suggestions: l.match
        ? []
        : book
            .filter((v) => dec(v.amount) === dec(l.amount) && days(v.date, l.date) <= WINDOW_DAYS)
            .map((v) => ({ ...v, byReference: mentions(l, v), days: days(v.date, l.date) }))
            .sort((a, b) => Number(b.byReference) - Number(a.byReference) || a.days - b.days)
            .slice(0, 3),
    }));
    return {
      ...q,
      account: bank,
      lines: withSuggestions,
      book: book.filter((v) => v.date <= q.to),
      mayPost: await this.permissions.can(claims, 'accounts.post'),
    };
  }

  /** A statement line matched to voucher lines on the same ledger that add up to it, the same way round. */
  async match(
    claims: TenantClaims,
    bankLineId: string,
    input: { entityId: string; lines: { voucherId: string; position: number }[] },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const l = await this.bankLine(tx, bankLineId);
        await this.link(tx, claims, l, input.entityId, input.lines);
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'already_matched',
            message: 'This line is already matched.',
          });
        return fromDb(err);
      });
    return { matched: true };
  }

  private async bankLine(tx: TransactionSql, id: string) {
    const [l] = await tx<
      { id: string; account_id: string; amount: string; date: string; reference: string }[]
    >`
      SELECT id, account_id, amount::text AS amount, to_char(txn_date, 'YYYY-MM-DD') AS date, reference
      FROM acc.bank_line WHERE id = ${id}`;
    if (!l) throw new NotFoundException({ code: 'line_not_found' });
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'bank ' + l.account_id}))`;
    return l;
  }

  private async link(
    tx: TransactionSql,
    claims: TenantClaims,
    l: { id: string; account_id: string; amount: string },
    entityId: string,
    picks: { voucherId: string; position: number }[],
  ) {
    if (!picks.length)
      throw new BadRequestException({
        code: 'nothing_picked',
        message: 'Pick the voucher lines it matches.',
      });
    const open = await this.openBook(tx, entityId, l.account_id);
    let sum = 0n;
    for (const p of picks) {
      const v = open.find((x) => x.voucherId === p.voucherId && x.position === p.position);
      if (!v)
        throw new BadRequestException({
          code: 'not_open',
          message: 'A voucher line picked is not on this bank ledger, or is already matched.',
        });
      sum += dec(v.amount);
    }
    if (sum !== dec(l.amount))
      throw new BadRequestException({
        code: 'amounts_differ',
        message: `The voucher lines come to ₹${money(sum)}; the statement line is ₹${l.amount}.`,
      });
    const [m] = await tx<{ id: string }[]>`
      INSERT INTO acc.bank_match (account_id, bank_line_id, created_by) VALUES (${l.account_id}, ${l.id}, ${claims.sub})
      RETURNING id`;
    for (const p of picks)
      await tx`INSERT INTO acc.bank_match_line (match_id, voucher_id, position)
        VALUES (${m!.id}, ${p.voucherId}, ${p.position})`;
    await audit(tx, claims.sub, 'bank.match', 'bank_line', l.id, { vouchers: picks.length });
  }

  async undo(claims: TenantClaims, matchId: string, reason: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [m] = await tx`
        UPDATE acc.bank_match SET undone_at = now(), undone_by = ${claims.sub}, undo_reason = ${reason}
        WHERE id = ${matchId} AND undone_at IS NULL RETURNING bank_line_id`;
      if (!m)
        throw new NotFoundException({
          code: 'match_not_found',
          message: 'No such match, or already undone.',
        });
      await audit(tx, claims.sub, 'bank.unmatch', 'bank_line', m.bank_line_id as string, {
        reason,
      });
    });
    return { undone: true };
  }

  /**
   * A line only the bank knows (charges, interest) made a voucher on the statement's date and matched at once: a
   * withdrawal posts the ledger Dr and the bank Cr; a deposit the bank Dr and the ledger Cr.
   */
  async post(
    claims: TenantClaims,
    bankLineId: string,
    input: { entityId: string; accountId: string; narration: string },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const v = await db
      .begin(async (tx) => {
        const l = await this.bankLine(tx, bankLineId);
        const [live] =
          await tx`SELECT 1 FROM acc.bank_match WHERE bank_line_id = ${l.id} AND undone_at IS NULL`;
        if (live)
          throw new ConflictException({
            code: 'already_matched',
            message: 'This line is already matched.',
          });
        const amount = dec(l.amount);
        const abs = money(amount < 0n ? -amount : amount);
        const line = (accountId: string, debit: string, credit: string) => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId: null,
          siteId: null,
          costCodeId: null,
          note: input.narration,
        });
        const v = await this.ledger.post(tx, claims, {
          entityId: input.entityId,
          type: amount < 0n ? 'payment' : 'receipt',
          date: l.date,
          narration: input.narration,
          reference: l.reference.slice(0, 100),
          lines:
            amount < 0n
              ? [line(input.accountId, abs, '0'), line(l.account_id, '0', abs)]
              : [line(l.account_id, abs, '0'), line(input.accountId, '0', abs)],
        });
        const [pos] = await tx<{ position: number }[]>`
          SELECT position FROM acc.voucher_line WHERE voucher_id = ${v!.id} AND account_id = ${l.account_id}`;
        await this.link(tx, claims, l, input.entityId, [
          { voucherId: v!.id, position: pos!.position },
        ]);
        return v!;
      })
      .catch(fromDb);
    return { voucher: { id: v.id, number: v.number } };
  }

  /**
   * The reconciliation as at a date: the books' balance; cheques issued and not presented by then; deposits not yet
   * credited; what the bank shows that the books do not; the balance as per the bank so worked, against the
   * statement's own balance on its last line to that date.
   */
  async reconciliation(
    claims: TenantClaims,
    q: { entityId: string; accountId: string; asOf: string },
  ) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const bank = await this.bank(db, q.accountId);
    const [books] = await db<{ balance: string }[]>`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS balance FROM acc.voucher_line l
      JOIN acc.voucher v ON v.id = l.voucher_id
      WHERE l.account_id = ${q.accountId} AND v.entity_id = ${q.entityId} AND v.voucher_date <= ${q.asOf}`;
    // Book lines not matched to a statement line dated by then.
    const unmatched = await db<BookLine[]>`
      SELECT l.voucher_id AS "voucherId", l.position, v.number, to_char(v.voucher_date, 'YYYY-MM-DD') AS date,
        v.narration, v.reference, (l.debit - l.credit)::text AS amount
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id
      WHERE l.account_id = ${q.accountId} AND v.entity_id = ${q.entityId} AND v.voucher_date <= ${q.asOf}
        AND v.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM acc.voucher r WHERE r.reverses_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM acc.bank_match_line ml JOIN acc.bank_match m ON m.id = ml.match_id
          AND m.undone_at IS NULL JOIN acc.bank_line b ON b.id = m.bank_line_id AND b.txn_date <= ${q.asOf}
          WHERE ml.voucher_id = l.voucher_id AND ml.position = l.position)
      ORDER BY v.voucher_date, v.number`;
    // Statement lines by then not matched to voucher lines dated by then.
    const bankOnly = await db<
      { id: string; date: string; narration: string; reference: string; amount: string }[]
    >`
      SELECT b.id, to_char(b.txn_date, 'YYYY-MM-DD') AS date, b.narration, b.reference, b.amount::text AS amount
      FROM acc.bank_line b
      WHERE b.account_id = ${q.accountId} AND b.txn_date <= ${q.asOf}
        AND NOT EXISTS (SELECT 1 FROM acc.bank_match m JOIN acc.bank_match_line ml ON ml.match_id = m.id
          JOIN acc.voucher v ON v.id = ml.voucher_id AND v.voucher_date <= ${q.asOf}
          WHERE m.bank_line_id = b.id AND m.undone_at IS NULL)
      ORDER BY b.txn_date`;
    const [stmt] = await db<{ balance: string | null; date: string }[]>`
      SELECT b.balance::text AS balance, to_char(b.txn_date, 'YYYY-MM-DD') AS date FROM acc.bank_line b
      JOIN acc.bank_statement s ON s.id = b.statement_id
      WHERE b.account_id = ${q.accountId} AND b.txn_date <= ${q.asOf} AND b.balance IS NOT NULL
      ORDER BY b.txn_date DESC, s.imported_at DESC, b.position DESC LIMIT 1`;
    const issued = unmatched.filter((l) => dec(l.amount) < 0n);
    const deposited = unmatched.filter((l) => dec(l.amount) > 0n);
    const sum = (rows: { amount: string }[]) => rows.reduce((s, r) => s + dec(r.amount), 0n);
    const perBank = dec(books!.balance) - sum(issued) - sum(deposited) + sum(bankOnly);
    return {
      ...q,
      account: bank,
      books: books!.balance,
      notPresented: { total: money(-sum(issued)), lines: issued },
      notCredited: { total: money(sum(deposited)), lines: deposited },
      bankOnly: { total: money(sum(bankOnly)), lines: bankOnly },
      perBank: money(perBank),
      statement: stmt?.balance ? { balance: stmt.balance, date: stmt.date } : null,
      difference: stmt?.balance ? money(dec(stmt.balance) - perBank) : null,
    };
  }
}
