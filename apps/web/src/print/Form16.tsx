// Form 16 Part B (Form 130 under the Income-tax Act, 2025) and Form 12BA (docs/wave8-plan.md step 8c.3): an
// employee's salary for the year, the deductions, the tax and the challans that deposited it. Part A comes from TRACES.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Particulars, PrintSheet, PrintTable } from './Letterhead';
import { formatInr } from './money';
import { Loading } from './PurchaseDocs';

interface Form16 {
  financialYear: string;
  employer: { name: string; tan: string | null; pan: string | null; address: string | null };
  employee: {
    code: string;
    name: string;
    pan: string | null;
    regime: string;
    grossSalary: string;
    standardDeduction: string;
    declaredDeductions: string;
    taxableIncome: string;
    tdsByQuarter: Record<string, string>;
    tds: string;
  };
  challans: {
    month: string;
    tds: string;
    bsrCode: string | null;
    challanNo: string | null;
    depositedOn: string | null;
  }[];
  perquisites: unknown[];
}
const right = 'text-right';

export function Form16Print({
  entityId,
  year,
  employeeId,
}: {
  entityId: string;
  year: string;
  employeeId: string;
}) {
  const q = useQuery({
    queryKey: ['form-16', entityId, year, employeeId],
    queryFn: () =>
      api.request<Form16>(
        `/api/tenant/payroll/form-16?entityId=${entityId}&year=${year}&employeeId=${employeeId}`,
      ),
  });
  if (!q.data) return <Loading q={q} />;
  const f = q.data;
  const e = f.employee;
  return (
    <PrintSheet
      entityId={entityId}
      title="Form 16, Part B: details of salary paid and tax deducted"
      meta={<div className="font-semibold">FY {f.financialYear}</div>}
    >
      <Particulars
        rows={[
          ['Employer', f.employer.name],
          ['TAN', f.employer.tan ?? 'not set'],
          ['Employee', `${e.code} ${e.name}`],
          ['PAN of the employee', e.pan ?? 'not given'],
          ['Tax regime', e.regime === 'old' ? 'Old regime' : 'New regime (section 115BAC)'],
        ]}
      />
      <PrintTable>
        <tbody>
          <tr>
            <td>1. Gross salary</td>
            <td className={right}>{formatInr(e.grossSalary)}</td>
          </tr>
          <tr>
            <td>2. Standard deduction</td>
            <td className={right}>{formatInr(e.standardDeduction)}</td>
          </tr>
          <tr>
            <td>3. Deductions declared (old regime)</td>
            <td className={right}>{formatInr(e.declaredDeductions)}</td>
          </tr>
          <tr className="font-semibold">
            <td>4. Total taxable income</td>
            <td className={right}>{formatInr(e.taxableIncome)}</td>
          </tr>
          <tr className="font-semibold">
            <td>5. Tax deducted at source</td>
            <td className={right}>{formatInr(e.tds)}</td>
          </tr>
        </tbody>
      </PrintTable>
      <h3 className="mt-4 text-sm font-semibold">Tax deducted and deposited</h3>
      <PrintTable>
        <thead>
          <tr>
            <th>Month</th>
            <th className={right}>Tax</th>
            <th>BSR code</th>
            <th>Deposited on</th>
            <th>Challan no.</th>
          </tr>
        </thead>
        <tbody>
          {f.challans.map((c) => (
            <tr key={c.month}>
              <td>{c.month}</td>
              <td className={right}>{formatInr(c.tds)}</td>
              <td>{c.bsrCode ?? '—'}</td>
              <td>{c.depositedOn ?? 'not deposited'}</td>
              <td>{c.challanNo ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </PrintTable>
      <h3 className="mt-4 text-sm font-semibold">
        Form 12BA: perquisites and profits in lieu of salary
      </h3>
      <p className="text-sm">
        {f.perquisites.length
          ? ''
          : 'No perquisites or profits in lieu of salary were provided in the year.'}
      </p>
    </PrintSheet>
  );
}
