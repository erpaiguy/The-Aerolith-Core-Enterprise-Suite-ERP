// Financial statements (docs/wave3-plan.md step 8a): profit and loss and balance sheet in Schedule III's lines with the
// previous year beside them, cash flow by the indirect method, each project's P&L, and the year end.
import { Alert, Badge, Button, Card, Field, Input, Spinner, Table, cx } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, saveFile } from '../../api/client';
import { fyOf, today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { useSession } from '../../session/session';
import { Books } from './Vouchers';

type Tab = 'pl' | 'bs' | 'cf' | 'projects' | 'year' | 'tally';
const TABS: [Tab, string][] = [
  ['pl', 'Profit and loss'],
  ['bs', 'Balance sheet'],
  ['cf', 'Cash flow'],
  ['projects', 'Projects'],
  ['year', 'Year end'],
  ['tally', 'Tally'],
];
const amt = (v: string) => (Number(v) < 0 ? `(${rupees(v.replace('-', ''))})` : rupees(v));
const WC: Record<string, string> = {
  inventories: 'Inventories',
  sundry_debtors: 'Trade receivables',
  loans_and_advances: 'Loans and advances',
  sundry_creditors: 'Trade payables',
  other_current_liabilities: 'Other current liabilities',
  duties_and_taxes: 'Duties and taxes',
  provisions: 'Provisions',
};

interface Line {
  key: string;
  head: string;
  label: string;
  amount: string;
  previous: string;
}

export function StatementsScreen() {
  const fy = fyOf(today());
  const [tab, setTab] = useState<Tab>('pl');
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(today());
  return (
    <Books title="Financial statements">
      {(entityId) => (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div role="tablist" aria-label="Statements" className="flex flex-wrap gap-1">
              {TABS.map(([k, label]) => (
                <Button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  variant={tab === k ? 'primary' : 'ghost'}
                  onClick={() => setTab(k)}
                >
                  {label}
                </Button>
              ))}
            </div>
            {tab !== 'bs' && tab !== 'year' && (
              <Field label="From">
                <Input
                  type="date"
                  className="w-40"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
            )}
            {tab !== 'year' && (
              <Field label={tab === 'bs' ? 'As at' : 'To'}>
                <Input
                  type="date"
                  className="w-40"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            )}
          </div>
          {tab === 'pl' && <ProfitAndLoss entityId={entityId} from={from} to={to} />}
          {tab === 'bs' && <BalanceSheet entityId={entityId} asOf={to} />}
          {tab === 'cf' && <CashFlow entityId={entityId} from={from} to={to} />}
          {tab === 'projects' && <Projects entityId={entityId} from={from} to={to} />}
          {tab === 'year' && <YearEnd entityId={entityId} />}
          {tab === 'tally' && <Tally entityId={entityId} from={from} to={to} />}
        </>
      )}
    </Books>
  );
}

function Statement({
  title,
  lines,
  totals,
  excel,
  label,
}: {
  title: string;
  lines: Line[];
  totals: [string, string, string][];
  excel: string;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const heads = [...new Set(lines.map((l) => l.head))];
  return (
    <Card
      title={title}
      actions={
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            void api
              .download(excel)
              .then(({ blob, fileName }) => saveFile(blob, fileName))
              .catch((err: unknown) => setError(describeError(err)))
          }
        >
          <FileSpreadsheet className="size-4" aria-hidden /> Excel
        </Button>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Table minWidth="32rem">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="text-right">This period</th>
            <th className="text-right">Previous year</th>
          </tr>
        </thead>
        <tbody aria-label={label}>
          {heads.map((h) => (
            <HeadRows key={h} head={h} lines={lines.filter((l) => l.head === h)} />
          ))}
          {totals.map(([t, a, b]) => (
            <tr key={t} className="font-semibold">
              <td>{t}</td>
              <td className="text-right tabular-nums">{amt(a)}</td>
              <td className="text-right tabular-nums">{amt(b)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
function HeadRows({ head, lines }: { head: string; lines: Line[] }) {
  return (
    <>
      <tr>
        <td
          colSpan={3}
          className="pt-3 text-xs font-semibold uppercase tracking-wide text-fg-subtle"
        >
          {head}
        </td>
      </tr>
      {lines
        .filter((l) => Number(l.amount) !== 0 || Number(l.previous) !== 0)
        .map((l) => (
          <tr key={l.key}>
            <td className="pl-4">{l.label}</td>
            <td className="text-right tabular-nums">{amt(l.amount)}</td>
            <td className="text-right tabular-nums text-fg-muted">{amt(l.previous)}</td>
          </tr>
        ))}
    </>
  );
}

function ProfitAndLoss({ entityId, from, to }: { entityId: string; from: string; to: string }) {
  const q = `entityId=${entityId}&from=${from}&to=${to}`;
  const r = useQuery({
    queryKey: ['pl', q],
    queryFn: () =>
      api.request<{
        lines: Line[];
        income: string;
        expenses: string;
        profit: string;
        previous: { income: string; expenses: string; profit: string };
      }>(`/api/tenant/accounts/statements/profit-and-loss?${q}`),
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  return (
    <Statement
      title="Profit and loss"
      label="Profit and loss"
      lines={d.lines}
      excel={`/api/tenant/accounts/statements/profit-and-loss?${q}&format=xlsx`}
      totals={[
        ['Total income', d.income, d.previous.income],
        ['Total expenses', d.expenses, d.previous.expenses],
        [
          Number(d.profit) < 0 ? 'Loss for the period' : 'Profit for the period',
          d.profit,
          d.previous.profit,
        ],
      ]}
    />
  );
}

function BalanceSheet({ entityId, asOf }: { entityId: string; asOf: string }) {
  const q = `entityId=${entityId}&asOf=${asOf}`;
  const r = useQuery({
    queryKey: ['bs', q],
    queryFn: () =>
      api.request<{
        lines: Line[];
        profitNotClosed: string;
        equityAndLiabilities: string;
        assets: string;
        balanced: boolean;
        previous: { equityAndLiabilities: string; assets: string };
      }>(`/api/tenant/accounts/statements/balance-sheet?${q}`),
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  return (
    <>
      {!d.balanced && (
        <Alert tone="danger">The balance sheet does not balance. Check the chart's groups.</Alert>
      )}
      <Statement
        title="Balance sheet"
        label="Balance sheet"
        lines={d.lines}
        excel={`/api/tenant/accounts/statements/balance-sheet?${q}&format=xlsx`}
        totals={[
          ['Total equity and liabilities', d.equityAndLiabilities, d.previous.equityAndLiabilities],
          ['Total assets', d.assets, d.previous.assets],
        ]}
      />
      {Number(d.profitNotClosed) !== 0 && (
        <p className="text-sm text-fg-muted">
          Other equity includes {amt(d.profitNotClosed)} of profit not yet closed into the profit
          and loss account.
        </p>
      )}
    </>
  );
}

function CashFlow({ entityId, from, to }: { entityId: string; from: string; to: string }) {
  const q = `entityId=${entityId}&from=${from}&to=${to}`;
  const r = useQuery({
    queryKey: ['cf', q],
    queryFn: () =>
      api.request<{
        profit: string;
        depreciation: string;
        workingCapital: { group: string; change: string }[];
        otherOperating: string;
        operating: string;
        investing: string;
        financing: string;
        netChange: string;
        openingCash: string;
        closingCash: string;
        agrees: boolean;
      }>(`/api/tenant/accounts/statements/cash-flow?${q}`),
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  const row = (label: string, v: string, strong = false) => (
    <tr className={cx(strong && 'font-semibold')}>
      <td className={cx(!strong && 'pl-4')}>{label}</td>
      <td className="text-right tabular-nums">{amt(v)}</td>
    </tr>
  );
  return (
    <Card title="Cash flow (indirect method)">
      <Table minWidth="28rem">
        <tbody aria-label="Cash flow">
          {row('Profit for the period', d.profit)}
          {row('Add: depreciation', d.depreciation)}
          {d.workingCapital
            .filter((w) => Number(w.change) !== 0)
            .map((w) => (
              <tr key={w.group}>
                <td className="pl-4">Change in {WC[w.group]?.toLowerCase() ?? w.group}</td>
                <td className="text-right tabular-nums">{amt(w.change)}</td>
              </tr>
            ))}
          {Number(d.otherOperating) !== 0 && row('Other', d.otherOperating)}
          {row('Cash from operating activities', d.operating, true)}
          {row('Cash from investing activities', d.investing, true)}
          {row('Cash from financing activities', d.financing, true)}
          {row('Net change in cash and bank', d.netChange, true)}
          {row('Cash and bank at the start', d.openingCash)}
          {row('Cash and bank at the end', d.closingCash, true)}
        </tbody>
      </Table>
      {!d.agrees && (
        <Alert tone="warning">The flows do not add up to the change in cash and bank.</Alert>
      )}
    </Card>
  );
}

function Projects({ entityId, from, to }: { entityId: string; from: string; to: string }) {
  const q = `entityId=${entityId}&from=${from}&to=${to}`;
  const r = useQuery({
    queryKey: ['project-pl', q],
    queryFn: () =>
      api.request<{
        projects: {
          project: { id: string; number: string; name: string };
          revenue: string;
          costs: string;
          margin: string;
          marginPct: string | null;
          byLine: { label: string; amount: string }[];
          byCostCode: { costCode: string; amount: string }[];
          invoiced: string;
          received: string;
          outstanding: string;
        }[];
      }>(`/api/tenant/accounts/statements/projects?${q}`),
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  return (
    <Card title="Project P&L">
      {r.data.projects.length === 0 ? (
        <p className="text-sm text-fg-muted">No project has income or costs in these dates.</p>
      ) : (
        <Table minWidth="56rem">
          <thead>
            <tr>
              <th>Project</th>
              <th className="text-right">Revenue</th>
              <th className="text-right">Costs</th>
              <th className="text-right">Margin</th>
              <th className="text-right">Invoiced</th>
              <th className="text-right">Received</th>
              <th className="text-right">Outstanding</th>
            </tr>
          </thead>
          <tbody aria-label="Project P&L">
            {r.data.projects.map((p) => (
              <tr key={p.project.id} className="align-top">
                <td>
                  <span className="font-mono text-xs text-fg-muted">{p.project.number}</span>{' '}
                  {p.project.name}
                  <ul className="mt-1 text-xs text-fg-muted">
                    {p.byLine.map((l) => (
                      <li key={l.label}>
                        {l.label}: {amt(l.amount)}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="text-right tabular-nums">{amt(p.revenue)}</td>
                <td className="text-right tabular-nums">{amt(p.costs)}</td>
                <td
                  className={cx('text-right tabular-nums', Number(p.margin) < 0 && 'text-danger')}
                >
                  {amt(p.margin)}
                  {p.marginPct && <div className="text-xs text-fg-muted">{p.marginPct}%</div>}
                </td>
                <td className="text-right tabular-nums">{amt(p.invoiced)}</td>
                <td className="text-right tabular-nums">{amt(p.received)}</td>
                <td className="text-right tabular-nums">{amt(p.outstanding)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function YearEnd({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const session = useSession();
  const isAdmin = session.user?.role === 'admin';
  const key = ['year-end', entityId];
  const r = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<{ closed: { fy: string; date: string; number: string }[] }>(
        `/api/tenant/accounts/year-end?entityId=${entityId}`,
      ),
  });
  const last = fyOf(today());
  const prev = `${Number(last.label.slice(0, 4)) - 1}-${last.label.slice(2, 4)}`;
  const [fy, setFy] = useState(prev);
  const [stock, setStock] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const close = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm(`Close ${fy}? Its months are locked and its income and expenses closed.`))
      return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.request<{ profit: string }>('/api/tenant/accounts/year-end', {
        method: 'POST',
        body: { entityId, fy, closingStock: stock || '0' },
      });
      setDone(`${fy} closed: ${Number(out.profit) < 0 ? 'loss' : 'profit'} ${amt(out.profit)}.`);
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Year end">
      {error && <Alert tone="danger">{error}</Alert>}
      {done && <Alert tone="success">{done}</Alert>}
      {r.data && r.data.closed.length > 0 && (
        <p className="mb-3 text-sm">
          Closed:{' '}
          {r.data.closed.map((c) => (
            <Badge key={c.fy} tone="success">
              {c.fy}
            </Badge>
          ))}
        </p>
      )}
      {isAdmin ? (
        <form
          aria-label="Close a year"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => void close(e)}
        >
          <Field label="Financial year">
            <Input
              className="w-28"
              value={fy}
              onChange={(e) => setFy(e.target.value)}
              pattern="\d{4}-\d{2}"
              required
            />
          </Field>
          <Field label="Closing stock ₹" hint="The stores' valuation as at 31 March">
            <Input
              className="w-36 text-right"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
            />
          </Field>
          <Button type="submit" busy={busy}>
            Close the year
          </Button>
        </form>
      ) : (
        <p className="text-sm text-fg-muted">The admin closes a year.</p>
      )}
    </Card>
  );
}

const MODES: [string, string][] = [
  ['native', 'The app keeps the books'],
  ['native_tally', 'The app keeps the books, and exports them to Tally'],
  ['tally', 'Tally keeps the books: no vouchers typed here'],
];

function Tally({ entityId, from, to }: { entityId: string; from: string; to: string }) {
  const qc = useQueryClient();
  const m = useQuery({
    queryKey: ['accounts-mode'],
    queryFn: () => api.request<{ mode: string; mayEdit: boolean }>('/api/tenant/accounts/mode'),
  });
  const [error, setError] = useState<string | null>(null);
  const download = (path: string) =>
    void api
      .download(path)
      .then(({ blob, fileName }) => saveFile(blob, fileName))
      .catch((err: unknown) => setError(describeError(err)));
  if (m.isPending) return <Spinner />;
  if (m.isError) return <Alert tone="danger">{describeError(m.error)}</Alert>;
  return (
    <Card title="Tally">
      {error && <Alert tone="danger">{error}</Alert>}
      <fieldset className="space-y-1" aria-label="Accounts mode">
        {MODES.map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="accounts-mode"
              checked={m.data.mode === k}
              disabled={!m.data.mayEdit}
              onChange={() =>
                void api
                  .request('/api/tenant/accounts/mode', { method: 'PUT', body: { mode: k } })
                  .then((next) => qc.setQueryData(['accounts-mode'], next))
                  .catch((err: unknown) => setError(describeError(err)))
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      {m.data.mode !== 'native' && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              download(`/api/tenant/accounts/tally/masters?entityId=${entityId}&from=${from}`)
            }
          >
            <FileSpreadsheet className="size-4" aria-hidden /> Masters as at {from}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              download(
                `/api/tenant/accounts/tally/vouchers?entityId=${entityId}&from=${from}&to=${to}`,
              )
            }
          >
            <FileSpreadsheet className="size-4" aria-hidden /> Vouchers, {from} to {to}
          </Button>
        </div>
      )}
      <p className="mt-3 text-sm text-fg-muted">
        Import the masters first, then the vouchers, in Tally Prime: Gateway of Tally, Import,
        Masters or Transactions.
      </p>
    </Card>
  );
}
