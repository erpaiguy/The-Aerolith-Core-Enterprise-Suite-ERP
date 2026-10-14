// Printable document-control and HR papers (docs/wave7-plan.md step 7b.4): a transmittal's cover sheet, and an
// employee's letters (appointment, increment, relieving, experience) filled from their record and salary. The
// reference and date are typed on the desk before printing; a paragraph may be added.
import { Field, Input, Textarea } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { formatDate } from '../lib/format';
import { formatInr } from './money';
import type { Employee } from '../screens/hr/model';
import { shortDate } from '../schedule/model';
import { Particulars, PrintDesk, PrintSheet, PrintTable } from './Letterhead';
import { Loading, Signatures, useProjectEntity } from './PurchaseDocs';

interface TDetail {
  id: string;
  number: string;
  subject: string;
  recipient: string;
  purpose: string;
  status: string;
  issuedOn: string | null;
  dueOn: string | null;
  items: { id: string; name: string; versionNo: number; copies: number }[];
}

export function TransmittalPrint({
  projectId,
  transmittalId,
}: {
  projectId: string;
  transmittalId: string;
}) {
  const t = useQuery({
    queryKey: ['dms', 'transmittal', transmittalId],
    queryFn: () => api.request<TDetail>(`/api/tenant/transmittals/${transmittalId}`),
  });
  const entity = useProjectEntity(projectId);
  if (!t.data) return <Loading q={t} />;
  const x = t.data;
  return (
    <PrintSheet
      entityId={entity.data}
      title="Transmittal"
      meta={
        <>
          <div className="font-mono font-semibold">{x.number}</div>
          <div>{x.issuedOn ? shortDate(x.issuedOn) : 'Not yet issued'}</div>
        </>
      }
      receiver="Received by (name, sign, date)"
    >
      <Particulars
        rows={[
          ['To', x.recipient],
          ['Subject', x.subject],
          ['Sent for', x.purpose.replace(/_/g, ' ')],
          ['Reply by', x.dueOn ? shortDate(x.dueOn) : ''],
        ]}
      />
      <PrintTable>
        <thead>
          <tr>
            <th>#</th>
            <th>Document</th>
            <th>Version</th>
            <th className="text-right">Copies</th>
          </tr>
        </thead>
        <tbody>
          {x.items.map((d, k) => (
            <tr key={d.id}>
              <td>{k + 1}</td>
              <td>{d.name}</td>
              <td>{d.versionNo}</td>
              <td className="text-right">{d.copies || 'Soft copy'}</td>
            </tr>
          ))}
        </tbody>
      </PrintTable>
      <p className="text-sm">
        Please acknowledge receipt by signing and returning a copy of this sheet.
      </p>
    </PrintSheet>
  );
}

export const HR_LETTERS = {
  appointment: 'Letter of appointment',
  increment: 'Salary revision',
  relieving: 'Relieving letter',
  experience: 'Experience certificate',
} as const;
export type HrLetter = keyof typeof HR_LETTERS;

interface Salary {
  id: string;
  from: string;
  lines: { code: string; name: string; amount: string | null; percentOfBasic: string | null }[];
}

/** Each component's monthly amount: fixed, or a share of the basic. */
function monthly(s: Salary) {
  const basic = Number(s.lines.find((l) => l.code.toUpperCase() === 'BASIC')?.amount ?? 0);
  return s.lines.map((l) => ({
    name: l.name,
    amount: l.amount !== null ? Number(l.amount) : (Number(l.percentOfBasic ?? 0) * basic) / 100,
  }));
}

