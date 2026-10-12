// Bank statements read (docs/wave3-plan.md step 7): a table (CSV or Excel) by the bank ledger's saved mapping, OFX and
// MT940. Pure: each gives lines of date, narration, reference, a signed amount (deposits positive) and the balance.
import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { dec, fmt } from '../rates/decimal.js';

export interface StatementLine {
  date: string;
  narration: string;
  reference: string;
  amount: string;
  balance: string | null;
}
export interface Mapping {
  date: string;
  narration: string;
  reference: string | null;
  /** Either withdrawal and deposit columns, or one signed amount column. */
  withdrawal: string | null;
  deposit: string | null;
  amount: string | null;
  balance: string | null;
  dateFormat: 'DD/MM/YYYY' | 'DD-MM-YYYY' | 'DD-MMM-YYYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY';
}

const bad = (message: string) => new BadRequestException({ code: 'bad_statement', message });
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const iso = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
};
const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

export function readDate(v: string, format: Mapping['dateFormat']): string | null {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s))
    return iso(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)));
  const p = s.split(/[/\-. ]+/);
  if (p.length < 3) return null;
  if (format === 'DD-MMM-YYYY') {
    const m = MONTHS.indexOf(p[1]!.slice(0, 3).toUpperCase()) + 1;
    return m ? iso(year(p[2]!), m, Number(p[0])) : null;
  }
  if (format === 'MM/DD/YYYY') return iso(year(p[2]!), Number(p[0]), Number(p[1]));
  if (format === 'YYYY-MM-DD') return iso(Number(p[0]), Number(p[1]), Number(p[2]));
  return iso(year(p[2]!), Number(p[1]), Number(p[0]));
}

/** An amount as banks write it: commas, "Cr"/"Dr" suffixes, brackets for negatives. */
export function readAmount(v: string): string | null {
  let s = v
    .trim()
    .replace(/,/g, '')
    .replace(/^₹|^INR/i, '')
    .trim();
  if (!s || s === '-') return null;
  let sign = 1n;
  if (/^\(.*\)$/.test(s)) [s, sign] = [s.slice(1, -1), -1n];
  const m = /^(-)?(\d+(\.\d+)?)\s*(CR|DR)?$/i.exec(s);
  if (!m) return null;
  if (m[1] || m[4]?.toUpperCase() === 'DR') sign = -sign;
  return fmt(sign * dec(m[2]!), 2);
}

/** A minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') [cell, i] = [cell + '"', i + 1];
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') [row, cell] = [[...row, cell], ''];
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      rows.push([...row, cell]);
      [row, cell] = [[], ''];
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** A table of rows: the header row is the first holding the mapping's date and narration headings. */
export function readTable(rows: string[][], m: Mapping): StatementLine[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const h = rows.findIndex(
    (r) => r.some((c) => norm(c) === norm(m.date)) && r.some((c) => norm(c) === norm(m.narration)),
  );
  if (h < 0) throw bad(`No header row with "${m.date}" and "${m.narration}".`);
  const col = (name: string | null) => {
    if (!name) return -1;
    const i = rows[h]!.findIndex((c) => norm(c) === norm(name));
    if (i < 0) throw bad(`No column "${name}".`);
    return i;
  };
  const d = col(m.date);
  const n = col(m.narration);
  const r = col(m.reference);
  const w = col(m.withdrawal);
  const dep = col(m.deposit);
  const a = col(m.amount);
  const b = col(m.balance);
  if (a < 0 && (w < 0 || dep < 0))
    throw bad('Map either withdrawal and deposit columns, or one amount column.');
  const out: StatementLine[] = [];
  for (const [i, row] of rows.slice(h + 1).entries()) {
    const cell = (k: number) => (k < 0 ? '' : (row[k] ?? '').trim());
    if (!cell(d)) continue;
    const date = readDate(cell(d), m.dateFormat);
    if (!date) {
      // Footers ("Closing balance", "*** End of statement") end the table.
      if (out.length) break;
      throw bad(`Row ${h + i + 2}: "${cell(d)}" is not a ${m.dateFormat} date.`);
    }
    let amount: string | null;
    if (a >= 0) amount = readAmount(cell(a));
    else {
      const out_ = readAmount(cell(w));
      const in_ = readAmount(cell(dep));
      amount =
        in_ && dec(in_) !== 0n
          ? in_
          : out_ && dec(out_) !== 0n
            ? fmt(-(dec(out_) < 0n ? -dec(out_) : dec(out_)), 2)
            : null;
    }
    if (!amount || dec(amount) === 0n) continue;
    out.push({
      date,
      narration: cell(n).slice(0, 1000),
      reference: cell(r).slice(0, 200),
      amount,
      balance: b >= 0 ? readAmount(cell(b)) : null,
    });
  }
  return out;
}

