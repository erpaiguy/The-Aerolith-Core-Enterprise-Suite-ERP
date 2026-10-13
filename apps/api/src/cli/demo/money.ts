// The accounts office's calendar: rent, the CA, power and diesel for each site, petty cash, bank charges; GST set off
// and paid by the 20th, TDS deposited by the 7th, labour cess each quarter; suppliers paid on the 10th and 25th;
// machine costing and depreciation; and each financial year closed in May once its books are complete.
import { type Ctx, as, bump, step } from './ctx.js';
import { balance } from './people.js';
import { paySuppliers } from './site.js';
import { RESOURCES } from './plan.js';
import { type Day, addDays, addMonths, fyOf, lastOfMonth, minDay, money } from './util.js';

const kavita = (c: Ctx, d: Day) => as(c, d >= '2024-01-16' ? 'kavita' : 'suresh');

async function voucher(c: Ctx, d: Day, type: string, narration: string, lines: Record<string, unknown>[], reference = '') {
  await c.s.post('/tenant/accounts/vouchers', { entityId: c.entityId, type, date: d, narration, reference, lines }, kavita(c, d));
  bump(c, 'vouchers typed');
}

async function bill(c: Ctx, d: Day, party: string, billNo: string, lines: { account: string; projectId?: string | null; description: string; amount: number; gst: number }[], tds: string | null = null, narration = '') {
  await c.s.post(
    '/tenant/accounts/vendor-bills',
    {
      entityId: c.entityId,
      partyId: c.party[party],
      orderId: null,
      projectId: lines[0]?.projectId ?? null,
      billNo,
      billDate: d,
      dueDate: addDays(d, party === 'power' ? 10 : 15),
      tdsSection: tds,
      narration,
      lines: lines.map((l) => ({ lineKey: null, accountId: c.acc[l.account], projectId: l.projectId ?? null, description: l.description, unit: null, qty: '1', rate: money(l.amount), gstPct: String(l.gst) })),
    },
    kavita(c, d),
  );
  bump(c, 'expense bills');
}

/** Ignores the "nothing to do" answers of routine month-end work. */
async function quietly(c: Ctx, label: string, f: () => Promise<unknown>) {
  try {
    await f();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/nothing_to_deposit|nothing_to_charge|nothing_to_close|month_costed|no_machines|nothing/.test(m)) return;
    await step(c, label, () => Promise.reject(err));
  }
}

