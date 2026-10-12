// The ledger's fixed vocabulary (docs/wave3-plan.md step 1): voucher types and their numbering, the roles of the
// account map that later steps post to, and the database's own refusals turned into API errors.
import { BadRequestException, ConflictException } from '@nestjs/common';

export const VOUCHER_TYPES = {
  journal: { label: 'Journal', prefix: 'JV' },
  payment: { label: 'Payment', prefix: 'PV' },
  receipt: { label: 'Receipt', prefix: 'RV' },
  contra: { label: 'Contra', prefix: 'CV' },
  sales: { label: 'Sales', prefix: 'SV' },
  purchase: { label: 'Purchase', prefix: 'PU' },
  debit_note: { label: 'Debit note', prefix: 'DN' },
  credit_note: { label: 'Credit note', prefix: 'CN' },
  opening: { label: 'Opening balances', prefix: 'OB' },
} as const;
export type VoucherType = keyof typeof VOUCHER_TYPES;
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

/**
 * The account map's roles: what each later money step posts to, and the seeded ledger (by system key) a company starts
 * with. The admin maps a role to another ledger per company.
 */
export const ROLES = {
  sales_works_contract: { label: 'Sales: works contract', key: 'contract_revenue' },
  output_cgst: { label: 'Output CGST', key: 'output_cgst' },
  output_sgst: { label: 'Output SGST', key: 'output_sgst' },
  output_igst: { label: 'Output IGST', key: 'output_igst' },
  input_cgst: { label: 'Input CGST', key: 'input_cgst' },
  input_sgst: { label: 'Input SGST', key: 'input_sgst' },
  input_igst: { label: 'Input IGST', key: 'input_igst' },
  tds_receivable: { label: 'TDS deducted by clients', key: 'tds_receivable' },
  tds_payable_194c: { label: 'TDS payable, contractors (194C)', key: 'tds_payable_194c' },
  tds_payable_194j: { label: 'TDS payable, professionals (194J)', key: 'tds_payable_194j' },
  tds_payable_194i: { label: 'TDS payable, rent (194I)', key: 'tds_payable_194i' },
  tds_payable_194q: { label: 'TDS payable, purchase of goods (194Q)', key: 'tds_payable_194q' },
  tds_interest: { label: 'Interest and fees on TDS', key: 'tds_interest' },
  retention_receivable: { label: 'Retention held by clients', key: 'retention_receivable' },
  retention_payable: { label: 'Retention held from subcontractors', key: 'retention_payable' },
  mobilisation_advance_received: {
    label: 'Mobilisation advance received',
    key: 'mobilisation_advance_received',
  },
  advance_to_suppliers: { label: 'Advances to suppliers', key: 'advance_to_suppliers' },
  stock: { label: 'Stock of materials', key: 'stock' },
  grn_clearing: { label: 'Goods received, not invoiced', key: 'grn_clearing' },
  material_consumption: { label: 'Material consumption', key: 'material_consumption' },
  inventory_change: { label: 'Changes in inventories (closing stock)', key: 'inventory_change' },
  depreciation: { label: 'Depreciation', key: 'depreciation' },
  asset_sale_result: { label: 'Profit or loss on sale of assets', key: 'asset_sale_result' },
  equipment_charges: { label: 'Equipment charged to projects', key: 'equipment_charges' },
  equipment_recovery: { label: 'Equipment recovered', key: 'equipment_recovery' },
  equipment_hire: { label: 'Equipment hire', key: 'equipment_hire' },
  subcontract_cost: { label: 'Subcontract cost', key: 'subcontract_cost' },
  labour_cess_payable: { label: 'Labour cess payable', key: 'labour_cess_payable' },
  salaries: { label: 'Salaries and wages', key: 'salaries' },
  pf_esi_contribution: { label: "Employer's PF and ESI", key: 'pf_esi_contribution' },
  salaries_payable: { label: 'Salaries payable', key: 'salaries_payable' },
  pf_payable: { label: 'PF payable', key: 'pf_payable' },
  esi_payable: { label: 'ESI payable', key: 'esi_payable' },
  pt_payable: { label: 'Professional tax payable', key: 'pt_payable' },
  lwf_payable: { label: 'Labour welfare fund payable', key: 'lwf_payable' },
  tds_payable_salary: { label: 'TDS payable, salaries', key: 'tds_payable_salary' },
  staff_advances: { label: 'Staff advances', key: 'staff_advances' },
  buyer_advances: { label: 'Advances from flat buyers', key: 'advances_from_buyers' },
  interest_income: { label: 'Interest income', key: 'interest_income' },
  round_off: { label: 'Round off', key: 'round_off' },
  profit_and_loss: { label: 'Profit and loss account', key: 'profit_and_loss' },
} as const;
export type Role = keyof typeof ROLES;
export const isRole = (r: string): r is Role => r in ROLES;

/** Where a party's ledger is opened: under debtors for clients, creditors for everyone else. */
export const partyGroupKey = (isClient: boolean) =>
  isClient ? 'sundry_debtors' : 'sundry_creditors';

/** The first of the month a date falls in. */
export const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

/** April to March: "2026-27" for any date from 1 April 2026 to 31 March 2027. */
export function fyOf(date: string) {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const start = m >= 4 ? y : y - 1;
  return {
    label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`,
    from: `${start}-04-01`,
    to: `${start + 1}-03-31`,
  };
}

const DB_REFUSALS: Record<string, (m: string) => Error> = {
  period_locked: (m) => new ConflictException({ code: 'period_locked', message: m }),
  not_a_ledger: (m) => new BadRequestException({ code: 'not_a_ledger', message: m }),
  ledger_closed: (m) => new BadRequestException({ code: 'ledger_closed', message: m }),
  project_needed: (m) => new BadRequestException({ code: 'project_needed', message: m }),
  unbalanced: () =>
    new BadRequestException({
      code: 'unbalanced',
      message: 'The debits and credits must be equal.',
    }),
};

/** The ledger's own triggers raise "code: message"; anything else is rethrown as it is. */
export function fromDb(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'P0001' && e.message) {
    const [code, ...rest] = e.message.split(': ');
    const make = DB_REFUSALS[code!];
    if (make) throw make(rest.join(': ') || e.message);
  }
  throw err;
}
