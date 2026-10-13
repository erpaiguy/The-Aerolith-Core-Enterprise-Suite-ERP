// The books on screen (docs/wave3-plan.md step 1): types from the API, the company being worked on (kept per device),
// and amounts with Dr and Cr.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { formatAmount } from '../boq/model';
import { load, save } from '../lib/storage';
import { usePermission } from '../session/permissions';

export interface Company {
  id: string;
  name: string;
  legalName: string;
  gstin: string | null;
  pan: string | null;
  tan: string | null;
  stateCode: string | null;
  address: string;
  city: string;
  pincode: string | null;
  eInvoicing: boolean;
  booksFrom: string | null;
  isDefault: boolean;
  vouchers: number;
  rowVersion: number;
}
export interface Account {
  id: string;
  parentId: string | null;
  isGroup: boolean;
  nature: 'equity' | 'liability' | 'asset' | 'income' | 'expense';
  code: string;
  name: string;
  kind: 'ordinary' | 'bank' | 'cash' | 'party' | 'tax';
  partyId: string | null;
  partyName: string | null;
  needsProject: boolean;
  itcBlocked: boolean;
  systemKey: string | null;
  closed: boolean;
  hasEntries: boolean;
  rowVersion: number;
}
export type VoucherType =
  | 'journal'
  | 'payment'
  | 'receipt'
  | 'contra'
  | 'sales'
  | 'purchase'
  | 'debit_note'
  | 'credit_note'
  | 'opening';
export const VOUCHER_TYPE: Record<VoucherType, string> = {
  journal: 'Journal',
  payment: 'Payment',
  receipt: 'Receipt',
  contra: 'Contra',
  sales: 'Sales',
  purchase: 'Purchase',
  debit_note: 'Debit note',
  credit_note: 'Credit note',
  opening: 'Opening balances',
};
export const TYPED_IN: VoucherType[] = [
  'journal',
  'payment',
  'receipt',
  'contra',
  'sales',
  'purchase',
  'debit_note',
  'credit_note',
];
export const KIND: Record<Account['kind'], string> = {
  ordinary: 'Ledger',
  bank: 'Bank',
  cash: 'Cash',
  party: 'Party',
  tax: 'Tax',
};
export interface VoucherLine {
  position: number;
  account: { id: string; code: string; name: string };
  debit: string;
  credit: string;
  project: { id: string; number: string; name: string } | null;
  site: { id: string; name: string } | null;
  costCode: { id: string; code: string } | null;
  note: string;
}
export interface Voucher {
  id: string;
  entityId: string;
  company: string;
  type: VoucherType;
  number: string;
  date: string;
  narration: string;
  reference: string;
  total: string;
  sourceKind: string | null;
  reverses: { id: string; number: string } | null;
  reversedBy: { id: string; number: string } | null;
  createdBy: string | null;
  createdAt: string;
  lines: VoucherLine[];
  mayReverse: boolean;
}

/** An amount, or blank for nothing: for debit and credit columns. */
export const amt = (v: string | null | undefined) => (v && Number(v) !== 0 ? formatAmount(v) : '');
/** A balance with its side: "8,36,000.00 Dr". */
export const drcr = (v: string) => {
  const n = Number(v);
  if (n === 0) return '0.00';
  return `${formatAmount(String(Math.abs(n)))} ${n > 0 ? 'Dr' : 'Cr'}`;
};

/** April to March, as the API names it: "2026-27". */
export function fyOf(date: string) {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const start = m >= 4 ? y : y - 1;
  return {
    label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`,
    from: `${start}-04-01`,
    to: `${start + 1}-03-31`,
  };
}
export const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;

export const useCompanies = () =>
  useQuery({
    queryKey: ['companies'],
    queryFn: () => api.request<{ companies: Company[]; mayEdit: boolean }>('/api/tenant/companies'),
  });

const KEY = 'aerolith.accounts.company';

/** The company the books screens show, remembered on this device; the default company until one is chosen. */
export function useCompany() {
  const companies = useCompanies();
  const [chosen, setChosen] = useState<string | null>(() => load(KEY));
  const list = companies.data?.companies ?? [];
  const company =
    list.find((c) => c.id === chosen) ?? list.find((c) => c.isDefault) ?? list[0] ?? null;
  useEffect(() => {
    if (chosen && list.length && !list.some((c) => c.id === chosen)) setChosen(null);
  }, [chosen, list]);
  return {
    companies: list,
    company,
    loading: companies.isPending,
    error: companies.error,
    choose: (id: string) => {
      save(KEY, id);
      setChosen(id);
    },
  };
}

/**
 * The chart of accounts. Screens that only use it for an optional picker (a bill's deductions, a wage payment's bank)
 * pass `ifAllowed`, so people without the books permission are not sent a refusal; the books' own screens do not.
 */
export const useChart = (opts: { ifAllowed?: boolean } = {}) => {
  const may = usePermission('accounts.view');
  return useQuery({
    queryKey: ['chart'],
    queryFn: () =>
      api.request<{ accounts: Account[]; mayEdit: boolean }>('/api/tenant/accounts/chart'),
    enabled: !opts.ifAllowed || may,
  });
};

/** "A4002 HDFC Bank 0012", with the group path for the picker. */
export function ledgerOptions(accounts: Account[]) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const path = (a: Account) => {
    const parts: string[] = [];
    for (
      let p = a.parentId ? byId.get(a.parentId) : undefined;
      p?.parentId;
      p = p.parentId ? byId.get(p.parentId) : undefined
    )
      parts.unshift(p.name);
    return parts.join(' › ');
  };
  return accounts
    .filter((a) => !a.isGroup && !a.closed)
    .map((a) => ({ ...a, label: `${a.code} ${a.name}`, group: path(a) }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.code.localeCompare(b.code));
}