export function scheduleMoney(c: Ctx) {
  const live = (d: Day) => Object.values(c.projects).filter((ps) => ps.status === 'active' && d >= ps.plan.start && d <= ps.end);
  for (let m = '2024-01-01'; m <= c.today; m = addMonths(m, 1)) {
    const month = m.slice(0, 7);
    const end = lastOfMonth(m);
    const at = (day: number, order: number, label: string, f: (d: Day) => Promise<unknown>) => {
      const d = `${month}-${String(day).padStart(2, '0')}` as Day;
      if (d <= c.today) c.sched.at(d, order, label, () => f(d));
    };
    // Rent of the Washim office (from February 2024), with GST and TDS 194-I.
    if (m >= '2024-02-01')
      at(1, 50, 'rent', (d) => bill(c, d, 'landlord', `DP/RENT/${month}`, [{ account: 'rent', description: `Office rent for ${month}`, amount: 25000, gst: 18 }], '194I', 'Office rent, Washim'));
    // Petty cash for the sites, and site expenses paid from it.
    at(2, 50, 'petty cash', async (d) => {
      const sites = live(d);
      if (!sites.length) return;
      const amount = 10000 * sites.length;
      await voucher(c, d, 'contra', 'Cash withdrawn for site petty cash', [
        { accountId: c.acc.cash, debit: money(amount) },
        { accountId: c.bank, credit: money(amount) },
      ], `CHQ ${c.r.int(100000, 999999)}`);
      for (const ps of sites)
        await voucher(c, minDay(addDays(d, c.r.int(3, 20)), minDay(end, c.today)), 'payment', `Site expenses: water tanker, local transport, tea, small tools (${ps.plan.site})`, [
          { accountId: c.acc.site_overheads, debit: money(c.r.int(6000, 9800)), projectId: ps.id },
          { accountId: c.acc.cash, credit: money(0) },
        ].map((l, i, all) => (i === 1 ? { ...l, credit: (all[0] as { debit: string }).debit } : l)));
    });
    at(5, 50, 'office expenses', (d) =>
      voucher(c, d, 'payment', 'Office expenses: internet, phones, stationery, housekeeping', [
        { accountId: c.acc.office_expenses, debit: money(c.r.int(9000, 16000)) },
        { accountId: c.bank, credit: '0' },
      ].map((l, i, all) => (i === 1 ? { ...l, credit: (all[0] as { debit: string }).debit } : l)), `NEFT/${month}`),
    );
    // Power and diesel for each live site.
    at(8, 50, 'site power and diesel', async (d) => {
      for (const ps of Object.values(c.projects).filter((x) => x.status !== 'planned' && x.plan.start <= addDays(m, -1) && x.end >= addDays(m, -25))) {
        await step(c, 'power bill', () => bill(c, d, 'power', `MSEDCL/${ps.plan.key.toUpperCase()}/${month}`, [{ account: 'power_and_water', projectId: ps.id, description: `Temporary power connection, ${ps.plan.site}`, amount: c.r.int(5500, 14000), gst: 0 }]));
        await step(c, 'diesel bill', () => bill(c, d, 'fuel', `JHF/${month}/${ps.plan.key.toUpperCase()}`, [{ account: 'fuel', projectId: ps.id, description: `HSD for machines and DG set, ${ps.plan.site}`, amount: c.r.int(14000, 34000), gst: 0 }]));
      }
    });
    at(28, 50, 'bank charges', (d) =>
      voucher(c, d, 'payment', 'Bank charges: NEFT/RTGS, cheque book, SMS', [
        { accountId: c.acc.bank_charges, debit: money(c.r.int(350, 1200)) },
        { accountId: c.bank, credit: '0' },
      ].map((l, i, all) => (i === 1 ? { ...l, credit: (all[0] as { debit: string }).debit } : l))),
    );
    // The auditor every quarter.
    if (['03', '06', '09', '12'].includes(month.slice(5)))
      at(15, 50, 'CA fees', (d) => bill(c, d, 'ca', `JA/${month}/${c.r.int(10, 99)}`, [{ account: 'professional_fees', description: `Accounting, GST and TDS compliance, quarter to ${month}`, amount: 30000, gst: 18 }], '194J'));
    // The bank's cash-credit limit carries the working capital: drawn when the account runs low, repaid when flush.
    for (const day of [9, 24])
      at(day, 54, 'cash credit', async (d) => {
        const bank = await balance(c, c.bank, d);
        const drawn = -(await balance(c, c.acc.cash_credit!, d));
        if (bank < 1_500_000 && drawn < 5_000_000) {
          const amount = Math.min(5_000_000 - drawn, Math.ceil((1_500_000 - bank) / 500_000) * 500_000);
          await voucher(c, d, 'receipt', 'Drawn from the HDFC cash-credit limit', [
            { accountId: c.bank, debit: money(amount) },
            { accountId: c.acc.cash_credit, credit: money(amount) },
          ], 'CC/HDFC');
        } else if (bank > 4_000_000 && drawn > 0) {
          const amount = Math.min(drawn, Math.floor((bank - 2_500_000) / 500_000) * 500_000);
          if (amount > 0)
            await voucher(c, d, 'payment', 'Repaid to the HDFC cash-credit account', [
              { accountId: c.acc.cash_credit, debit: money(amount) },
              { accountId: c.bank, credit: money(amount) },
            ], 'CC/HDFC');
        }
      });
    at(28, 51, 'cash credit interest', async (d) => {
      const drawn = -(await balance(c, c.acc.cash_credit!, d));
      if (drawn > 1000)
        await voucher(c, d, 'payment', `Interest on cash credit for ${month} at 10.5%`, [
          { accountId: c.acc.interest_expense, debit: money((drawn * 0.105) / 12) },
          { accountId: c.bank, credit: money((drawn * 0.105) / 12) },
        ], 'CC/HDFC/INT');
    });
    // Suppliers and subcontractors paid twice a month.
    at(10, 55, 'pay suppliers', (d) => paySuppliers(c, d));
    at(25, 55, 'pay suppliers', (d) => paySuppliers(c, d));
    // The previous month's taxes.
    const prev = addMonths(m, -1).slice(0, 7);
    const prevEnd = lastOfMonth(addMonths(m, -1));
    if (m > '2024-01-01') {
      at(3, 52, 'machine costing', () => quietly(c, 'machine costing', () => c.s.post('/tenant/equipment/costing', { entityId: c.entityId, month: prev }, c.admin)));
      at(7, 52, 'TDS challans', async (d) => {
        for (const section of ['194C', '194J', '194I'])
          await quietly(c, 'TDS challan', () =>
            c.s.post('/tenant/accounts/tds/challans', { entityId: c.entityId, section, period: prev, depositedOn: d, bsrCode: '0510308', challanNo: String(c.r.int(10000, 99999)), interest: '0', fee: '0', bankAccountId: c.bank, billIds: null }, kavita(c, d)),
          );
      });
      at(20, 52, 'GST', (d) => gst(c, d, prevEnd, prev));
    }
    // Labour cess each quarter, and depreciation to the quarter end.
    if (['01', '04', '07', '10'].includes(month.slice(5)) && m > '2024-01-01') {
      at(12, 52, 'labour cess', async (d) => {
        for (const ps of Object.values(c.projects)) {
          const l = await c.s.get<{ closing: string }>(`/tenant/accounts/ledgers/${c.acc.labour_cess_payable}?entityId=${c.entityId}&from=${prevEnd}&to=${prevEnd}&projectId=${ps.id}`, c.admin);
          const owed = -Number(l.closing);
          if (owed > 1)
            await step(c, 'labour cess', () =>
              c.s.post(`/tenant/labour/projects/${ps.id}/cess`, { paidOn: d, amount: money(owed), reference: `BOCW/${ps.plan.key.toUpperCase()}/${prev}`, bankAccountId: c.bank }, kavita(c, d)),
            );
        }
      });
      at(6, 53, 'depreciation', () => quietly(c, 'depreciation', () => c.s.post('/tenant/accounts/depreciation-runs', { entityId: c.entityId, upto: prevEnd }, c.admin)));
    }
    // Close the financial year that ended in March, once May is over.
    if (month.slice(5) === '05') {
      const fy = fyOf(addMonths(m, -3));
      at(31, 95, `close ${fy}`, async () => {
        const stock = Object.values(c.projects).reduce(
          (s, ps) => s + Object.entries(ps.stock).reduce((v, [code, q]) => v + Math.max(0, q) * (RESOURCES.find((r) => r.code === code)?.rate ?? 0), 0),
          0,
        );
        await c.s.post('/tenant/accounts/year-end', { entityId: c.entityId, fy, closingStock: money(Math.round(stock)) }, c.admin);
        bump(c, 'years closed');
      });
    }
  }
}

