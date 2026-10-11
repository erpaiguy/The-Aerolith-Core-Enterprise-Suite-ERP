// The books' reports (docs/wave3-plan.md step 1): the trial balance as at a date (optionally for one project), a
// ledger between two dates with its running balance, and the day book; each also as Excel.
import { Alert, Button, Card, Field, Input, Select, Spinner, Table, cx } from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { api, saveFile } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import {
  amt,
  drcr,
  fyOf,
  today,
  useCompany,
  VOUCHER_TYPE,
  type VoucherLine,
  type VoucherType,
} from '../../accounts/model';
import { formatAmount } from '../../boq/model';
import { describeError } from '../../lib/format';
import { shortDate } from '../../schedule/model';
import { Books, CompanyPicker } from './Vouchers';

function Excel({ url }: { url: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="secondary"
        busy={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void api
            .download(`${url}&format=xlsx`)
            .then(({ blob, fileName }) => saveFile(blob, fileName))
            .catch((err: unknown) => setError(describeError(err)))
            .finally(() => setBusy(false));
        }}
      >
        <FileSpreadsheet className="size-4" aria-hidden /> Excel
      </Button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </span>
  );
}

interface TbRow {
  id: string;
  code: string;
  name: string;
  isGroup: boolean;
  depth: number;
  debit: string | null;
  credit: string | null;
}

