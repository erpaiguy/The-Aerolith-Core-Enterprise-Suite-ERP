// The company as it was set up in its first days (January 2024): books, banks, capital, parties, the rate library,
// rate analyses, cost codes, HR and payroll masters, labour contractors. Sign-ins are made on the real clock first.
import { setClock } from './clock.js';
import { type Ctx, type H, as, on, step } from './ctx.js';
import {
  ANALYSES,
  COMPANY,
  HOLIDAYS,
  LABOUR_CONTRACTORS,
  PARTIES,
  RESOURCES,
  STAFF,
} from './plan.js';
import { type Day, addMonths, money, qty4 } from './util.js';

export const STAFF_PASSWORD = 'Site-Office-Demo-26';

/** Every staff member's sign-in (made now, on the real clock: their sessions outlive the replay). */
export async function makeUsers(c: Ctx, entitlement: string): Promise<void> {
  setClock(null);
  for (const p of STAFF) {
    const created = await c.s.post<{ id: string; temporaryPassword: string }>(
      '/tenant/users',
      { username: p.username, displayName: p.name, role: p.role },
      c.admin,
    );
    const login = (password: string) =>
      c.s.post<{ accessToken: string }>(
        '/auth/login',
        { entitlementToken: entitlement, identifier: p.username, password, client: 'desktop' },
        {},
      );
    const first = await login(created.temporaryPassword);
    await c.s.post(
      '/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: STAFF_PASSWORD },
      { authorization: `Bearer ${first.accessToken}` },
    );
    const again = await login(STAFF_PASSWORD);
    c.users[p.username] = {
      id: created.id,
      username: p.username,
      h: { authorization: `Bearer ${again.accessToken}` },
    };
  }
}

const rateOn = (base: number, kind: string) => (d: Day) => {
  // Materials rise about 1.5% a quarter, labour 2% each half-year, machines 1% a year, from December 2023.
  const months =
    (Number(d.slice(0, 4)) - 2023) * 12 + Number(d.slice(5, 7)) - 12;
  const steps =
    kind === 'material' ? Math.floor(months / 3) * 0.015 : kind === 'labour' ? Math.floor(months / 6) * 0.02 : Math.floor(months / 12) * 0.01;
  return Math.round(base * (1 + Math.max(0, steps)) * 100) / 100;
};

export async function setupCompany(c: Ctx): Promise<void> {
  on('2024-01-02');
  const company = (
    await c.s.get<{ companies: { id: string; rowVersion: number }[] }>('/tenant/companies', c.admin)
  ).companies[0]!;
  c.entityId = company.id;
  await c.s.post(
    `/tenant/companies/${company.id}`,
    {
      name: COMPANY.name,
      legalName: COMPANY.legalName,
      gstin: COMPANY.gstin,
      pan: COMPANY.pan,
      tan: COMPANY.tan,
      stateCode: COMPANY.stateCode,
      address: COMPANY.address,
      city: COMPANY.city,
      pincode: COMPANY.pincode,
      booksFrom: COMPANY.booksFrom,
      rowVersion: company.rowVersion,
    },
    c.admin,
  );

  // The chart: system ledgers by key, then the bank accounts.
  const chart = async () =>
    (
      await c.s.get<{ accounts: { id: string; code: string; systemKey: string | null }[] }>(
        '/tenant/accounts/chart',
        c.admin,
      )
    ).accounts;
  for (const a of await chart()) if (a.systemKey) c.acc[a.systemKey] = a.id;
  const bank = async (code: string, name: string) => {
    const list = await c.s.post<{ accounts: { id: string; code: string }[] }>(
      '/tenant/accounts/chart',
      { parentId: c.acc.cash_and_bank, code, name, kind: 'bank' },
      c.admin,
    );
    return list.accounts.find((a) => a.code === code)!.id;
  };
  c.bank = await bank('A4002', 'HDFC Bank current account 0012');
  c.acc.rera_collection = await bank('A4003', 'HDFC Bank collection account (Sai Residency) 0013');
  c.acc.rera_designated = await bank('A4004', 'HDFC Bank RERA designated account 0014');
  await c.s.put('/tenant/accounts/mode', { mode: 'native_tally' }, c.admin);
  // A cash-credit limit of ₹50 lakh with HDFC, against the receivables.
  const cc = await c.s.post<{ accounts: { id: string; code: string }[] }>(
    '/tenant/accounts/chart',
    { parentId: c.acc.short_term_borrowings, code: 'L2001', name: 'HDFC Bank cash credit (limit ₹50 lakh)', kind: 'ordinary' },
    c.admin,
  );
  c.acc.cash_credit = cc.accounts.find((a) => a.code === 'L2001')!.id;

  // ₹1 crore of share capital, paid in on 5 January 2024.
  on(COMPANY.capitalOn);
  await c.s.post(
    '/tenant/accounts/vouchers',
    {
      entityId: c.entityId,
      type: 'receipt',
      date: COMPANY.capitalOn,
      narration: 'Share capital subscribed by the promoters (1,00,000 equity shares of ₹100)',
      reference: 'Board resolution 1/2024',
      lines: [
        { accountId: c.bank, debit: money(COMPANY.capital) },
        { accountId: c.acc.capital_account, credit: money(COMPANY.capital) },
      ],
    },
    as(c, 'kavita'),
  );

  // Parties.
  for (const p of PARTIES) {
    const party = await c.s.post<{ id: string }>(
      '/tenant/parties',
      {
        name: p.name,
        isClient: p.kind === 'client',
        isVendor: p.kind === 'vendor' || p.kind === 'subcontractor',
        isSubcontractor: p.kind === 'subcontractor',
        isCompetitor: p.kind === 'competitor',
        gstin: p.gstin ?? null,
        pan: p.pan ?? null,
        email: p.email ?? null,
        city: p.city ?? '',
        stateCode: '27',
        tdsSection: p.tdsSection ?? null,
        bankAccountName: p.bank?.name ?? null,
        bankAccountNo: p.bank?.no ?? null,
        bankIfsc: p.bank?.ifsc ?? null,
      },
      as(c, 'priya'),
    );
    c.party[p.key] = party.id;
  }

  // Stores are valued at weighted average; cost codes from the standard list.
  await c.s.post('/tenant/stock/valuation', { method: 'average' }, c.admin);
  for (const cc of await c.s.post<{ id: string; code: string }[]>(
    '/tenant/cost-codes/standard',
    {},
    as(c, 'suresh'),
  ))
    c.costCodes[cc.code] = cc.id;
}

