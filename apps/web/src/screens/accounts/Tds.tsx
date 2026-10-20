// TDS deposited and returned (docs/wave3-plan.md step 6b): a quarter's deductions from suppliers' bills, the challans
// that deposit them, the 26Q data for the return utility, and what clients deducted matched against 26AS.
import {
  Alert,
  Badge,
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
import { FileSpreadsheet, Upload } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { api, saveFile } from '../../api/client';
import { today, useChart } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { usePermission } from '../../session/permissions';
import { Books } from './Vouchers';
import { Certificates, ReturnFiles, SalaryTds } from './TdsReturns';

/** The financial-year quarter a date falls in: "2026-27-Q2". */
export const quarterOf = (d: string) => {
  const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
  const start = m >= 4 ? y : y - 1;
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}-Q${q}`;
};
const QUARTER_MONTHS = [
  'April to June',
  'July to September',
  'October to December',
  'January to March',
];
const quarterRange = (quarter: string) => {
  const y = Number(quarter.slice(0, 4));
  const q = Number(quarter.slice(-1));
  if (q === 4) return { from: `${y + 1}-01-01`, to: `${y + 1}-03-31` };
  const m1 = q * 3 + 1;
  const last = new Date(Date.UTC(y, m1 + 2, 0)).getUTCDate();
  return {
    from: `${y}-${String(m1).padStart(2, '0')}-01`,
    to: `${y}-${String(m1 + 2).padStart(2, '0')}-${last}`,
  };
};
const quarters = () => {
  const now = quarterOf(today());
  const out: string[] = [];
  let [y, q] = [Number(now.slice(0, 4)), Number(now.slice(-1))];
  for (let i = 0; i < 8; i++) {
    out.push(`${y}-${String((y + 1) % 100).padStart(2, '0')}-Q${q}`);
    if (--q === 0) [y, q] = [y - 1, 4];
  }
  return out;
};

interface Deduction {
  billId: string;
  party: string;
  pan: string | null;
  section: string;
  date: string;
  billNo: string;
  paid: string;
  base: string;
  rate: string;
  tds: string;
  challan: { id: string; bsrCode: string; challanNo: string; depositedOn: string } | null;
}
interface Challan {
  id: string;
  section: string;
  period: string;
  depositedOn: string;
  bsrCode: string;
  challanNo: string;
  tax: string;
  interest: string;
  fee: string;
  total: string;
}
interface Credits {
  upload: { fileName: string } | null;
  rows: {
    status: 'matched' | 'short' | 'more' | 'missing' | 'not_in_books' | 'no_tan';
    tan: string | null;
    party: string;
    books: string | null;
    reported: string | null;
  }[];
}
const CREDIT: Record<
  Credits['rows'][number]['status'],
  [string, 'success' | 'warning' | 'danger' | 'neutral']
> = {
  matched: ['Matched', 'success'],
  short: ['Short in 26AS', 'danger'],
  more: ['More in 26AS', 'warning'],
  missing: ['Not in 26AS', 'danger'],
  not_in_books: ['Not in the books', 'neutral'],
  no_tan: ['Client has no TAN', 'warning'],
};

export function TdsScreen() {
  const [quarter, setQuarter] = useState(quarterOf(today()));
  const mayPost = usePermission('accounts.post');
  return (
    <Books title="TDS">
      {(entityId) => (
        <>
          <Field label="Quarter">
            <Select value={quarter} onChange={(e) => setQuarter(e.target.value)} className="w-72">
              {quarters().map((q) => (
                <option key={q} value={q}>
                  {q.slice(0, 7)} {q.slice(-2)}: {QUARTER_MONTHS[Number(q.slice(-1)) - 1]}
                </option>
              ))}
            </Select>
          </Field>
          <Deductions key={`${entityId}-${quarter}`} entityId={entityId} quarter={quarter} />
          <SalaryTds entityId={entityId} quarter={quarter} mayPost={mayPost} />
          <ReturnFiles entityId={entityId} quarter={quarter} />
          <Certificates entityId={entityId} mayPost={mayPost} />
          <ClientCredits key={`c-${entityId}-${quarter}`} entityId={entityId} quarter={quarter} />
        </>
      )}
    </Books>
  );
}

function Deductions({ entityId, quarter }: { entityId: string; quarter: string }) {
  const qc = useQueryClient();
  const mayPost = usePermission('accounts.post');
  const { from, to } = quarterRange(quarter);
  const d = useQuery({
    queryKey: ['tds-deductions', entityId, quarter],
    queryFn: () =>
      api.request<{ rows: Deduction[]; undeposited: string }>(
        `/api/tenant/accounts/tds/deductions?entityId=${entityId}&from=${from}&to=${to}`,
      ),
  });
  const c = useQuery({
    queryKey: ['tds-challans', entityId, quarter],
    queryFn: () =>
      api.request<Challan[]>(
        `/api/tenant/accounts/tds/challans?entityId=${entityId}&from=${from}&to=${to}`,
      ),
  });
  const q26 = useQuery({
    queryKey: ['tds-26q', entityId, quarter],
    queryFn: () =>
      api.request<{ problems: string[]; total: string }>(
        `/api/tenant/accounts/tds/26q?entityId=${entityId}&quarter=${quarter}`,
      ),
  });
  const chart = useChart();
  const banks = (chart.data?.accounts ?? []).filter((a) => a.kind === 'bank' && !a.closed);
  const open = (d.data?.rows ?? []).filter((r) => !r.challan);
  const months = [...new Set(open.map((r) => `${r.section}|${r.date.slice(0, 7)}`))];
  const [f, setF] = useState({
    key: '',
    depositedOn: today(),
    bsrCode: '',
    challanNo: '',
    interest: '',
    fee: '',
    bankAccountId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = f.key || months[0] || '';
  const bankId = f.bankAccountId || banks[0]?.id || '';
  const deposit = async (e: FormEvent) => {
    e.preventDefault();
    const [section, period] = key.split('|');
    setBusy(true);
    setError(null);
    try {
      await api.request('/api/tenant/accounts/tds/challans', {
        method: 'POST',
        body: {
          entityId,
          section,
          period,
          depositedOn: f.depositedOn,
          bsrCode: f.bsrCode,
          challanNo: f.challanNo,
          interest: f.interest || '0',
          fee: f.fee || '0',
          bankAccountId: bankId,
        },
      });
      setF({ ...f, key: '', bsrCode: '', challanNo: '', interest: '', fee: '' });
      toast.success(`Challan ${f.bsrCode}/${f.challanNo} recorded`);
      for (const k of ['tds-deductions', 'tds-challans', 'tds-26q'])
        void qc.invalidateQueries({ queryKey: [k, entityId, quarter] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const excel = () =>
    void api
      .download(`/api/tenant/accounts/tds/26q?entityId=${entityId}&quarter=${quarter}&format=xlsx`)
      .then(({ blob, fileName }) => saveFile(blob, fileName))
      .catch((err: unknown) => setError(describeError(err)));
  if (d.isPending) return <Spinner />;
  if (d.isError) return <Alert tone="danger">{describeError(d.error)}</Alert>;
  const amountOf = (k: string) =>
    open
      .filter((r) => `${r.section}|${r.date.slice(0, 7)}` === k)
      .reduce((s, r) => s + Number(r.tds), 0)
      .toFixed(2);
  return (
    <>
      <Card
        title="Deducted from suppliers"
        actions={
          <Button type="button" variant="secondary" onClick={excel}>
            <FileSpreadsheet className="size-4" aria-hidden /> 26Q for the return utility
          </Button>
        }
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {(q26.data?.problems.length ?? 0) > 0 && (
          <Alert tone="warning">
            <ul aria-label="26Q problems">
              {q26.data!.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        {d.data.rows.length === 0 ? (
          <EmptyState title="Nothing was deducted this quarter.">
            TDS deducted on suppliers&apos; bills in the quarter shows here, to deposit by challan.
          </EmptyState>
        ) : (
          <Table minWidth="52rem">
            <thead>
              <tr>
                <th>Date</th>
                <th>Supplier</th>
                <th>Section</th>
                <th className="text-right">Paid or credited</th>
                <th className="text-right">TDS</th>
                <th>Challan</th>
              </tr>
            </thead>
            <tbody aria-label="Deductions">
              {d.data.rows.map((r) => (
                <tr key={r.billId}>
                  <td>{shortDate(r.date)}</td>
                  <td>
                    <Link
                      to="/accounts/vendor-bills/$billId"
                      params={{ billId: r.billId }}
                      className="text-accent hover:underline"
                    >
                      {r.party}
                    </Link>{' '}
                    <span className="text-xs text-fg-muted">{r.billNo}</span>
                    <div className="font-mono text-xs text-fg-muted">{r.pan ?? 'No PAN'}</div>
                  </td>
                  <td>{r.section}</td>
                  <td className="text-right tabular-nums">{rupees(r.paid)}</td>
                  <td className="text-right tabular-nums">{rupees(r.tds)}</td>
                  <td>
                    {r.challan ? (
                      <span className="font-mono text-xs">
                        {r.challan.bsrCode}/{r.challan.challanNo}
                      </span>
                    ) : (
                      <Badge tone="warning">To deposit</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {mayPost && months.length > 0 && (
          <form
            aria-label="Challan"
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => void deposit(e)}
          >
            <Field label="Deposit">
              <Select value={key} onChange={(e) => setF({ ...f, key: e.target.value })}>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {m.split('|')[0]} for {m.split('|')[1]}: {rupees(amountOf(m))}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Deposited on">
              <Input
                type="date"
                className="w-40"
                value={f.depositedOn}
                onChange={(e) => setF({ ...f, depositedOn: e.target.value })}
                required
              />
            </Field>
            <Field label="BSR code">
              <Input
                className="w-28"
                value={f.bsrCode}
                onChange={(e) => setF({ ...f, bsrCode: e.target.value })}
                maxLength={7}
                required
              />
            </Field>
            <Field label="Challan serial no.">
              <Input
                className="w-24"
                value={f.challanNo}
                onChange={(e) => setF({ ...f, challanNo: e.target.value })}
                maxLength={5}
                required
              />
            </Field>
            <Field label="Interest ₹">
              <Input
                className="w-24"
                value={f.interest}
                onChange={(e) => setF({ ...f, interest: e.target.value })}
              />
            </Field>
            <Field label="Fee ₹">
              <Input
                className="w-24"
                value={f.fee}
                onChange={(e) => setF({ ...f, fee: e.target.value })}
              />
            </Field>
            <Field label="Paid from">
              <Select
                value={bankId}
                onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}
              >
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" busy={busy}>
              Record the challan
            </Button>
          </form>
        )}
      </Card>
      {(c.data?.length ?? 0) > 0 && (
        <Card title="Challans">
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Deposited</th>
                <th>Section</th>
                <th>For</th>
                <th>BSR / serial</th>
                <th className="text-right">TDS</th>
                <th className="text-right">Interest and fee</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody aria-label="Challans">
              {c.data!.map((x) => (
                <tr key={x.id}>
                  <td>{shortDate(x.depositedOn)}</td>
                  <td>{x.section}</td>
                  <td>{x.period}</td>
                  <td className="font-mono text-xs">
                    {x.bsrCode}/{x.challanNo}
                  </td>
                  <td className="text-right tabular-nums">{rupees(x.tax)}</td>
                  <td className="text-right tabular-nums">
                    {rupees((Number(x.interest) + Number(x.fee)).toFixed(2))}
                  </td>
                  <td className="text-right tabular-nums">{rupees(x.total)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function ClientCredits({ entityId, quarter }: { entityId: string; quarter: string }) {
  const qc = useQueryClient();
  const mayPost = usePermission('accounts.post');
  const key = ['tds-credits', entityId, quarter];
  const r = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Credits>(
        `/api/tenant/accounts/tds/credits?entityId=${entityId}&quarter=${quarter}`,
      ),
  });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.upload<Credits>(
          `/api/tenant/accounts/tds/credits?entityId=${entityId}&quarter=${quarter}`,
          file,
        ),
      );
      toast.success(`26AS for ${quarter} uploaded`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Card
      title="Deducted by clients"
      actions={
        mayPost && (
          <>
            <input
              ref={input}
              type="file"
              accept=".xlsx"
              aria-label="26AS extract"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
            />
            <Button
              type="button"
              variant="secondary"
              busy={busy}
              onClick={() => input.current?.click()}
            >
              <Upload className="size-4" aria-hidden /> Upload 26AS (Excel)
            </Button>
          </>
        )
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {r.isPending ? (
        <Spinner />
      ) : r.isError ? (
        <Alert tone="danger">{describeError(r.error)}</Alert>
      ) : r.data.rows.length === 0 ? (
        <EmptyState title="No client deducted TDS this quarter.">
          TDS clients deduct from their receipts shows here, to match against 26AS.
        </EmptyState>
      ) : (
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Client</th>
              <th>TAN</th>
              <th className="text-right">In the books</th>
              <th className="text-right">In 26AS</th>
              <th>{r.data.upload ? 'Match' : ''}</th>
            </tr>
          </thead>
          <tbody aria-label="TDS deducted by clients">
            {r.data.rows.map((x, i) => (
              <tr key={i}>
                <td>{x.party}</td>
                <td className="font-mono text-xs">{x.tan ?? '-'}</td>
                <td className="text-right tabular-nums">{x.books ? rupees(x.books) : '-'}</td>
                <td className="text-right tabular-nums">{x.reported ? rupees(x.reported) : '-'}</td>
                <td>
                  {r.data.upload && <Badge tone={CREDIT[x.status][1]}>{CREDIT[x.status][0]}</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
