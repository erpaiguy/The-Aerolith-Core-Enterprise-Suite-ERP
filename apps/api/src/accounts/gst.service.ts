// GST (docs/wave3-plan.md step 6a): credit notes to clients; the outward and inward registers; GSTR-1 data in the
// offline tool's sheets and the GSTR-3B summary; the e-invoice JSON (schema 1.1) and the IRN it comes back with; the
// supplier-filed GSTR-2B matched against the purchase book.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, div, fmt, mul, type Dec } from '../rates/decimal.js';
import { nextNumber } from '../tender/numbering.js';
import { audit } from '../tender/tender-records.js';
import { fromDb } from './accounts-rules.js';
import { LedgerService, type LineInput } from './ledger.service.js';

type Db = Sql | TransactionSql;
const money = (v: Dec) => fmt(v, 2);
const r2 = (v: Dec) => dec(fmt(v, 2));
/** [Likely] An inter-state invoice to an unregistered client above this goes to B2CL, not B2CS. */
export const B2CL_LIMIT = '100000';

/** GST state codes and names, as the returns print the place of supply ("27-Maharashtra"). */
export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};
export const placeOfSupply = (code: string | null) =>
  code ? `${code}-${STATES[code] ?? 'Unknown'}` : '';

/** dd-MMM-yy, as the offline tool's sheets take dates. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const toolDate = (d: string) =>
  `${d.slice(8, 10)}-${MONTHS[Number(d.slice(5, 7)) - 1]}-${d.slice(2, 4)}`;
const slashDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export const monthRange = (period: string) => {
  const [y, m] = [Number(period.slice(0, 4)), Number(period.slice(5, 7))];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
};
/** A supplier's bill number as matched against 2B: letters and digits only, upper case, leading zeros dropped. */
export const normaliseNo = (v: string) =>
  v
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^0+/, '');

export interface OutwardRow {
  kind: 'invoice' | 'credit_note';
  id: string;
  billId: string;
  number: string;
  date: string;
  partyId: string | null;
  party: string;
  gstin: string | null;
  pos: string | null;
  rate: string;
  sac: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  originalNo: string | null;
  originalDate: string | null;
}
export interface InwardRow {
  kind: 'bill' | 'debit_note';
  id: string;
  billId: string;
  party: string;
  gstin: string | null;
  billNo: string;
  date: string;
  supply: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  blocked: string;
}

