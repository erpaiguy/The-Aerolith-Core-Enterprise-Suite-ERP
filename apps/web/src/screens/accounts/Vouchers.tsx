// Vouchers (docs/wave3-plan.md step 1): the list for a company, typing one in (lines that must balance), and one
// voucher with its reversal. A posted voucher is never edited: it is reversed.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Textarea,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2, Undo2 } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../../api/client';
import type { Party, ProjectSummary } from '../../api/types';
import {
  amt,
  ledgerOptions,
  today,
  TYPED_IN,
  useChart,
  useCompany,
  VOUCHER_TYPE,
  type Voucher,
  type VoucherType,
} from '../../accounts/model';
import { formatAmount } from '../../boq/model';
import { describeError, formatDateTime } from '../../lib/format';
import { shortDate } from '../../schedule/model';
import { usePermission } from '../../session/permissions';

/** The company picker every books screen carries. */
export function CompanyPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { companies } = useCompany();
  if (companies.length < 2) return null;
  return (
    <Select
      aria-label="Company"
      className="w-64"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {companies.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}

/** A books screen: the title, the company, and nothing until the company is known. */
export function Books({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: (companyId: string) => ReactNode;
}) {
  const { company, loading, error, choose } = useCompany();
  if (loading) return <Spinner />;
  if (error) return <Alert tone="danger">{describeError(error)}</Alert>;
  if (!company) return <Alert tone="warning">No company is set up.</Alert>;
  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        subtitle={subtitle ?? company.name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CompanyPicker value={company.id} onChange={choose} />
            {actions}
          </div>
        }
      />
      {children(company.id)}
    </div>
  );
}

interface VoucherRow {
  id: string;
  type: VoucherType;
  number: string;
  date: string;
  narration: string;
  reference: string;
  total: string;
  isReversal: boolean;
  reversed: boolean;
  sourceKind: string | null;
}