/** OFX (SGML or XML): each STMTTRN's posted date, amount, FITID or cheque number, name and memo. */
export function parseOfx(text: string): StatementLine[] {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (!blocks.length) throw bad('No transactions in the OFX file.');
  const tag = (b: string, t: string) =>
    new RegExp(`<${t}>([^<\\r\\n]*)`, 'i').exec(b)?.[1]?.trim() ?? '';
  return blocks.map((b) => {
    const dt = tag(b, 'DTPOSTED');
    const date = iso(Number(dt.slice(0, 4)), Number(dt.slice(4, 6)), Number(dt.slice(6, 8)));
    const amount = readAmount(tag(b, 'TRNAMT'));
    if (!date || !amount) throw bad('An OFX transaction has no date or amount.');
    return {
      date,
      narration: [tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).join(' ').slice(0, 1000),
      reference: (tag(b, 'CHECKNUM') || tag(b, 'REFNUM') || tag(b, 'FITID')).slice(0, 200),
      amount,
      balance: null,
    };
  });
}

/** MT940: each :61: line (value date, credit or debit, amount, reference) with the :86: narration after it. */
export function parseMt940(text: string): StatementLine[] {
  const out: StatementLine[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let last: StatementLine | null = null;
  let inNarr = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith(':61:')) {
      const m =
        /^:61:(\d{2})(\d{2})(\d{2})(\d{4})?(R?[CD])[A-Z]?([\d,]+)N?[A-Z0-9]{0,3}([^/]*)(\/\/(.*))?$/.exec(
          line,
        );
      if (!m) throw bad(`Cannot read "${line}".`);
      const date = iso(2000 + Number(m[1]), Number(m[2]), Number(m[3]));
      if (!date) throw bad(`Cannot read the date in "${line}".`);
      const value = dec(m[6]!.replace(',', '.').replace(/\.$/, ''));
      const debit = m[5] === 'D' || m[5] === 'RC';
      last = {
        date,
        narration: '',
        reference: (m[7]!.trim() || m[9]?.trim() || '').slice(0, 200),
        amount: fmt(debit ? -value : value, 2),
        balance: null,
      };
      out.push(last);
      inNarr = false;
    } else if (line.startsWith(':86:') && last) {
      last.narration = line.slice(4).trim();
      inNarr = true;
    } else if (/^:62[FM]:/.test(line) && last) {
      const m = /^:62[FM]:([CD])\d{6}[A-Z]{3}([\d,]+)/.exec(line);
      if (m)
        last.balance = fmt(
          (m[1] === 'D' ? -1n : 1n) * dec(m[2]!.replace(',', '.').replace(/\.$/, '')),
          2,
        );
      inNarr = false;
    } else if (line.startsWith(':')) inNarr = false;
    else if (inNarr && last) last.narration = `${last.narration} ${line.trim()}`.slice(0, 1000);
  }
  if (!out.length) throw bad('No :61: transactions in the MT940 file.');
  return out;
}

/** A line's fingerprint: the same line in the same file always gives the same one (repeats counted). */
export function fingerprints(lines: StatementLine[]) {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = [
      l.date,
      l.amount,
      l.reference,
      l.narration.replace(/\s+/g, ' '),
      l.balance ?? '',
    ].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash('sha256').update(`${base}|${n}`).digest('hex');
  });
}
