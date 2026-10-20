// TDS returns and certificates (docs/wave8-plan.md step 8b.3): suppliers' lower-deduction certificates, salary TDS
// deposited by challan for the 24Q, Form 16A for each supplier, and the 26Q and 24Q text files for the free File
// Validation Utility (FVU), through which every file goes before upload.
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  toast,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileText, Printer } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, saveFile } from '../../api/client';
import type { Party } from '../../api/types';
import { today, useChart } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';

interface Certificate {
  id: string;
  section: string;
  certNo: string;
  rate: string;
  limit: string;
  used: string;
  validFrom: string;
  validTo: string;
  party: { id: string; name: string; pan: string | null };
}

/** Lower-deduction certificates (section 197). */
export function Certificates({ entityId, mayPost }: { entityId: string; mayPost: boolean }) {
  const qc = useQueryClient();
  const key = ['tds-certificates', entityId];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Certificate[]>(`/api/tenant/accounts/tds/certificates?entityId=${entityId}`),
  });
  const parties = useQuery({
    queryKey: ['parties'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties'),
    enabled: mayPost,
  });
  const blank = {
    partyId: '',
    section: '194C',
    certNo: '',
    rate: '',
    limit: '',
    validFrom: today(),
    validTo: '',
  };
  const [form, setForm] = useState<typeof blank | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Certificate[]>('/api/tenant/accounts/tds/certificates', {
          method: 'POST',
          body: { entityId, ...form },
        }),
      );
      toast.success(`Certificate ${form!.certNo} saved`);
      setForm(null);
    } catch (err) {
      setError(describeError(err));
    }
  };
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) =>
    setForm({ ...form!, [k]: e.target.value });
  return (
    <Card
      title="Lower-deduction certificates (section 197)"
      actions={
        mayPost && !form ? (
          <Button type="button" variant="secondary" onClick={() => setForm(blank)}>
            Add a certificate
          </Button>
        ) : null
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {form && (
        <form
          onSubmit={(e) => void save(e)}
          className="mb-3 grid gap-3 md:grid-cols-4"
          aria-label="Lower-deduction certificate"
        >
          <Field label="Supplier">
            <Select value={form.partyId} onChange={set('partyId')} required>
              <option value="">Choose</option>
              {(parties.data ?? [])
                .filter((p) => p.isVendor || p.isSubcontractor)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Section">
            <Select value={form.section} onChange={set('section')}>
              {['194C', '194J', '194I', '194Q'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <Field label="Certificate no.">
            <Input value={form.certNo} onChange={set('certNo')} required maxLength={40} />
          </Field>
          <Field label="Rate %">
            <Input value={form.rate} onChange={set('rate')} inputMode="decimal" required />
          </Field>
          <Field label="Up to ₹">
            <Input value={form.limit} onChange={set('limit')} inputMode="decimal" required />
          </Field>
          <Field label="From">
            <Input type="date" value={form.validFrom} onChange={set('validFrom')} required />
          </Field>
          <Field label="To">
            <Input type="date" value={form.validTo} onChange={set('validTo')} required />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Save</Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : q.data.length === 0 ? (
        <EmptyState title="No supplier has a lower-deduction certificate.">
          Add a supplier&apos;s section 197 certificate to deduct at its lower rate.
        </EmptyState>
      ) : (
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Certificate</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Used of the limit</th>
              <th>Valid</th>
            </tr>
          </thead>
          <tbody aria-label="Certificates">
            {q.data.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.party.name} <span className="text-xs text-fg-muted">{c.party.pan}</span>
                </td>
                <td>
                  {c.certNo} <span className="text-xs text-fg-muted">{c.section}</span>
                </td>
                <td className="text-right">{Number(c.rate)}%</td>
                <td className="text-right tabular-nums">
                  {rupees(c.used)} of {rupees(c.limit)}
                </td>
                <td>
                  {shortDate(c.validFrom)} to {shortDate(c.validTo)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface Form24q {
  runs: {
    runId: string;
    month: string;
    tds: string;
    challan: { challanNo: string; depositedOn: string } | null;
  }[];
  deductees: {
    employeeId: string;
    code: string;
    name: string;
    pan: string | null;
    month: string;
    paid: string;
    tds: string;
  }[];
  total: string;
  problems: string[];
}

/** Salary TDS (section 192): each month's run, its challan, and the quarter's 24Q. */
export function SalaryTds({
  entityId,
  quarter,
  mayPost,
}: {
  entityId: string;
  quarter: string;
  mayPost: boolean;
}) {
  const qc = useQueryClient();
  const chart = useChart();
  const key = ['tds-24q', entityId, quarter];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Form24q>(`/api/tenant/accounts/tds/24q?entityId=${entityId}&quarter=${quarter}`),
  });
  const [form, setForm] = useState<{
    period: string;
    bsrCode: string;
    challanNo: string;
    depositedOn: string;
    interest: string;
    bankAccountId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const banks = (chart.data?.accounts ?? []).filter((a) => a.kind === 'bank' && !a.closed);
  const deposit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request('/api/tenant/accounts/tds/salary-challans', {
        method: 'POST',
        body: { entityId, ...form, interest: form!.interest || '0' },
      });
      toast.success('Salary TDS challan recorded');
      setForm(null);
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  if (!q.data.runs.length) return null;
  return (
    <Card title="Salary TDS (section 192) and the 24Q">
      {error && <Alert tone="danger">{error}</Alert>}
      {q.data.problems.map((p) => (
        <Alert key={p} tone="warning">
          {p}
        </Alert>
      ))}
      <Table minWidth="32rem">
        <thead>
          <tr>
            <th>Month</th>
            <th className="text-right">TDS</th>
            <th>Challan</th>
            <th />
          </tr>
        </thead>
        <tbody aria-label="Salary TDS">
          {q.data.runs.map((r) => (
            <tr key={r.runId}>
              <td>{r.month}</td>
              <td className="text-right tabular-nums">{rupees(r.tds)}</td>
              <td>
                {r.challan ? `${r.challan.challanNo} of ${shortDate(r.challan.depositedOn)}` : '—'}
              </td>
              <td className="text-right">
                {mayPost && !r.challan && Number(r.tds) > 0 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setForm({
                        period: r.month,
                        bsrCode: '',
                        challanNo: '',
                        depositedOn: today(),
                        interest: '',
                        bankAccountId: banks[0]?.id ?? '',
                      })
                    }
                  >
                    Enter the challan
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {form && (
        <form
          onSubmit={(e) => void deposit(e)}
          className="mt-3 grid gap-3 md:grid-cols-6"
          aria-label="Salary TDS challan"
        >
          <Field label="BSR code">
            <Input
              value={form.bsrCode}
              onChange={(e) => setForm({ ...form, bsrCode: e.target.value })}
              required
            />
          </Field>
          <Field label="Challan no.">
            <Input
              value={form.challanNo}
              onChange={(e) => setForm({ ...form, challanNo: e.target.value })}
              required
            />
          </Field>
          <Field label="Deposited on">
            <Input
              type="date"
              value={form.depositedOn}
              onChange={(e) => setForm({ ...form, depositedOn: e.target.value })}
              required
            />
          </Field>
          <Field label="Interest ₹">
            <Input
              value={form.interest}
              onChange={(e) => setForm({ ...form, interest: e.target.value })}
            />
          </Field>
          <Field label="From">
            <Select
              value={form.bankAccountId}
              onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}
            >
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Post</Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {q.data.deductees.length ? (
        <p className="mt-3 text-sm text-fg-muted">
          {new Set(q.data.deductees.map((d) => d.employeeId)).size} employee(s),{' '}
          {rupees(q.data.total)} deducted in the quarter.
        </p>
      ) : null}
    </Card>
  );
}

/** The quarter's returns as text for the FVU, and each supplier's Form 16A. */
export function ReturnFiles({ entityId, quarter }: { entityId: string; quarter: string }) {
  const [error, setError] = useState<string | null>(null);
  const q26 = useQuery({
    queryKey: ['tds-26q', entityId, quarter],
    queryFn: () =>
      api.request<{ deductees: { partyId: string; party: string }[] }>(
        `/api/tenant/accounts/tds/26q?entityId=${entityId}&quarter=${quarter}`,
      ),
  });
  const suppliers = [...new Map((q26.data?.deductees ?? []).map((d) => [d.partyId, d])).values()];
  const fvu = (form: '26Q' | '24Q') =>
    void api
      .download(`/api/tenant/accounts/tds/fvu?entityId=${entityId}&quarter=${quarter}&form=${form}`)
      .then(({ blob, fileName }) => saveFile(blob, fileName))
      .catch((err: unknown) => setError(describeError(err)));
  return (
    <Card
      title="Return files and certificates"
      actions={
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => fvu('26Q')}>
            <FileText className="size-4" aria-hidden /> 26Q text for the FVU
          </Button>
          <Button type="button" variant="secondary" onClick={() => fvu('24Q')}>
            <FileText className="size-4" aria-hidden /> 24Q text for the FVU
          </Button>
        </div>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm text-fg-muted">
        Run each file through the free File Validation Utility from the TIN-NSDL site before
        uploading; it is the judge of the format.
      </p>
      {suppliers.length ? (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Form 16A">
          {suppliers.map((s) => (
            <li key={s.partyId}>
              <Link
                to="/print/form-16a/$entityId/$quarter/$partyId"
                params={{ entityId, quarter, partyId: s.partyId }}
                target="_blank"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-sm hover:bg-bg-subtle"
              >
                <Printer className="size-3.5" aria-hidden /> Form 16A: {s.party}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