/** The rate library with its price history, and the rate analyses built on it. */
export async function setupRates(c: Ctx): Promise<void> {
  on('2024-01-03');
  for (const r of RESOURCES) {
    const rate = rateOn(r.rate, r.kind);
    const made = await c.s.post<{ id: string }>(
      '/tenant/resources',
      {
        code: r.code,
        name: r.name,
        kind: r.kind,
        unit: r.unit,
        rate: qty4(r.rate),
        effectiveFrom: '2023-12-01',
        source: 'Market survey, Washim and Akola',
      },
      as(c, 'priya'),
    );
    c.res[r.code] = { id: made.id, rate };
  }
  // Each later price is entered on the day it took effect (replayed on the calendar in history.ts).
  for (let d = '2024-03-01'; d <= c.today; d = addMonths(d, 3))
    c.sched.at(d, 5, 'rate revision', async () => {
      for (const r of RESOURCES) {
        const before = c.res[r.code]!.rate(addMonths(d, -3));
        const now = c.res[r.code]!.rate(d);
        if (now === before) continue;
        await c.s.post(
          `/tenant/resources/${c.res[r.code]!.id}/rates`,
          { effectiveFrom: d, rate: qty4(now), source: 'Quarterly market survey' },
          as(c, 'priya'),
        );
      }
    });
  for (const a of ANALYSES) {
    const made = await c.s.post<{ id: string }>(
      '/tenant/rate-analyses',
      {
        code: a.code,
        description: a.description,
        unit: a.unit,
        outputQty: qty4(a.outputQty),
        additions: [
          { label: 'Overheads', pct: '20' },
          { label: 'Profit', pct: '15' },
        ],
        lines: a.lines.map((l) =>
          l[0] === 'LS'
            ? { kind: 'lump_sum', description: l[2], amount: money(l[1]) }
            : { kind: 'resource', resourceId: c.res[l[0]]!.id, qty: String(l[1]), wastagePct: '0' },
        ),
        notes: 'Company practice: site and head-office overheads 20%, profit 15% on cost.',
      },
      as(c, 'priya'),
    );
    c.ana[a.code] = made.id;
  }
}