export function VouchersScreen() {
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const mayPost = usePermission('accounts.post');
  return (
    <Books
      title="Vouchers"
      actions={
        mayPost && (
          <Link
            to="/accounts/vouchers/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            <Plus className="size-4" aria-hidden /> New voucher
          </Link>
        )
      }
    >
      {(entityId) => (
        <>
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Type"
              className="w-44"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">Every type</option>
              {Object.entries(VOUCHER_TYPE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Input
              type="date"
              aria-label="From"
              className="w-40"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <Input
              type="date"
              aria-label="To"
              className="w-40"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <Input
              type="search"
              aria-label="Search vouchers"
              placeholder="Number, narration or reference"
              className="min-w-[14rem] flex-1"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <VoucherList entityId={entityId} filter={{ type, from, to, q: q.trim() }} />
        </>
      )}
    </Books>
  );
}

function VoucherList({
  entityId,
  filter,
}: {
  entityId: string;
  filter: { type: string; from: string; to: string; q: string };
}) {
  const params = new URLSearchParams({ entityId });
  for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
  const list = useQuery({
    queryKey: ['vouchers', params.toString()],
    queryFn: () =>
      api.request<{ vouchers: VoucherRow[] }>(`/api/tenant/accounts/vouchers?${params}`),
    placeholderData: keepPreviousData,
  });
  if (list.isPending) return <Spinner />;
  if (list.isError) return <Alert tone="danger">{describeError(list.error)}</Alert>;
  return (
    <Card>
      {list.data.vouchers.length === 0 ? (
        <EmptyState title="No vouchers.">Change the filters, or post a new voucher.</EmptyState>
      ) : (
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Date</th>
              <th>Voucher</th>
              <th>Type</th>
              <th>Narration</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody aria-label="Vouchers">
            {list.data.vouchers.map((v) => (
              <tr key={v.id}>
                <td className="whitespace-nowrap">{shortDate(v.date)}</td>
                <td className="whitespace-nowrap">
                  <Link
                    to="/accounts/vouchers/$voucherId"
                    params={{ voucherId: v.id }}
                    className="font-mono text-xs text-accent hover:underline"
                  >
                    {v.number}
                  </Link>{' '}
                  {v.reversed && <Badge tone="warning">Reversed</Badge>}
                  {v.isReversal && <Badge>Reversal</Badge>}
                </td>
                <td className="text-sm">{VOUCHER_TYPE[v.type]}</td>
                <td className="text-sm">
                  {v.narration}
                  {v.reference && <span className="text-xs text-fg-muted"> · {v.reference}</span>}
                </td>
                <td className="text-right tabular-nums">{formatAmount(v.total)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface DraftLine {
  key: number;
  target: string; // "a:<account id>" or "p:<party id>"
  debit: string;
  credit: string;
  projectId: string;
  note: string;
}
const blank = (key: number): DraftLine => ({
  key,
  target: '',
  debit: '',
  credit: '',
  projectId: '',
  note: '',
});
const toPaise = (v: string) => Math.round(Number(v || '0') * 100);
const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;

export function NewVoucherScreen() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const chart = useChart();
  const parties = useQuery({
    queryKey: ['parties', 'all'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties'),
  });
  const projects = useQuery({
    queryKey: ['projects', 'all-for-books'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
  });
  const [type, setType] = useState<VoucherType>('journal');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blank(1), blank(2)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const options = useMemo(
    () => ledgerOptions((chart.data?.accounts ?? []).filter((a) => a.kind !== 'party')),
    [chart.data],
  );
  const byId = new Map((chart.data?.accounts ?? []).map((a) => [a.id, a]));
  const groups = [...new Set(options.map((o) => o.group))];
  const [dr, cr] = [
    lines.reduce((s, l) => s + toPaise(l.debit), 0),
    lines.reduce((s, l) => s + toPaise(l.credit), 0),
  ];
  const set = (key: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <Books title="New voucher">
      {(entityId) => {
        const submit = async (e: FormEvent) => {
          e.preventDefault();
          const used = lines.filter((l) => l.target || l.debit || l.credit);
          const bad = used.findIndex(
            (l) =>
              !l.target ||
              !!l.debit === !!l.credit ||
              ![l.debit, l.credit].filter(Boolean).every((v) => AMOUNT.test(v)),
          );
          if (bad >= 0) {
            setError(`Line ${bad + 1}: a ledger and either a debit or a credit.`);
            return;
          }
          if (
            !(await confirm({
              title: `Post this ${VOUCHER_TYPE[type].toLowerCase()} voucher of ₹${formatAmount(String(dr / 100))}?`,
              body: 'It goes into the books dated as entered. A posted voucher cannot be edited, only reversed.',
              confirmLabel: 'Post the voucher',
              tone: 'primary',
            }))
          )
            return;
          setBusy(true);
          setError(null);
          try {
            const v = await api.request<Voucher>('/api/tenant/accounts/vouchers', {
              method: 'POST',
              body: {
                entityId,
                type,
                date,
                reference,
                narration,
                lines: used.map((l) => ({
                  accountId: l.target.startsWith('a:') ? l.target.slice(2) : null,
                  partyId: l.target.startsWith('p:') ? l.target.slice(2) : null,
                  debit: l.debit || '0',
                  credit: l.credit || '0',
                  projectId: l.projectId || null,
                  note: l.note,
                })),
              },
            });
            void qc.invalidateQueries({ queryKey: ['vouchers'] });
            toast.success(`Voucher ${v.number} posted`);
            await navigate({ to: '/accounts/vouchers/$voucherId', params: { voucherId: v.id } });
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        };
        if (chart.isPending) return <Spinner />;
        if (chart.isError) return <Alert tone="danger">{describeError(chart.error)}</Alert>;
        return (
          <form onSubmit={(e) => void submit(e)} className="space-y-5" aria-label="Voucher">
            <Card>
              <div className="grid gap-3 sm:grid-cols-[12rem_10rem_1fr]">
                <Field label="Type">
                  <Select value={type} onChange={(e) => setType(e.target.value as VoucherType)}>
                    {TYPED_IN.map((t) => (
                      <option key={t} value={t}>
                        {VOUCHER_TYPE[t]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Date">
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Reference" hint="Cheque or UTR number, the other side's bill number">
                  <Input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    maxLength={100}
                  />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Narration">
                  <Textarea
                    value={narration}
                    onChange={(e) => setNarration(e.target.value)}
                    rows={2}
                    maxLength={2000}
                  />
                </Field>
              </div>
            </Card>
            <Card title="Lines">
              <div className="space-y-3">
                {lines.map((l, i) => {
                  const a = l.target.startsWith('a:') ? byId.get(l.target.slice(2)) : undefined;
                  return (
                    <fieldset
                      key={l.key}
                      aria-label={`Line ${i + 1}`}
                      className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto]"
                    >
                      <Select
                        aria-label="Ledger"
                        value={l.target}
                        onChange={(e) => set(l.key, { target: e.target.value })}
                      >
                        <option value="">Choose a ledger or party</option>
                        {groups.map((g) => (
                          <optgroup key={g} label={g}>
                            {options
                              .filter((o) => o.group === g)
                              .map((o) => (
                                <option key={o.id} value={`a:${o.id}`}>
                                  {o.label}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                        <optgroup label="Parties">
                          {(parties.data ?? []).map((p) => (
                            <option key={p.id} value={`p:${p.id}`}>
                              {p.name}
                            </option>
                          ))}
                        </optgroup>
                      </Select>
                      <Input
                        aria-label="Debit"
                        placeholder="Debit"
                        inputMode="decimal"
                        className="text-right"
                        value={l.debit}
                        onChange={(e) =>
                          set(l.key, { debit: e.target.value.replace(/[,\s]/g, '') })
                        }
                      />
                      <Input
                        aria-label="Credit"
                        placeholder="Credit"
                        inputMode="decimal"
                        className="text-right"
                        value={l.credit}
                        onChange={(e) =>
                          set(l.key, { credit: e.target.value.replace(/[,\s]/g, '') })
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={`Remove line ${i + 1}`}
                        disabled={lines.length <= 2}
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                      <Select
                        aria-label="Project"
                        className="sm:col-span-1"
                        value={l.projectId}
                        onChange={(e) => set(l.key, { projectId: e.target.value })}
                      >
                        <option value="">
                          {a?.needsProject ? 'Choose the project (needed)' : 'No project'}
                        </option>
                        {(projects.data?.items ?? []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.number} · {p.name}
                          </option>
                        ))}
                      </Select>
                      <Input
                        aria-label="Line note"
                        placeholder="Note"
                        className="sm:col-span-3"
                        value={l.note}
                        onChange={(e) => set(l.key, { note: e.target.value })}
                        maxLength={500}
                      />
                    </fieldset>
                  );
                })}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setLines((ls) => [...ls, blank(Math.max(...ls.map((x) => x.key)) + 1)])
                  }
                >
                  <Plus className="size-4" aria-hidden /> Add a line
                </Button>
                <div
                  className="flex flex-wrap justify-end gap-4 text-sm tabular-nums"
                  aria-label="Totals"
                >
                  <span>Debit {formatAmount((dr / 100).toFixed(2))}</span>
                  <span>Credit {formatAmount((cr / 100).toFixed(2))}</span>
                  {dr !== cr && (
                    <span className="font-medium text-danger">
                      Difference {formatAmount((Math.abs(dr - cr) / 100).toFixed(2))}
                    </span>
                  )}
                </div>
              </div>
            </Card>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex gap-2">
              <Button type="submit" busy={busy} disabled={dr === 0 || dr !== cr}>
                Post the voucher
              </Button>
              <Link
                to="/accounts/vouchers"
                className="px-3 py-2 text-sm text-fg-muted hover:underline"
              >
                Cancel
              </Link>
            </div>
          </form>
        );
      }}
    </Books>
  );
}

export function VoucherScreen({ voucherId }: { voucherId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const v = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.request<Voucher>(`/api/tenant/accounts/vouchers/${voucherId}`),
  });
  const [reversing, setReversing] = useState(false);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  if (v.isPending) return <Spinner />;
  if (v.isError) return <Alert tone="danger">{describeError(v.error)}</Alert>;
  const x = v.data;
  const reverse = async (e: FormEvent) => {
    e.preventDefault();
    if (
      !(await confirm({
        title: `Reverse voucher ${x.number}?`,
        body: `A new voucher dated ${shortDate(date)} is posted with every line the other way round. It cannot be undone.`,
        confirmLabel: 'Reverse the voucher',
        tone: 'danger',
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.request<Voucher>(`/api/tenant/accounts/vouchers/${x.id}/reverse`, {
        method: 'POST',
        body: { date, reason },
      });
      void qc.invalidateQueries({ queryKey: ['voucher', x.id] });
      void qc.invalidateQueries({ queryKey: ['vouchers'] });
      toast.success(`Voucher ${x.number} reversed by ${r.number}`);
      await navigate({ to: '/accounts/vouchers/$voucherId', params: { voucherId: r.id } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const [dr, cr] = [
    x.lines.reduce((s, l) => s + Number(l.debit), 0),
    x.lines.reduce((s, l) => s + Number(l.credit), 0),
  ];
  return (
    <div className="space-y-5">
      <Link
        to="/accounts/vouchers"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Vouchers
      </Link>
      <PageHeader
        title={`${VOUCHER_TYPE[x.type]} ${x.number}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{shortDate(x.date)}</span>
            <span>{x.company}</span>
            {x.reversedBy && (
              <Badge tone="warning">
                Reversed by{' '}
                <Link
                  to="/accounts/vouchers/$voucherId"
                  params={{ voucherId: x.reversedBy.id }}
                  className="underline"
                >
                  {x.reversedBy.number}
                </Link>
              </Badge>
            )}
            {x.reverses && (
              <Badge>
                Reverses{' '}
                <Link
                  to="/accounts/vouchers/$voucherId"
                  params={{ voucherId: x.reverses.id }}
                  className="underline"
                >
                  {x.reverses.number}
                </Link>
              </Badge>
            )}
          </span>
        }
        actions={
          x.mayReverse &&
          !reversing && (
            <Button type="button" variant="secondary" onClick={() => setReversing(true)}>
              <Undo2 className="size-4" aria-hidden /> Reverse
            </Button>
          )
        }
      />
      {reversing && (
        <Card title="Reverse this voucher">
          <form onSubmit={(e) => void reverse(e)} className="space-y-3" aria-label="Reverse">
            <p className="text-sm text-fg-muted">
              A new voucher with every line the other way round; this one stays as it is.
            </p>
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <Field label="Date of the reversal">
                <Input
                  type="date"
                  value={date}
                  min={x.date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </Field>
              <Field label="Why">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  minLength={3}
                  maxLength={500}
                />
              </Field>
            </div>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex gap-2">
              <Button type="submit" busy={busy}>
                Reverse
              </Button>
              <Button type="button" variant="ghost" onClick={() => setReversing(false)}>
                Keep it
              </Button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        {(x.narration || x.reference) && (
          <p className="mb-3 text-sm">
            {x.narration}
            {x.reference && <span className="text-fg-muted"> · Ref. {x.reference}</span>}
          </p>
        )}
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Ledger</th>
              <th>Project</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
            </tr>
          </thead>
          <tbody aria-label="Voucher lines">
            {x.lines.map((l) => (
              <tr key={l.position}>
                <td>
                  <Link
                    to="/accounts/ledgers/$accountId"
                    params={{ accountId: l.account.id }}
                    search={{ entityId: x.entityId }}
                    className="hover:underline"
                  >
                    <span className="font-mono text-xs text-fg-muted">{l.account.code}</span>{' '}
                    {l.account.name}
                  </Link>
                  {l.note && <div className="text-xs text-fg-muted">{l.note}</div>}
                </td>
                <td className="text-sm">
                  {l.project ? `${l.project.number}${l.site ? ` · ${l.site.name}` : ''}` : ''}
                </td>
                <td className="text-right tabular-nums">{amt(l.debit)}</td>
                <td className="text-right tabular-nums">{amt(l.credit)}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td colSpan={2}>Total</td>
              <td className="text-right tabular-nums">{formatAmount(dr.toFixed(2))}</td>
              <td className="text-right tabular-nums">{formatAmount(cr.toFixed(2))}</td>
            </tr>
          </tbody>
        </Table>
        <p className="mt-3 text-xs text-fg-muted">
          Posted{x.createdBy ? ` by ${x.createdBy}` : ''}, {formatDateTime(x.createdAt)}
          {x.sourceKind && ' from a document'}
        </p>
      </Card>
    </div>
  );
}