export function TrialBalanceScreen() {
  const [asOf, setAsOf] = useState(today());
  const [projectId, setProjectId] = useState('');
  const projects = useQuery({
    queryKey: ['projects', 'all-for-books'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
  });
  return (
    <Books title="Trial balance">
      {(entityId) => {
        const url = `/api/tenant/accounts/trial-balance?entityId=${entityId}&asOf=${asOf}${projectId ? `&projectId=${projectId}` : ''}`;
        return (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="As at">
                <Input
                  type="date"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                  className="w-40"
                />
              </Field>
              <Field label="Project">
                <Select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-64"
                >
                  <option value="">The whole company</option>
                  {(projects.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.number} · {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Excel url={url} />
            </div>
            <TrialBalance url={url} entityId={entityId} asOf={asOf} projectOnly={!!projectId} />
          </>
        );
      }}
    </Books>
  );
}

function TrialBalance({
  url,
  entityId,
  asOf,
  projectOnly,
}: {
  url: string;
  entityId: string;
  asOf: string;
  projectOnly: boolean;
}) {
  const tb = useQuery({
    queryKey: ['trial-balance', url],
    queryFn: () => api.request<{ rows: TbRow[]; debit: string; credit: string }>(url),
    placeholderData: keepPreviousData,
  });
  if (tb.isPending) return <Spinner />;
  if (tb.isError) return <Alert tone="danger">{describeError(tb.error)}</Alert>;
  const from = fyOf(asOf).from;
  return (
    <Card>
      {projectOnly && (
        <p className="mb-3 text-sm text-fg-muted">
          Lines that name the project only: its two sides need not agree.
        </p>
      )}
      <Table minWidth="36rem">
        <thead>
          <tr>
            <th>Account</th>
            <th className="text-right">Debit</th>
            <th className="text-right">Credit</th>
          </tr>
        </thead>
        <tbody aria-label="Trial balance">
          {tb.data.rows.map((r) => (
            <tr
              key={r.id}
              className={cx(r.isGroup && 'font-medium', r.depth === 0 && 'bg-surface-2')}
            >
              <td style={{ paddingLeft: `${0.75 + r.depth * 1.25}rem` }}>
                {r.isGroup ? (
                  r.name
                ) : (
                  <Link
                    to="/accounts/ledgers/$accountId"
                    params={{ accountId: r.id }}
                    search={{ entityId, from, to: asOf }}
                    className="hover:underline"
                  >
                    <span className="font-mono text-xs text-fg-muted">{r.code}</span> {r.name}
                  </Link>
                )}
              </td>
              <td className="text-right tabular-nums">{amt(r.debit)}</td>
              <td className="text-right tabular-nums">{amt(r.credit)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-line font-semibold">
            <td>Total</td>
            <td className="text-right tabular-nums">{formatAmount(tb.data.debit)}</td>
            <td className="text-right tabular-nums">{formatAmount(tb.data.credit)}</td>
          </tr>
        </tbody>
      </Table>
    </Card>
  );
}

interface LedgerReport {
  company: string;
  account: { id: string; code: string; name: string };
  opening: string;
  closing: string;
  debit: string;
  credit: string;
  lines: {
    voucherId: string;
    number: string;
    type: VoucherType;
    date: string;
    narration: string;
    note: string;
    project: string | null;
    debit: string;
    credit: string;
    balance: string;
  }[];
}

export function LedgerScreen({
  accountId,
  search,
}: {
  accountId: string;
  search: { entityId?: string | undefined; from?: string | undefined; to?: string | undefined };
}) {
  const navigate = useNavigate();
  const { company, choose } = useCompany();
  const entityId = search.entityId ?? company?.id;
  const to = search.to ?? today();
  const from = search.from ?? fyOf(to).from;
  const url = `/api/tenant/accounts/ledgers/${accountId}?entityId=${entityId}&from=${from}&to=${to}`;
  const r = useQuery({
    queryKey: ['ledger', url],
    queryFn: () => api.request<LedgerReport>(url),
    enabled: !!entityId,
    placeholderData: keepPreviousData,
  });
  const go = (patch: { entityId?: string; from?: string; to?: string }) =>
    void navigate({
      to: '/accounts/ledgers/$accountId',
      params: { accountId },
      search: { entityId, from, to, ...patch },
    });
  if (!entityId || r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const x = r.data;
  return (
    <div className="space-y-5">
      <Link to="/accounts/trial-balance" className="text-sm text-fg-muted hover:underline">
        ← Trial balance
      </Link>
      <h1 className="text-xl font-semibold">
        <span className="font-mono text-base text-fg-muted">{x.account.code}</span> {x.account.name}
      </h1>
      <div className="flex flex-wrap items-end gap-3">
        <CompanyPicker
          value={entityId}
          onChange={(id) => {
            choose(id);
            go({ entityId: id });
          }}
        />
        <Field label="From">
          <Input
            type="date"
            value={from}
            onChange={(e) => go({ from: e.target.value })}
            className="w-40"
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={to}
            onChange={(e) => go({ to: e.target.value })}
            className="w-40"
          />
        </Field>
        <Excel url={url} />
      </div>
      <Card title={x.company}>
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Date</th>
              <th>Voucher</th>
              <th>Narration</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody aria-label="Ledger">
            <tr className="text-fg-muted">
              <td>{shortDate(from)}</td>
              <td colSpan={4}>Opening balance</td>
              <td className="whitespace-nowrap text-right tabular-nums">{drcr(x.opening)}</td>
            </tr>
            {x.lines.map((l, i) => (
              <tr key={`${l.voucherId}-${i}`}>
                <td className="whitespace-nowrap">{shortDate(l.date)}</td>
                <td className="whitespace-nowrap">
                  <Link
                    to="/accounts/vouchers/$voucherId"
                    params={{ voucherId: l.voucherId }}
                    className="font-mono text-xs text-accent hover:underline"
                  >
                    {l.number}
                  </Link>
                  <div className="text-xs text-fg-muted">{VOUCHER_TYPE[l.type]}</div>
                </td>
                <td className="text-sm">
                  {l.note || l.narration}
                  {l.project && <span className="text-xs text-fg-muted"> · {l.project}</span>}
                </td>
                <td className="text-right tabular-nums">{amt(l.debit)}</td>
                <td className="text-right tabular-nums">{amt(l.credit)}</td>
                <td className="whitespace-nowrap text-right tabular-nums">{drcr(l.balance)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-line font-semibold">
              <td colSpan={3}>Closing balance</td>
              <td className="text-right tabular-nums">{amt(x.debit)}</td>
              <td className="text-right tabular-nums">{amt(x.credit)}</td>
              <td className="whitespace-nowrap text-right tabular-nums">{drcr(x.closing)}</td>
            </tr>
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

export function DayBookScreen() {
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  return (
    <Books title="Day book">
      {(entityId) => {
        const url = `/api/tenant/accounts/day-book?entityId=${entityId}&from=${from}&to=${to}`;
        return (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="From">
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="w-40"
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="w-40"
                />
              </Field>
              <Excel url={url} />
            </div>
            <DayBook url={url} />
          </>
        );
      }}
    </Books>
  );
}

function DayBook({ url }: { url: string }) {
  const book = useQuery({
    queryKey: ['day-book', url],
    queryFn: () =>
      api.request<{
        vouchers: {
          id: string;
          type: VoucherType;
          number: string;
          date: string;
          narration: string;
          total: string;
          lines: VoucherLine[];
        }[];
        total: string;
      }>(url),
    placeholderData: keepPreviousData,
  });
  if (book.isPending) return <Spinner />;
  if (book.isError) return <Alert tone="danger">{describeError(book.error)}</Alert>;
  if (!book.data.vouchers.length)
    return (
      <Card>
        <p className="text-sm text-fg-muted">No vouchers between these dates.</p>
      </Card>
    );
  return (
    <Card>
      <Table minWidth="44rem">
        <thead>
          <tr>
            <th>Date</th>
            <th>Voucher</th>
            <th>Ledger</th>
            <th className="text-right">Debit</th>
            <th className="text-right">Credit</th>
          </tr>
        </thead>
        <tbody aria-label="Day book">
          {book.data.vouchers.flatMap((v) =>
            v.lines.map((l, i) => (
              <tr key={`${v.id}-${l.position}`} className={cx(i === 0 && 'border-t border-line')}>
                <td className="whitespace-nowrap">{i === 0 ? shortDate(v.date) : ''}</td>
                <td className="whitespace-nowrap">
                  {i === 0 && (
                    <>
                      <Link
                        to="/accounts/vouchers/$voucherId"
                        params={{ voucherId: v.id }}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {v.number}
                      </Link>
                      <div className="text-xs text-fg-muted">{VOUCHER_TYPE[v.type]}</div>
                    </>
                  )}
                </td>
                <td className="text-sm">
                  <span className="font-mono text-xs text-fg-muted">{l.account.code}</span>{' '}
                  {l.account.name}
                  {i === v.lines.length - 1 && v.narration && (
                    <div className="text-xs italic text-fg-muted">{v.narration}</div>
                  )}
                </td>
                <td className="text-right tabular-nums">{amt(l.debit)}</td>
                <td className="text-right tabular-nums">{amt(l.credit)}</td>
              </tr>
            )),
          )}
        </tbody>
      </Table>
      <p className="mt-3 text-right text-sm font-medium tabular-nums">
        {book.data.vouchers.length} vouchers, ₹{formatAmount(book.data.total)}
      </p>
    </Card>
  );
}