const TAX = (std: number, slabs: [number | null, number][], rebate: number) => ({
  slabs: slabs.map(([upTo, rate]) => ({ upTo, rate })),
  standardDeduction: std,
  rebateUpTo: rebate,
  marginalRelief: true,
  cess: 4,
});
const OLD_TAX = {
  slabs: [
    { upTo: 250000, rate: 0 },
    { upTo: 500000, rate: 5 },
    { upTo: 1000000, rate: 20 },
    { upTo: null, rate: 30 },
  ],
  standardDeduction: 50000,
  rebateUpTo: 500000,
  marginalRelief: false,
  cess: 4,
};

/** Designations, leave, calendars, payroll rules, labour contractors and minimum wages. */
export async function setupPeople(c: Ctx): Promise<Record<string, string>> {
  on('2024-01-02');
  const designations: Record<string, string> = {};
  const extra: Record<string, string[]> = {
    'HR and admin executive': ['hr.edit', 'payroll.run'],
  };
  for (const name of [...new Set(STAFF.map((p) => p.designation))]) {
    const d = await c.s.post<{ id: string }>(
      '/tenant/hr/designations',
      { name, permissions: extra[name] ?? [] },
      c.admin,
    );
    designations[name] = d.id;
  }
  for (const t of [
    { code: 'CL', name: 'Casual leave', paid: true, daysPerYear: '8', accrual: 'annual', carryForwardMax: '0' },
    { code: 'SL', name: 'Sick leave', paid: true, daysPerYear: '7', accrual: 'annual', carryForwardMax: '7' },
    { code: 'EL', name: 'Earned leave', paid: true, daysPerYear: '15', accrual: 'monthly', carryForwardMax: '30' },
    { code: 'LWP', name: 'Leave without pay', paid: false, daysPerYear: '0', accrual: 'annual', carryForwardMax: '0' },
  ])
    await c.s.post('/tenant/hr/leave-types', t, c.admin);
  await c.s.post(
    '/tenant/hr/calendars',
    { entityId: c.entityId, name: 'Office (Monday to Saturday)', workWeek: 63, isDefault: true },
    c.admin,
  );
  const cal = (
    await c.s.get<{ id: string; name: string }[]>(
      `/tenant/hr/calendars?entityId=${c.entityId}`,
      c.admin,
    )
  ).find((x) => x.name.startsWith('Office'))!;
  for (const [day, name] of HOLIDAYS)
    await c.s.put(`/tenant/hr/calendars/${cal.id}/holidays`, { day, name }, c.admin);

  // Salary tax before April 2025 (the install ships the rules from then on).
  await c.s.post(
    '/tenant/payroll/rules',
    {
      kind: 'income_tax',
      stateCode: null,
      effectiveFrom: '2023-04-01',
      data: {
        new: TAX(50000, [[300000, 0], [600000, 5], [900000, 10], [1200000, 15], [1500000, 20], [null, 30]], 700000),
        old: OLD_TAX,
      },
      note: 'Salary TDS for FY 2023-24 (new regime the default)',
    },
    c.admin,
  );
  await c.s.post(
    '/tenant/payroll/rules',
    {
      kind: 'income_tax',
      stateCode: null,
      effectiveFrom: '2024-04-01',
      data: {
        new: TAX(75000, [[300000, 0], [700000, 5], [1000000, 10], [1200000, 15], [1500000, 20], [null, 30]], 700000),
        old: OLD_TAX,
      },
      note: 'Salary TDS for FY 2024-25 (Finance (No. 2) Act, 2024)',
    },
    c.admin,
  );

  // Labour contractors, their licences, and the state's minimum wages.
  for (const [key, l] of Object.entries(LABOUR_CONTRACTORS))
    await c.s.put(
      `/tenant/labour/contractors/${c.party[key]}`,
      {
        licenceNo: l.licenceNo,
        licenceWorkers: Math.ceil(l.workers * 0.6),
        licenceValidTo: '2026-12-31',
        bocwRegistration: `BOCW/MH/${key.toUpperCase()}/2023`,
      },
      as(c, 'pooja'),
    );
  for (const [skill, daily] of [
    ['unskilled', '410'],
    ['semi_skilled', '440'],
    ['skilled', '475'],
    ['highly_skilled', '520'],
  ] as const)
    await step(c, 'minimum wage', () =>
      c.s.post(
        '/tenant/labour/min-wages',
        {
          stateCode: '27',
          skill,
          zone: 'Zone III',
          effectiveFrom: '2023-07-01',
          daily,
          note: 'Construction: Maharashtra minimum wages (zone III), with VDA',
        },
        as(c, 'pooja'),
      ),
    );
  return designations;
}

export type { H };