@Injectable()
export class GstService {
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
            ? 'GST needs the accounts permission.'
            : 'This needs the permission to post.',
      });
  }

  // --- credit notes to clients ---

  /** A client bill's outstanding: its net less receipts and credit notes. */
  private async billLeft(db: Db, billId: string) {
    const [r] = await db<{ left: string }[]>`
      SELECT ((b.certified ->> 'net')::numeric
        - coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id
            AND r.status = 'posted' WHERE a.bill_id = b.id), 0)
        - coalesce((SELECT sum(n.total) FROM acc.credit_note n WHERE n.bill_id = b.id), 0))::text AS left
      FROM acc.client_bill b WHERE b.id = ${billId}`;
    return dec(r!.left);
  }

  async creditNote(
    claims: TenantClaims,
    billId: string,
    input: { date: string; reason: string; taxable: string },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        const [b] = await tx<
          {
            status: string;
            entity_id: string;
            project_id: string;
            site_id: string;
            client_id: string | null;
            invoice_no: string | null;
            invoice_date: string | null;
            intra: boolean;
            gst_pct: string;
            ra_no: number;
          }[]
        >`
          SELECT b.status, b.entity_id, b.project_id, b.site_id, p.client_id, b.invoice_no,
            to_char(b.invoice_date, 'YYYY-MM-DD') AS invoice_date, b.intra, b.terms ->> 'gstPct' AS gst_pct, b.ra_no
          FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id WHERE b.id = ${billId} FOR UPDATE OF b`;
        if (!b || b.status !== 'certified' || !b.client_id)
          throw new ConflictException({
            code: 'not_an_invoice',
            message: "A credit note goes against a certified bill's tax invoice.",
          });
        if (input.date < b.invoice_date!)
          throw new BadRequestException({
            code: 'before_invoice',
            message: 'Not before the invoice.',
          });
        const taxable = dec(input.taxable);
        const [cgst, sgst, igst] = b.intra
          ? [
              r2(mul(taxable, div(dec(b.gst_pct), dec('200')))),
              r2(mul(taxable, div(dec(b.gst_pct), dec('200')))),
              0n,
            ]
          : [0n, 0n, r2(mul(taxable, div(dec(b.gst_pct), dec('100'))))];
        const total = taxable + cgst + sgst + igst;
        const left = await this.billLeft(tx, billId);
        if (total > left)
          throw new BadRequestException({
            code: 'over_outstanding',
            message: `₹${money(total)} is more than the ₹${money(left)} outstanding on the bill.`,
          });
        const number = await nextNumber(
          tx,
          'credit_note',
          b.entity_id,
          'CN',
          new Date(`${input.date}T00:00:00Z`),
        );
        const line = (accountId: string, debit: string, credit: string): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId: b.project_id,
          siteId: b.site_id,
          costCodeId: null,
          note: input.reason,
        });
        const role = (r: Parameters<LedgerService['roleAccount']>[2]) =>
          this.ledger.roleAccount(tx, b.entity_id, r);
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: b.entity_id,
            type: 'credit_note',
            date: input.date,
            narration: `${number} against ${b.invoice_no}: ${input.reason}`,
            reference: number,
            lines: [
              line(await role('sales_works_contract'), money(taxable), '0'),
              ...(cgst ? [line(await role('output_cgst'), money(cgst), '0')] : []),
              ...(sgst ? [line(await role('output_sgst'), money(sgst), '0')] : []),
              ...(igst ? [line(await role('output_igst'), money(igst), '0')] : []),
              line(await this.ledger.partyLedger(tx, b.client_id), '0', money(total)),
            ],
          },
          { kind: 'credit_note', id: billId },
        );
        const [n] = await tx<{ id: string }[]>`
          INSERT INTO acc.credit_note (entity_id, bill_id, number, note_date, reason, taxable, gst_pct, cgst, sgst, igst,
            total, voucher_id, created_by)
          VALUES (${b.entity_id}, ${billId}, ${number}, ${input.date}, ${input.reason}, ${money(taxable)}, ${b.gst_pct},
            ${money(cgst)}, ${money(sgst)}, ${money(igst)}, ${money(total)}, ${v!.id}, ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'credit_note.create', 'client_bill', billId, {
          number,
          total: money(total),
        });
        return n!.id;
      })
      .catch(fromDb);
    return this.creditNoteById(claims, id);
  }

  async creditNoteById(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [n] = await db`
      SELECT n.id, n.bill_id AS "billId", n.number, to_char(n.note_date, 'YYYY-MM-DD') AS date, n.reason,
        n.taxable::text AS taxable, n.gst_pct::text AS "gstPct", n.cgst::text AS cgst, n.sgst::text AS sgst,
        n.igst::text AS igst, n.total::text AS total, v.number AS voucher, v.id AS "voucherId"
      FROM acc.credit_note n JOIN acc.voucher v ON v.id = n.voucher_id WHERE n.id = ${id}`;
    if (!n) throw new NotFoundException({ code: 'credit_note_not_found' });
    return { ...n, eInvoice: await this.irnOf(db, 'credit_note', id) };
  }

  async billGst(claims: TenantClaims, billId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const mayPost = await this.permissions.can(claims, 'accounts.post');
    return { ...(await this.forBill(db, billId)), mayPost };
  }

  /** A client bill's credit notes and e-invoice, for its page. */
  async forBill(db: Db, billId: string) {
    const notes = await db<{ id: string }[]>`
      SELECT n.id, n.number, to_char(n.note_date, 'YYYY-MM-DD') AS date, n.reason, n.taxable::text AS taxable,
        n.total::text AS total
      FROM acc.credit_note n WHERE n.bill_id = ${billId} ORDER BY n.note_date, n.number`;
    return {
      creditNotes: await Promise.all(
        notes.map(async (n) => ({ ...n, eInvoice: await this.irnOf(db, 'credit_note', n.id) })),
      ),
      eInvoice: await this.irnOf(db, 'invoice', billId),
    };
  }

  private async irnOf(db: Db, kind: 'invoice' | 'credit_note', id: string) {
    const [e] = await db<{ irn: string; ackNo: string; ackDate: string; signedQr: string }[]>`
      SELECT irn, ack_no AS "ackNo", to_char(ack_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS "ackDate",
        signed_qr AS "signedQr"
      FROM acc.e_invoice WHERE doc_kind = ${kind} AND doc_id = ${id}`;
    return e ?? null;
  }

  // --- registers ---

  private async outward(db: Db, entityId: string, from: string, to: string) {
    const rows = await db<OutwardRow[]>`
      SELECT * FROM (
        SELECT 'invoice' AS kind, b.id, b.id AS "billId", b.invoice_no AS number,
          to_char(b.invoice_date, 'YYYY-MM-DD') AS date, c.id AS "partyId", coalesce(c.legal_name, c.name, '') AS party,
          c.gstin, s.state_code AS pos, (b.terms ->> 'gstPct') AS rate, coalesce(t.sac, '9954') AS sac,
          (b.certified ->> 'taxable') AS taxable, (b.certified ->> 'cgst') AS cgst, (b.certified ->> 'sgst') AS sgst,
          (b.certified ->> 'igst') AS igst, (b.certified ->> 'invoiceTotal') AS total, NULL AS "originalNo",
          NULL AS "originalDate"
        FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id JOIN proj.site s ON s.id = b.site_id
        LEFT JOIN platform.party c ON c.id = p.client_id LEFT JOIN acc.bill_terms t ON t.project_id = p.id
        WHERE b.status = 'certified' AND b.entity_id = ${entityId} AND b.invoice_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'credit_note', n.id, b.id, n.number, to_char(n.note_date, 'YYYY-MM-DD'), c.id,
          coalesce(c.legal_name, c.name, ''), c.gstin, s.state_code, n.gst_pct::text, coalesce(t.sac, '9954'),
          n.taxable::text, n.cgst::text, n.sgst::text, n.igst::text, n.total::text, b.invoice_no,
          to_char(b.invoice_date, 'YYYY-MM-DD')
        FROM acc.credit_note n JOIN acc.client_bill b ON b.id = n.bill_id JOIN proj.project p ON p.id = b.project_id
        JOIN proj.site s ON s.id = b.site_id LEFT JOIN platform.party c ON c.id = p.client_id
        LEFT JOIN acc.bill_terms t ON t.project_id = p.id
        WHERE n.entity_id = ${entityId} AND n.note_date BETWEEN ${from} AND ${to}
      ) x ORDER BY date, number`;
    // The rate as the returns write it: 18, not 18.00.
    return rows.map((r) => ({ ...r, rate: String(Number(r.rate)) }));
  }

  private inward(db: Db, entityId: string, from: string, to: string) {
    return db<InwardRow[]>`
      SELECT * FROM (
        SELECT 'bill' AS kind, b.id, b.id AS "billId", p.name AS party, p.gstin, b.bill_no AS "billNo",
          to_char(b.bill_date, 'YYYY-MM-DD') AS date, b.supply, b.taxable::text AS taxable, b.cgst::text AS cgst,
          b.sgst::text AS sgst, b.igst::text AS igst, b.total::text AS total, b.itc_blocked::text AS blocked
        FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id
        WHERE b.entity_id = ${entityId} AND b.status = 'posted' AND b.source IS DISTINCT FROM 'retention_release'
          AND b.bill_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'debit_note', d.id, b.id, p.name, p.gstin, b.bill_no, to_char(d.note_date, 'YYYY-MM-DD'), b.supply,
          d.taxable::text, d.cgst::text, d.sgst::text, d.igst::text, d.total::text, '0.00'
        FROM acc.debit_note d JOIN acc.vendor_bill b ON b.id = d.bill_id JOIN platform.party p ON p.id = b.party_id
        WHERE d.entity_id = ${entityId} AND d.note_date BETWEEN ${from} AND ${to}
      ) x ORDER BY date, party, "billNo"`;
  }

  async registers(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const outward = await this.outward(db, q.entityId, q.from, q.to);
    const inward = await this.inward(db, q.entityId, q.from, q.to);
    const sum = <T extends { kind: string }>(rows: T[], k: keyof T, minus: string) =>
      money(rows.reduce((s, r) => s + (r.kind === minus ? -1n : 1n) * dec(r[k] as string), 0n));
    return {
      ...q,
      outward,
      inward,
      outwardTotals: {
        taxable: sum(outward, 'taxable', 'credit_note'),
        cgst: sum(outward, 'cgst', 'credit_note'),
        sgst: sum(outward, 'sgst', 'credit_note'),
        igst: sum(outward, 'igst', 'credit_note'),
        total: sum(outward, 'total', 'credit_note'),
      },
      inwardTotals: {
        taxable: sum(inward, 'taxable', 'debit_note'),
        cgst: sum(inward, 'cgst', 'debit_note'),
        sgst: sum(inward, 'sgst', 'debit_note'),
        igst: sum(inward, 'igst', 'debit_note'),
        total: sum(inward, 'total', 'debit_note'),
        blocked: sum(inward, 'blocked', 'debit_note'),
      },
    };
  }

  // --- GSTR-1 and GSTR-3B ---

  private async companyState(db: Db, entityId: string) {
    const [e] = await db<{ state_code: string | null; gstin: string | null; name: string }[]>`
      SELECT state_code, gstin, name FROM platform.entity WHERE id = ${entityId}`;
    if (!e) throw new NotFoundException({ code: 'company_not_found' });
    return e;
  }

  /** The month's outward supplies in the GSTR-1 offline tool's sheets. */
  async gstr1(claims: TenantClaims, q: { entityId: string; period: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const company = await this.companyState(db, q.entityId);
    const { from, to } = monthRange(q.period);
    const rows = await this.outward(db, q.entityId, from, to);
    const invoices = rows.filter((r) => r.kind === 'invoice');
    const notes = rows.filter((r) => r.kind === 'credit_note');
    const b2bRows = invoices.filter((r) => r.gstin);
    const isB2cl = (r: OutwardRow) =>
      !r.gstin && r.pos !== company.state_code && dec(r.total) > dec(B2CL_LIMIT);
    const b2b = b2bRows.map((r) => ({
      gstin: r.gstin!,
      receiver: r.party,
      number: r.number,
      date: toolDate(r.date),
      value: r.total,
      pos: placeOfSupply(r.pos),
      reverseCharge: 'N',
      applicablePct: '',
      invoiceType: 'Regular B2B',
      ecommerceGstin: '',
      rate: r.rate,
      taxable: r.taxable,
      cess: '0.00',
    }));
    const b2cl = invoices.filter(isB2cl).map((r) => ({
      number: r.number,
      date: toolDate(r.date),
      value: r.total,
      pos: placeOfSupply(r.pos),
      applicablePct: '',
      rate: r.rate,
      taxable: r.taxable,
      cess: '0.00',
      ecommerceGstin: '',
    }));
    // B2CS: the rest to unregistered clients, by place of supply and rate, net of their credit notes.
    const b2csMap = new Map<string, Dec>();
    for (const r of [
      ...invoices.filter((x) => !x.gstin && !isB2cl(x)),
      ...notes.filter((x) => !x.gstin),
    ]) {
      const k = `${r.pos}|${r.rate}`;
      b2csMap.set(
        k,
        (b2csMap.get(k) ?? 0n) + (r.kind === 'credit_note' ? -1n : 1n) * dec(r.taxable),
      );
    }
    const b2cs = [...b2csMap.entries()].map(([k, taxable]) => {
      const [pos, rate] = k.split('|');
      return {
        type: 'OE',
        pos: placeOfSupply(pos ?? null),
        applicablePct: '',
        rate: rate!,
        taxable: money(taxable),
        cess: '0.00',
        ecommerceGstin: '',
      };
    });
    const cdnr = notes
      .filter((r) => r.gstin)
      .map((r) => ({
        gstin: r.gstin!,
        receiver: r.party,
        number: r.number,
        date: toolDate(r.date),
        noteType: 'C',
        pos: placeOfSupply(r.pos),
        reverseCharge: 'N',
        supplyType: 'Regular B2B',
        value: r.total,
        applicablePct: '',
        rate: r.rate,
        taxable: r.taxable,
        cess: '0.00',
      }));
    // HSN summary, apart for registered and unregistered clients, net of credit notes.
    const hsn = (registered: boolean) => {
      const m = new Map<string, { value: Dec; taxable: Dec; igst: Dec; cgst: Dec; sgst: Dec }>();
      for (const r of rows.filter((x) => Boolean(x.gstin) === registered)) {
        const k = `${r.sac}|${r.rate}`;
        const s = r.kind === 'credit_note' ? -1n : 1n;
        const a = m.get(k) ?? { value: 0n, taxable: 0n, igst: 0n, cgst: 0n, sgst: 0n };
        a.value += s * dec(r.total);
        a.taxable += s * dec(r.taxable);
        a.igst += s * dec(r.igst);
        a.cgst += s * dec(r.cgst);
        a.sgst += s * dec(r.sgst);
        m.set(k, a);
      }
      return [...m.entries()].map(([k, a]) => {
        const [sac, rate] = k.split('|');
        return {
          hsn: sac!,
          description: 'Construction services',
          uqc: 'OTH-OTHERS',
          quantity: '0',
          value: money(a.value),
          rate: rate!,
          taxable: money(a.taxable),
          igst: money(a.igst),
          cgst: money(a.cgst),
          sgst: money(a.sgst),
          cess: '0.00',
        };
      });
    };
    const range = (list: OutwardRow[], nature: string) =>
      list.length
        ? [
            {
              nature,
              from: list[0]!.number,
              to: list[list.length - 1]!.number,
              total: list.length,
              cancelled: 0,
            },
          ]
        : [];
    const byNo = (a: OutwardRow, b: OutwardRow) => a.number.localeCompare(b.number);
    return {
      ...q,
      company: { name: company.name, gstin: company.gstin },
      b2b,
      b2cl,
      b2cs,
      cdnr,
      hsnB2b: hsn(true),
      hsnB2c: hsn(false),
      docs: [
        ...range([...invoices].sort(byNo), 'Invoices for outward supply'),
        ...range([...notes].sort(byNo), 'Credit Note'),
      ],
    };
  }

  /**
   * The month's GSTR-3B: 3.1(a) outward taxable supplies; 3.1(d) inward supplies under reverse charge, whose tax is
   * paid in cash; 4 input tax: all (with reverse charge apart, 4(A)(3)), blocked, reversed under Rule 37 (4(B)(2)),
   * re-claimed (4(D)(1)), net.
   */
  async gstr3b(claims: TenantClaims, q: { entityId: string; period: string }) {
    await this.may(claims, 'accounts.view');
    const { from, to } = monthRange(q.period);
    const r = await this.registers(claims, { entityId: q.entityId, from, to });
    const db = await this.tenants.forTenant(claims.ten);
    const blocked = { igst: 0n, cgst: 0n, sgst: 0n };
    for (const b of r.inward.filter((x) => x.kind === 'bill' && dec(x.blocked))) {
      if (dec(b.igst)) blocked.igst += dec(b.blocked);
      else {
        blocked.cgst += dec(b.blocked) / 2n;
        blocked.sgst += dec(b.blocked) / 2n;
      }
    }
    const [rc] = await db<
      {
        taxable: string;
        cgst: string;
        sgst: string;
        igst: string;
        bi: string;
        bcs: string;
      }[]
    >`
      SELECT coalesce(sum(taxable), 0)::text AS taxable, coalesce(sum(rcm_cgst), 0)::text AS cgst,
        coalesce(sum(rcm_sgst), 0)::text AS sgst, coalesce(sum(rcm_igst), 0)::text AS igst,
        coalesce(sum(rcm_blocked) FILTER (WHERE rcm_igst > 0), 0)::text AS bi,
        coalesce(sum(rcm_blocked) FILTER (WHERE rcm_igst = 0), 0)::text AS bcs
      FROM acc.vendor_bill
      WHERE entity_id = ${q.entityId} AND status = 'posted' AND rcm_category IS NOT NULL
        AND bill_date BETWEEN ${from} AND ${to}`;
    const [rv] = await db<
      { rc: string; rs: string; ri: string; cc: string; cs: string; ci: string }[]
    >`
      SELECT
        coalesce(sum(cgst) FILTER (WHERE reversed_on BETWEEN ${from} AND ${to}), 0)::text AS rc,
        coalesce(sum(sgst) FILTER (WHERE reversed_on BETWEEN ${from} AND ${to}), 0)::text AS rs,
        coalesce(sum(igst) FILTER (WHERE reversed_on BETWEEN ${from} AND ${to}), 0)::text AS ri,
        coalesce(sum(cgst) FILTER (WHERE reclaimed_on BETWEEN ${from} AND ${to}), 0)::text AS cc,
        coalesce(sum(sgst) FILTER (WHERE reclaimed_on BETWEEN ${from} AND ${to}), 0)::text AS cs,
        coalesce(sum(igst) FILTER (WHERE reclaimed_on BETWEEN ${from} AND ${to}), 0)::text AS ci
      FROM acc.itc_reversal WHERE entity_id = ${q.entityId}`;
    const rcm = { igst: dec(rc!.igst), cgst: dec(rc!.cgst), sgst: dec(rc!.sgst) };
    // Blocked reverse-charge tax is not credit: all of it, or half each side within the state.
    const rcmBlocked = { igst: dec(rc!.bi), cgst: dec(rc!.bcs) / 2n, sgst: dec(rc!.bcs) / 2n };
    const reversed = { igst: dec(rv!.ri), cgst: dec(rv!.rc), sgst: dec(rv!.rs) };
    const reclaimed = { igst: dec(rv!.ci), cgst: dec(rv!.cc), sgst: dec(rv!.cs) };
    const all = r.inwardTotals;
    const heads = ['igst', 'cgst', 'sgst'] as const;
    const each = (f: (k: (typeof heads)[number]) => bigint) => ({
      igst: money(f('igst')),
      cgst: money(f('cgst')),
      sgst: money(f('sgst')),
      cess: '0.00',
    });
    const net = (k: (typeof heads)[number]) =>
      dec(all[k]) - blocked[k] + rcm[k] - rcmBlocked[k] - reversed[k] + reclaimed[k];
    return {
      ...q,
      outward: {
        taxable: r.outwardTotals.taxable,
        igst: r.outwardTotals.igst,
        cgst: r.outwardTotals.cgst,
        sgst: r.outwardTotals.sgst,
        cess: '0.00',
      },
      inwardReverseCharge: { taxable: rc!.taxable, ...each((k) => rcm[k]) },
      itcAll: { igst: all.igst, cgst: all.cgst, sgst: all.sgst, cess: '0.00' },
      itcReverseCharge: each((k) => rcm[k] - rcmBlocked[k]),
      itcBlocked: each((k) => blocked[k] + rcmBlocked[k]),
      itcReversedRule37: each((k) => reversed[k]),
      itcReclaimed: each((k) => reclaimed[k]),
      itcNet: each(net),
      // Paid from the credit ledger; reverse-charge tax only in cash.
      payable: {
        igst: money(dec(r.outwardTotals.igst) - net('igst')),
        cgst: money(dec(r.outwardTotals.cgst) - net('cgst')),
        sgst: money(dec(r.outwardTotals.sgst) - net('sgst')),
      },
      payableInCash: { igst: money(rcm.igst), cgst: money(rcm.cgst), sgst: money(rcm.sgst) },
    };
  }

  // --- e-invoice ---

  /** The IRP's JSON (schema 1.1) for a certified bill's invoice or a credit note; refused with what is missing. */
  async eInvoiceJson(claims: TenantClaims, kind: 'invoice' | 'credit_note', id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [d] = await db<
      {
        number: string | null;
        date: string | null;
        taxable: string;
        cgst: string;
        sgst: string;
        igst: string;
        total: string;
        rate: string;
        sac: string;
        pos: string | null;
        project: string;
        ra_no: number;
        original_no: string | null;
        original_date: string | null;
        entity_id: string;
        client_id: string | null;
      }[]
    >`${
      kind === 'invoice'
        ? db`
      SELECT b.invoice_no AS number, to_char(b.invoice_date, 'YYYY-MM-DD') AS date, b.certified ->> 'taxable' AS taxable,
        b.certified ->> 'cgst' AS cgst, b.certified ->> 'sgst' AS sgst, b.certified ->> 'igst' AS igst,
        b.certified ->> 'invoiceTotal' AS total, b.terms ->> 'gstPct' AS rate, coalesce(t.sac, '9954') AS sac,
        s.state_code AS pos, p.name AS project, b.ra_no, NULL AS original_no, NULL AS original_date, b.entity_id,
        p.client_id
      FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id JOIN proj.site s ON s.id = b.site_id
      LEFT JOIN acc.bill_terms t ON t.project_id = p.id WHERE b.id = ${id} AND b.status = 'certified'`
        : db`
      SELECT n.number, to_char(n.note_date, 'YYYY-MM-DD') AS date, n.taxable::text AS taxable, n.cgst::text AS cgst,
        n.sgst::text AS sgst, n.igst::text AS igst, n.total::text AS total, n.gst_pct::text AS rate,
        coalesce(t.sac, '9954') AS sac, s.state_code AS pos, p.name AS project, b.ra_no, b.invoice_no AS original_no,
        to_char(b.invoice_date, 'YYYY-MM-DD') AS original_date, n.entity_id, p.client_id
      FROM acc.credit_note n JOIN acc.client_bill b ON b.id = n.bill_id JOIN proj.project p ON p.id = b.project_id
      JOIN proj.site s ON s.id = b.site_id LEFT JOIN acc.bill_terms t ON t.project_id = p.id WHERE n.id = ${id}`
    }`;
    if (!d) throw new NotFoundException({ code: 'document_not_found' });
    const [seller] = await db<
      {
        gstin: string | null;
        name: string;
        legal_name: string;
        address: string;
        city: string;
        pincode: string | null;
        state_code: string | null;
      }[]
    >`SELECT gstin, name, legal_name, address, city, pincode, state_code FROM platform.entity WHERE id = ${d.entity_id}`;
    const [buyer] = d.client_id
      ? await db<
          {
            gstin: string | null;
            name: string;
            legal_name: string | null;
            address: string | null;
            city: string;
            pincode: string | null;
            state_code: string | null;
          }[]
        >`SELECT gstin, name, legal_name, address, city, pincode, state_code FROM platform.party WHERE id = ${d.client_id}`
      : [];
    const missing: string[] = [];
    if (!seller!.gstin) missing.push("the company's GSTIN");
    if (!seller!.address.trim()) missing.push("the company's address");
    if (seller!.city.trim().length < 3) missing.push("the company's city");
    if (!seller!.pincode) missing.push("the company's PIN code");
    if (!buyer) missing.push('the client');
    else {
      if (!buyer.gstin) missing.push("the client's GSTIN (e-invoices are for registered clients)");
      if (!buyer.address?.trim()) missing.push("the client's address");
      if (buyer.city.trim().length < 3) missing.push("the client's city");
      if (!buyer.pincode) missing.push("the client's PIN code");
    }
    if (!d.pos) missing.push("the site's state");
    if (missing.length)
      throw new BadRequestException({
        code: 'e_invoice_details_missing',
        message: `Add ${missing.join(', ')}.`,
      });
    const num = (v: string) => Number(v);
    const sellerState = seller!.state_code ?? seller!.gstin!.slice(0, 2);
    return {
      fileName: `${(d.number ?? 'document').replace(/[^A-Za-z0-9-]+/g, '-')}.json`,
      json: {
        Version: '1.1',
        TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
        DocDtls: { Typ: kind === 'invoice' ? 'INV' : 'CRN', No: d.number, Dt: slashDate(d.date!) },
        SellerDtls: {
          Gstin: seller!.gstin,
          LglNm: seller!.legal_name || seller!.name,
          Addr1: seller!.address.trim().slice(0, 100),
          Loc: seller!.city.trim().slice(0, 50),
          Pin: Number(seller!.pincode),
          Stcd: sellerState,
        },
        BuyerDtls: {
          Gstin: buyer!.gstin,
          LglNm: buyer!.legal_name || buyer!.name,
          Pos: d.pos,
          Addr1: buyer!.address!.trim().slice(0, 100),
          Loc: buyer!.city.trim().slice(0, 50),
          Pin: Number(buyer!.pincode),
          Stcd: buyer!.state_code ?? buyer!.gstin!.slice(0, 2),
        },
        ItemList: [
          {
            SlNo: '1',
            PrdDesc: `Works contract: ${d.project}, RA bill ${d.ra_no}`.slice(0, 300),
            IsServc: 'Y',
            HsnCd: d.sac,
            UnitPrice: num(d.taxable),
            TotAmt: num(d.taxable),
            AssAmt: num(d.taxable),
            GstRt: num(d.rate),
            IgstAmt: num(d.igst),
            CgstAmt: num(d.cgst),
            SgstAmt: num(d.sgst),
            TotItemVal: num(d.total),
          },
        ],
        ValDtls: {
          AssVal: num(d.taxable),
          CgstVal: num(d.cgst),
          SgstVal: num(d.sgst),
          IgstVal: num(d.igst),
          TotInvVal: num(d.total),
        },
        ...(d.original_no
          ? {
              RefDtls: {
                PrecDocDtls: [{ InvNo: d.original_no, InvDt: slashDate(d.original_date!) }],
              },
            }
          : {}),
      },
    };
  }

  /** What the IRP returned: the IRN, acknowledgement and signed QR, kept and printed on the document. */
  async recordIrn(
    claims: TenantClaims,
    kind: 'invoice' | 'credit_note',
    id: string,
    input: { irn: string; ackNo: string; ackDate: string; signedQr: string },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const [doc] =
      kind === 'invoice'
        ? await db`SELECT 1 FROM acc.client_bill WHERE id = ${id} AND status = 'certified'`
        : await db`SELECT 1 FROM acc.credit_note WHERE id = ${id}`;
    if (!doc) throw new NotFoundException({ code: 'document_not_found' });
    await db.begin(async (tx) => {
      await tx`DELETE FROM acc.e_invoice WHERE doc_kind = ${kind} AND doc_id = ${id}`;
      await tx`INSERT INTO acc.e_invoice (doc_kind, doc_id, irn, ack_no, ack_date, signed_qr, created_by)
        VALUES (${kind}, ${id}, ${input.irn.toLowerCase()}, ${input.ackNo}, ${input.ackDate}, ${input.signedQr},
          ${claims.sub})`;
      await audit(tx, claims.sub, 'e_invoice.record', kind, id, { irn: input.irn });
    });
    return this.irnOf(db, kind, id);
  }

  // --- GSTR-2B ---

  /** Reads the portal's GSTR-2B JSON: its B2B invoices, supplier by supplier. */
  static parse2b(raw: unknown) {
    const root = raw as { data?: { docdata?: unknown }; docdata?: unknown };
    const docdata = (root?.data?.docdata ?? root?.docdata) as
      | {
          b2b?: {
            ctin?: string;
            trdnm?: string;
            inv?: {
              inum?: string;
              dt?: string;
              val?: number;
              txval?: number;
              igst?: number;
              cgst?: number;
              sgst?: number;
              itcavl?: string;
              items?: { txval?: number; igst?: number; cgst?: number; sgst?: number }[];
            }[];
          }[];
        }
      | undefined;
    if (!docdata || !Array.isArray(docdata.b2b))
      throw new BadRequestException({
        code: 'not_2b',
        message: 'This is not a GSTR-2B file from the portal (no B2B section).',
      });
    const out: {
      ctin: string;
      tradeName: string;
      inum: string;
      idate: string;
      value: string;
      taxable: string;
      igst: string;
      cgst: string;
      sgst: string;
      itcAvailable: boolean;
    }[] = [];
    const n = (v: unknown) => fmt(dec(String(v ?? 0)), 2);
    for (const s of docdata.b2b)
      for (const i of s.inv ?? []) {
        const items = i.items ?? [];
        const pick = (k: 'txval' | 'igst' | 'cgst' | 'sgst') =>
          i[k] ?? items.reduce((a, x) => a + Number(x[k] ?? 0), 0);
        const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(i.dt ?? '');
        if (!s.ctin || !i.inum || !m)
          throw new BadRequestException({
            code: 'bad_2b_row',
            message: `An invoice of ${s.ctin ?? 'a supplier'} has no number or date.`,
          });
        out.push({
          ctin: s.ctin,
          tradeName: s.trdnm ?? '',
          inum: i.inum,
          idate: `${m[3]}-${m[2]}-${m[1]}`,
          value: n(i.val),
          taxable: n(pick('txval')),
          igst: n(pick('igst')),
          cgst: n(pick('cgst')),
          sgst: n(pick('sgst')),
          itcAvailable: i.itcavl !== 'N',
        });
      }
    return out;
  }

  async upload2b(
    claims: TenantClaims,
    input: { entityId: string; period: string; fileName: string; raw: unknown },
  ) {
    await this.may(claims, 'accounts.post');
    const lines = GstService.parse2b(input.raw);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`DELETE FROM acc.gstr2b WHERE entity_id = ${input.entityId} AND period = ${input.period}`;
      const [u] = await tx<{ id: string }[]>`
        INSERT INTO acc.gstr2b (entity_id, period, file_name, uploaded_by)
        VALUES (${input.entityId}, ${input.period}, ${input.fileName.slice(0, 200)}, ${claims.sub}) RETURNING id`;
      for (const [i, l] of lines.entries())
        await tx`INSERT INTO acc.gstr2b_line (upload_id, position, ctin, trade_name, inum, idate, value, taxable, igst,
            cgst, sgst, itc_available)
          VALUES (${u!.id}, ${i + 1}, ${l.ctin}, ${l.tradeName}, ${l.inum}, ${l.idate}, ${l.value}, ${l.taxable},
            ${l.igst}, ${l.cgst}, ${l.sgst}, ${l.itcAvailable})`;
      await audit(tx, claims.sub, 'gstr2b.upload', 'entity', input.entityId, {
        period: input.period,
        lines: lines.length,
      });
    });
    return this.reconcile(claims, { entityId: input.entityId, period: input.period });
  }

  /**
   * The month's 2B against the purchase book, by supplier GSTIN and bill number (letters and digits only): matched;
   * differs (taxable or tax off by more than ₹1); in 2B only; in the books only (bills of the month the supplier has
   * not filed: their input tax is at risk).
   */
  async reconcile(claims: TenantClaims, q: { entityId: string; period: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [u] = await db<{ id: string; fileName: string; uploadedAt: string }[]>`
      SELECT id, file_name AS "fileName", uploaded_at AS "uploadedAt" FROM acc.gstr2b
      WHERE entity_id = ${q.entityId} AND period = ${q.period}`;
    if (!u) return { ...q, upload: null, rows: [], counts: null };
    const lines = await db<
      {
        ctin: string;
        tradeName: string;
        inum: string;
        idate: string;
        taxable: string;
        tax: string;
        itcAvailable: boolean;
      }[]
    >`
      SELECT ctin, trade_name AS "tradeName", inum, to_char(idate, 'YYYY-MM-DD') AS idate, taxable::text AS taxable,
        (igst + cgst + sgst)::text AS tax, itc_available AS "itcAvailable"
      FROM acc.gstr2b_line WHERE upload_id = ${u.id} ORDER BY position`;
    const { from, to } = monthRange(q.period);
    const books = await db<
      {
        id: string;
        gstin: string;
        party: string;
        billNo: string;
        date: string;
        taxable: string;
        tax: string;
        inPeriod: boolean;
      }[]
    >`
      SELECT b.id, p.gstin, p.name AS party, b.bill_no AS "billNo", to_char(b.bill_date, 'YYYY-MM-DD') AS date,
        b.taxable::text AS taxable, (b.cgst + b.sgst + b.igst)::text AS tax,
        b.bill_date BETWEEN ${from} AND ${to} AS "inPeriod"
      FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id
      WHERE b.entity_id = ${q.entityId} AND b.status = 'posted' AND p.gstin IS NOT NULL
        AND b.source IS DISTINCT FROM 'retention_release'`;
    const key = (gstin: string, no: string) => `${gstin}|${normaliseNo(no)}`;
    const byKey = new Map(books.map((b) => [key(b.gstin, b.billNo), b]));
    const seen = new Set<string>();
    const rows: {
      status: 'matched' | 'differs' | 'in_2b_only' | 'in_books_only';
      gstin: string;
      party: string;
      number: string;
      date: string;
      taxable2b: string | null;
      tax2b: string | null;
      taxableBooks: string | null;
      taxBooks: string | null;
      billId: string | null;
      itcAvailable: boolean | null;
    }[] = [];
    const off = (a: string, b: string) => {
      const d = dec(a) - dec(b);
      return (d < 0n ? -d : d) > dec('1');
    };
    for (const l of lines) {
      const b = byKey.get(key(l.ctin, l.inum));
      if (b) seen.add(b.id);
      rows.push({
        status: !b
          ? 'in_2b_only'
          : off(l.taxable, b.taxable) || off(l.tax, b.tax)
            ? 'differs'
            : 'matched',
        gstin: l.ctin,
        party: b?.party ?? l.tradeName,
        number: l.inum,
        date: l.idate,
        taxable2b: l.taxable,
        tax2b: l.tax,
        taxableBooks: b?.taxable ?? null,
        taxBooks: b?.tax ?? null,
        billId: b?.id ?? null,
        itcAvailable: l.itcAvailable,
      });
    }
    for (const b of books.filter((x) => x.inPeriod && !seen.has(x.id)))
      rows.push({
        status: 'in_books_only',
        gstin: b.gstin,
        party: b.party,
        number: b.billNo,
        date: b.date,
        taxable2b: null,
        tax2b: null,
        taxableBooks: b.taxable,
        taxBooks: b.tax,
        billId: b.id,
        itcAvailable: null,
      });
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      ...q,
      upload: u,
      rows,
      counts: {
        matched: count('matched'),
        differs: count('differs'),
        in2bOnly: count('in_2b_only'),
        inBooksOnly: count('in_books_only'),
      },
    };
  }
}
