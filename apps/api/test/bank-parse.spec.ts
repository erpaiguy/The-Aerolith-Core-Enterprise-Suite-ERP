// Bank statements read (docs/wave3-plan.md step 7): a mapped CSV table with Indian figures, OFX, MT940, and the
// fingerprints that tell a repeated line from a line seen before.
import { describe, expect, it } from 'vitest';
import { MockBankAdapter } from '../src/accounts/bank-adapter.js';
import {
  fingerprints,
  parseCsv,
  parseMt940,
  parseOfx,
  readAmount,
  readDate,
  readTable,
} from '../src/accounts/bank-parse.js';

describe('bank statements', () => {
  it('reads amounts and dates as banks write them', () => {
    expect(
      ['1,00,000.00', '59', '(1,200.50)', '500.00 Dr', '75 CR', '-12', '', '-'].map(readAmount),
    ).toEqual(['100000.00', '59.00', '-1200.50', '-500.00', '75.00', '-12.00', null, null]);
    expect(readDate('05/09/2026', 'DD/MM/YYYY')).toBe('2026-09-05');
    expect(readDate('05-Sep-26', 'DD-MMM-YYYY')).toBe('2026-09-05');
    expect(readDate('09/05/2026', 'MM/DD/YYYY')).toBe('2026-09-05');
    expect(readDate('2026-09-05', 'DD/MM/YYYY')).toBe('2026-09-05');
    expect(readDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
  });

  it('reads a mapped CSV table, skipping the bank header and footer', () => {
    const rows = parseCsv(
      'State Bank of India,Statement of account\r\nAccount,123456\r\n\r\n' +
        'Txn Date,Description,Ref No,Debit,Credit,Balance\r\n' +
        '02/09/2026,"NEFT CR, UTR778899",UTR778899,,"1,00,000.00","1,00,000.00"\r\n' +
        '08/09/2026,CHQ PAID 000101,000101,"30,000.00",,"70,000.00"\r\n' +
        '** End of statement **,,,,,\r\n',
    );
    expect(
      readTable(rows, {
        date: 'Txn Date',
        narration: 'Description',
        reference: 'Ref No',
        withdrawal: 'Debit',
        deposit: 'Credit',
        amount: null,
        balance: 'Balance',
        dateFormat: 'DD/MM/YYYY',
      }),
    ).toEqual([
      {
        date: '2026-09-02',
        narration: 'NEFT CR, UTR778899',
        reference: 'UTR778899',
        amount: '100000.00',
        balance: '100000.00',
      },
      {
        date: '2026-09-08',
        narration: 'CHQ PAID 000101',
        reference: '000101',
        amount: '-30000.00',
        balance: '70000.00',
      },
    ]);
  });

  it('reads OFX and MT940', () => {
    const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260908120000<TRNAMT>-30000.00<FITID>F1<CHECKNUM>000101<NAME>CHQ PAID
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260930<TRNAMT>412.00<FITID>F2<NAME>INTEREST<MEMO>SB INT
</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(parseOfx(ofx)).toEqual([
      {
        date: '2026-09-08',
        narration: 'CHQ PAID',
        reference: '000101',
        amount: '-30000.00',
        balance: null,
      },
      {
        date: '2026-09-30',
        narration: 'INTEREST SB INT',
        reference: 'F2',
        amount: '412.00',
        balance: null,
      },
    ]);
    const mt = [
      ':20:STMT2609',
      ':25:SBIN0001234/123456',
      ':60F:C260901INR0,00',
      ':61:2609020902C100000,00NTRFUTR778899//SBI0001',
      ':86:NEFT CR SCRAP BUYER',
      'PUNE',
      ':61:2609300930D59,00NCHG//SBI0002',
      ':86:SMS CHARGES',
      ':62F:C260930INR99941,00',
    ].join('\r\n');
    expect(parseMt940(mt)).toEqual([
      {
        date: '2026-09-02',
        narration: 'NEFT CR SCRAP BUYER PUNE',
        reference: 'UTR778899',
        amount: '100000.00',
        balance: null,
      },
      {
        date: '2026-09-30',
        narration: 'SMS CHARGES',
        reference: 'SBI0002',
        amount: '-59.00',
        balance: '99941.00',
      },
    ]);
  });

  it('fingerprints repeats apart, and the same file the same way', async () => {
    const line = {
      date: '2026-09-30',
      narration: 'SMS CHARGES',
      reference: '',
      amount: '-59.00',
      balance: null,
    };
    const a = fingerprints([line, line]);
    expect(a[0]).not.toBe(a[1]);
    expect(fingerprints([line, line])).toEqual(a);
    expect(await new MockBankAdapter([line]).statement('x', '2026-09-01', '2026-09-30')).toEqual([
      line,
    ]);
  });
});