/** GST for a month: input tax set off against output tax, the rest paid; unused credit carried forward. */
async function gst(c: Ctx, d: Day, asOf: Day, month: string) {
  const lines: Record<string, unknown>[] = [];
  const pay: Record<string, unknown>[] = [];
  let cash = 0;
  for (const [out, inp] of [
    ['output_cgst', 'input_cgst'],
    ['output_sgst', 'input_sgst'],
  ] as const) {
    const owed = -(await balance(c, c.acc[out]!, asOf));
    const credit = await balance(c, c.acc[inp]!, asOf);
    const setoff = Math.max(0, Math.min(owed, credit));
    if (setoff > 0.5)
      lines.push({ accountId: c.acc[out], debit: money(setoff) }, { accountId: c.acc[inp], credit: money(setoff) });
    const rest = owed - setoff;
    if (rest > 0.5) {
      pay.push({ accountId: c.acc[out], debit: money(rest) });
      cash += rest;
    }
  }
  if (lines.length) await voucher(c, asOf, 'journal', `GST input tax credit set off for ${month} (GSTR-3B)`, lines, `GSTR3B/${month}`);
  if (cash > 0.5)
    await voucher(c, d, 'payment', `GST paid for ${month} (GSTR-3B)`, [...pay, { accountId: c.bank, credit: money(cash) }], `CPIN ${c.r.int(10, 99)}${month.replace('-', '')}${c.r.int(100000, 999999)}`);
}