export function HrLetterPrint({ employeeId, kind }: { employeeId: string; kind: HrLetter }) {
  const emp = useQuery({
    queryKey: ['employee', employeeId],
    queryFn: () => api.request<Employee>(`/api/tenant/hr/employees/${employeeId}`),
  });
  const salary = useQuery({
    queryKey: ['salary', employeeId],
    queryFn: () => api.request<Salary[]>(`/api/tenant/payroll/employees/${employeeId}/salary`),
    enabled: kind === 'appointment' || kind === 'increment',
    retry: false,
  });
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [extra, setExtra] = useState('');
  if (!emp.data) return <Loading q={emp} />;
  const e = emp.data;
  // Salary records newest first or oldest first, whichever the server gives: order them.
  const salaries = [...(salary.data ?? [])].sort((a, b) => a.from.localeCompare(b.from));
  const first = salaries[0];
  const latest = salaries.at(-1);
  const before = salaries.at(-2);
  const role = [e.designation, e.department].filter(Boolean).join(', ');
  const till = e.leftOn ? formatDate(e.leftOn) : 'date';
  const body: Record<HrLetter, ReactNode> = {
    appointment: (
      <>
        <p>
          We are pleased to appoint you as{' '}
          <strong>{e.designation ?? 'a member of our staff'}</strong>
          {e.department ? ` in ${e.department}` : ''} with effect from{' '}
          <strong>{formatDate(e.joinedOn)}</strong>
          {e.grade ? `, in grade ${e.grade}` : ''}
          {e.manager ? `, reporting to ${e.manager}` : ''}.
        </p>
        {first ? <SalaryTable title="Your monthly salary" rows={monthly(first)} /> : null}
        <p>
          Your employee code is {e.code}. Please bring copies of your identity, address and
          educational documents on joining. The company's rules on attendance, leave and conduct
          apply to you as they stand from time to time.
        </p>
        <p>Please sign and return a copy of this letter as your acceptance.</p>
      </>
    ),
    increment: (
      <>
        <p>
          In appreciation of your work, your salary is revised with effect from{' '}
          <strong>{latest ? formatDate(latest.from) : '—'}</strong> as below.
        </p>
        {latest ? <Revision before={before} after={latest} /> : null}
        <p>All other terms of your employment remain the same. We wish you continued success.</p>
      </>
    ),
    relieving: (
      <>
        <p>
          With reference to your resignation, you are relieved from the services of the company at
          the close of business on <strong>{till}</strong>.
        </p>
        <p>
          You were working with us as {role || 'a member of our staff'} from{' '}
          {formatDate(e.joinedOn)}. Your full and final settlement is made separately. We wish you
          well.
        </p>
      </>
    ),
    experience: (
      <>
        <p className="text-center font-semibold uppercase">To whom it may concern</p>
        <p>
          This is to certify that <strong>{e.name}</strong> (employee code {e.code}) worked with us
          as {role || 'a member of our staff'} from <strong>{formatDate(e.joinedOn)}</strong> to{' '}
          <strong>{till}</strong>.
        </p>
        <p>During this time we found their work and conduct good. We wish them success.</p>
      </>
    ),
  };
  return (
    <PrintDesk>
      <form
        aria-label="Letter details"
        className="mx-auto mb-4 grid max-w-[210mm] gap-3 px-4 sm:grid-cols-[10rem_10rem_1fr] print:hidden"
        onSubmit={(ev) => ev.preventDefault()}
      >
        <Field label="Reference">
          <Input value={ref} onChange={(ev) => setRef(ev.target.value)} placeholder="HR/2026/014" />
        </Field>
        <Field label="Date">
          <Input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
        </Field>
        <Field label="Another paragraph (optional)">
          <Textarea rows={1} value={extra} onChange={(ev) => setExtra(ev.target.value)} />
        </Field>
        {(kind === 'relieving' || kind === 'experience') && !e.leftOn ? (
          <p className="text-sm text-warning sm:col-span-3">
            {e.name} has no leaving date on their record yet.
          </p>
        ) : null}
      </form>
      <PrintSheet
        bare
        entityId={e.entityId}
        title={HR_LETTERS[kind]}
        meta={
          <>
            {ref ? <div className="font-mono">{ref}</div> : null}
            <div>{date ? formatDate(date) : ''}</div>
          </>
        }
      >
        {kind !== 'experience' ? (
          <div className="text-sm">
            <div className="font-semibold">{e.name}</div>
            {e.address ? <div className="whitespace-pre-wrap">{e.address}</div> : null}
            <p className="mt-3">Dear {e.name.split(' ')[0]},</p>
          </div>
        ) : null}
        {body[kind]}
        {extra ? <p className="whitespace-pre-wrap">{extra}</p> : null}
        {kind === 'appointment' ? <Signatures names={['', `Accepted: ${e.name}`]} /> : null}
      </PrintSheet>
    </PrintDesk>
  );
}

function SalaryTable({ title, rows }: { title: string; rows: { name: string; amount: number }[] }) {
  const total = rows.reduce((n, r) => n + r.amount, 0);
  return (
    <section className="w-[70%] break-inside-avoid">
      <h2 className="mb-1 text-sm font-bold">{title}</h2>
      <PrintTable>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td className="text-right">{formatInr(String(r.amount))}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td>Gross per month</td>
            <td className="text-right">{formatInr(String(total))}</td>
          </tr>
        </tbody>
      </PrintTable>
    </section>
  );
}

function Revision({ before, after }: { before: Salary | undefined; after: Salary }) {
  const now = monthly(after);
  const was = new Map((before ? monthly(before) : []).map((r) => [r.name, r.amount]));
  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  return (
    <section className="w-[80%] break-inside-avoid">
      <PrintTable>
        <thead>
          <tr>
            <th>Per month</th>
            <th className="text-right">Before</th>
            <th className="text-right">From {shortDate(after.from)}</th>
          </tr>
        </thead>
        <tbody>
          {now.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td className="text-right">
                {was.has(r.name) ? formatInr(String(was.get(r.name))) : '—'}
              </td>
              <td className="text-right">{formatInr(String(r.amount))}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td>Gross</td>
            <td className="text-right">
              {before ? formatInr(String(sum([...was.values()]))) : '—'}
            </td>
            <td className="text-right">{formatInr(String(sum(now.map((r) => r.amount))))}</td>
          </tr>
        </tbody>
      </PrintTable>
    </section>
  );
}
