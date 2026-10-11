// Setting up a company's books (docs/wave3-plan.md step 1): the months locked and open, and the opening balances,
// typed in from an Excel sheet of Ledger, Debit and Credit. Locks and openings are the admin's.
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Lock, LockOpen, Upload } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { amt, fyOf, today, useCompany, type VoucherLine } from '../../accounts/model';
import { formatAmount } from '../../boq/model';
import { describeError, formatDateTime } from '../../lib/format';
import { shortDate } from '../../schedule/model';
import { Books } from './Vouchers';

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function BooksSetupScreen() {
  return (
    <Books title="Books setup">
      {(entityId) => (
        <>
          <Periods entityId={entityId} />
          <Opening entityId={entityId} />
        </>
      )}
    </Books>
  );
}

function Periods({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const [fy, setFy] = useState(fyOf(today()).label);
  const key = ['periods', entityId, fy];
  const p = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<{
        months: {
          month: string;
          lockedAt: string | null;
          lockedBy: string | null;
          vouchers: number;
        }[];
        mayEdit: boolean;
      }>(`/api/tenant/accounts/periods?entityId=${entityId}&fy=${fy}`),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const start = Number(fy.slice(0, 4));
  const act = (path: 'lock' | 'reopen', month: string) => {
    const reason = path === 'reopen' ? window.prompt('Why is the month reopened?') : '';
    if (path === 'reopen' && (!reason || reason.trim().length < 3)) return;
    setBusy(month);
    setError(null);
    void api
      .request(`/api/tenant/accounts/periods/${path}`, {
        method: 'POST',
        body: { entityId, month, ...(path === 'reopen' ? { reason: reason!.trim() } : {}) },
      })
      .then((d) => qc.setQueryData(key, d))
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setBusy(null));
  };
  return (
    <Card
      title="Months"
      actions={
        <Select
          aria-label="Financial year"
          className="w-32"
          value={fy}
          onChange={(e) => setFy(e.target.value)}
        >
          {[start + 1, start, start - 1, start - 2].map((y) => {
            const l = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
            return (
              <option key={l} value={l}>
                {l}
              </option>
            );
          })}
        </Select>
      }
    >
      <p className="mb-3 text-sm text-fg-muted">
        A locked month takes no vouchers dated in it. Lock each month once its books are checked.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {p.isPending ? (
        <Spinner />
      ) : p.isError ? (
        <Alert tone="danger">{describeError(p.error)}</Alert>
      ) : (
        <Table minWidth="32rem">
          <thead>
            <tr>
              <th>Month</th>
              <th className="text-right">Vouchers</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="Months">
            {p.data.months.map((m) => (
              <tr key={m.month}>
                <td>{MONTH.format(new Date(`${m.month}T00:00:00Z`))}</td>
                <td className="text-right tabular-nums">{m.vouchers || '-'}</td>
                <td className="text-sm">
                  {m.lockedAt ? (
                    <span>
                      <Badge tone="warning">Locked</Badge>{' '}
                      <span className="text-xs text-fg-muted">
                        {m.lockedBy}, {formatDateTime(m.lockedAt)}
                      </span>
                    </span>
                  ) : (
                    <Badge tone="success">Open</Badge>
                  )}
                </td>
                <td className="text-right">
                  {p.data.mayEdit && (
                    <Button
                      variant="ghost"
                      busy={busy === m.month}
                      aria-label={`${m.lockedAt ? 'Reopen' : 'Lock'} ${MONTH.format(new Date(`${m.month}T00:00:00Z`))}`}
                      onClick={() => act(m.lockedAt ? 'reopen' : 'lock', m.month)}
                    >
                      {m.lockedAt ? (
                        <LockOpen className="size-4" aria-hidden />
                      ) : (
                        <Lock className="size-4" aria-hidden />
                      )}
                      {m.lockedAt ? 'Reopen' : 'Lock'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface Check {
  lines: { rowNo: number; label: string; debit: string; credit: string }[];
  problems: { rowNo: number; message: string }[];
  debit: string;
  credit: string;
  balanced: boolean;
  posted: boolean;
}

function Opening({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const { company } = useCompany();
  const key = ['opening', entityId];
  const o = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<{
        booksFrom: string | null;
        voucher: { id: string; number: string; date: string; lines: VoucherLine[] } | null;
        mayEdit: boolean;
      }>(`/api/tenant/companies/${entityId}/opening`),
  });
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (f: File, post: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.upload<Check>(
        `/api/tenant/companies/${entityId}/opening/import?post=${post}`,
        f,
      );
      setCheck(r);
      if (r.posted) {
        setFile(null);
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: ['trial-balance'] });
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  if (o.isPending) return <Spinner />;
  if (o.isError) return <Alert tone="danger">{describeError(o.error)}</Alert>;
  const v = o.data.voucher;
  return (
    <Card title="Opening balances">
      <div className="space-y-4">
        {!o.data.booksFrom ? (
          <Alert tone="warning">
            Set the date {company?.name ?? 'the company'}'s books start first, in{' '}
            <Link to="/settings/companies" className="underline">
              Companies
            </Link>
            .
          </Alert>
        ) : (
          <p className="text-sm text-fg-muted">
            The books start on {shortDate(o.data.booksFrom)}; opening balances are dated the day
            before.
          </p>
        )}
        {v ? (
          <Table minWidth="32rem">
            <thead>
              <tr>
                <th>Ledger</th>
                <th className="text-right">Debit</th>
                <th className="text-right">Credit</th>
              </tr>
            </thead>
            <tbody aria-label="Opening balances">
              {v.lines.map((l) => (
                <tr key={l.position}>
                  <td>
                    <span className="font-mono text-xs text-fg-muted">{l.account.code}</span>{' '}
                    {l.account.name}
                  </td>
                  <td className="text-right tabular-nums">{amt(l.debit)}</td>
                  <td className="text-right tabular-nums">{amt(l.credit)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-fg-muted">None yet.</p>
        )}
        {o.data.mayEdit && o.data.booksFrom && (
          <div className="space-y-3 rounded-md border border-line p-3">
            <div className="text-sm font-medium">
              {v ? 'Replace them from Excel' : 'From Excel'}
            </div>
            <p className="text-sm text-fg-muted">
              A sheet with columns headed Ledger, Debit and Credit; each ledger by its code or its
              name, or a party by its name. Checked first; posted only when every row is understood
              and the two sides agree.
            </p>
            <Field label="Workbook">
              <Input
                type="file"
                accept=".xlsx"
                aria-label="Opening balances workbook"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  setCheck(null);
                  if (f) void send(f, false);
                }}
              />
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            {check && !check.posted && (
              <div className="space-y-2" aria-label="Checked opening balances">
                {check.problems.map((p) => (
                  <Alert key={p.rowNo} tone="danger">
                    Row {p.rowNo}: {p.message}
                  </Alert>
                ))}
                <p className="text-sm">
                  {check.lines.length} balances: debit ₹{formatAmount(check.debit)}, credit ₹
                  {formatAmount(check.credit)}
                  {check.balanced ? '.' : ' — the two sides must agree.'}
                </p>
                {!check.problems.length && check.balanced && file && (
                  <Button busy={busy} onClick={() => void send(file, true)}>
                    <Upload className="size-4" aria-hidden /> Post the opening balances
                  </Button>
                )}
              </div>
            )}
            {check?.posted && <Alert tone="success">Opening balances posted.</Alert>}
          </div>
        )}
      </div>
    </Card>
  );
}
