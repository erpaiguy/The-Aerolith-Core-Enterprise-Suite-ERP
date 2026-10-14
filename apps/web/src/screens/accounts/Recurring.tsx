// Recurring entries (docs/wave7-plan.md step 7d.7): vouchers and supplier bills that come round monthly, quarterly or
// yearly. Each due day brings a draft here; accounts post it as set (a bill with the supplier's number) or skip it.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Party, ProjectSummary } from '../../api/types';
import { ledgerOptions, today, useChart, useCompany } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';
import { shortDate } from '../../schedule/model';
import { CompanyPicker } from './Vouchers';

interface Recurring {
  today: string;
  templates: {
    id: string;
    kind: 'voucher' | 'bill';
    name: string;
    frequency: 'monthly' | 'quarterly' | 'yearly';
    dayOfMonth: number;
    startsOn: string;
    endsOn: string | null;
    active: boolean;
    amount: string;
    party: string | null;
    due: number;
    next: string | null;
  }[];
  drafts: {
    id: string;
    name: string;
    kind: 'voucher' | 'bill';
    dueOn: string;
    status: 'due' | 'posted' | 'skipped';
    note: string;
    voucher: string | null;
    bill: string | null;
  }[];
  mayPost: boolean;
}

export function RecurringScreen() {
  const qc = useQueryClient();
  const { company, choose } = useCompany();
  const key = ['recurring', company?.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Recurring>(`/api/tenant/accounts/recurring?entityId=${company!.id}`),
    enabled: !!company,
  });
  const [adding, setAdding] = useState(false);
  const [billNo, setBillNo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const act = async (url: string, body: object) => {
    setError(null);
    try {
      qc.setQueryData(key, await api.request<Recurring>(url, { method: 'POST', body }));
    } catch (err) {
      setError(describeError(err));
    }
  };
  const due = q.data?.drafts.filter((d) => d.status === 'due') ?? [];
  const done = q.data?.drafts.filter((d) => d.status !== 'due') ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Recurring entries"
        subtitle="Rent, hire, AMCs and accruals, drafted on their due days for you to post."
        actions={
          <div className="flex flex-wrap gap-2">
            {company ? <CompanyPicker value={company.id} onChange={choose} /> : null}
            {q.data?.mayPost && !adding ? (
              <Button onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden /> Set up an entry
              </Button>
            ) : null}
          </div>
        }
      />
      {adding && company ? (
        <NewRecurring
          entityId={company.id}
          onDone={(r) => {
            qc.setQueryData(key, r);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <>
          <Card title={`Due (${due.length})`}>
            {due.length === 0 ? (
              <p className="text-sm text-fg-muted">Nothing due.</p>
            ) : (
              <Table minWidth="40rem">
                <tbody aria-label="Due entries">
                  {due.map((d) => (
                    <tr key={d.id}>
                      <td>{shortDate(d.dueOn)}</td>
                      <td>
                        {d.name}
                        <span className="ml-1 text-xs text-fg-muted">
                          {d.kind === 'bill' ? 'bill' : 'voucher'}
                        </span>
                      </td>
                      <td className="text-right">
                        {q.data.mayPost ? (
                          <div className="flex justify-end gap-1">
                            {d.kind === 'bill' ? (
                              <Input
                                aria-label={`Bill number for ${d.name}`}
                                placeholder="Supplier's bill no."
                                value={billNo[d.id] ?? ''}
                                onChange={(e) => setBillNo({ ...billNo, [d.id]: e.target.value })}
                              />
                            ) : null}
                            <Button
                              variant="secondary"
                              onClick={() =>
                                void act(`/api/tenant/accounts/recurring-drafts/${d.id}/post`, {
                                  billNo: billNo[d.id] || null,
                                })
                              }
                            >
                              Post
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() =>
                                void act(`/api/tenant/accounts/recurring-drafts/${d.id}/skip`, {})
                              }
                            >
                              Skip
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="Set up">
            {q.data.templates.length === 0 ? (
              <p className="text-sm text-fg-muted">No recurring entry yet.</p>
            ) : (
              <Table minWidth="48rem">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Comes round</th>
                    <th className="text-right">Amount</th>
                    <th>Next</th>
                    <th />
                  </tr>
                </thead>
                <tbody aria-label="Recurring entries">
                  {q.data.templates.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {t.name}
                        {t.party ? <div className="text-xs text-fg-muted">{t.party}</div> : null}
                      </td>
                      <td>
                        {t.frequency} on day {t.dayOfMonth}
                        {t.endsOn ? `, to ${shortDate(t.endsOn)}` : ''}
                      </td>
                      <td className="text-right">{formatInr(t.amount)}</td>
                      <td>
                        {t.active ? t.next ? shortDate(t.next) : 'ended' : <Badge>paused</Badge>}
                      </td>
                      <td className="text-right">
                        {q.data.mayPost ? (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void act(`/api/tenant/accounts/recurring/${t.id}/active`, {
                                active: !t.active,
                              })
                            }
                          >
                            {t.active ? 'Pause' : 'Resume'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          {done.length ? (
            <Card title="Lately">
              <ul className="divide-y divide-line text-sm" aria-label="Recent entries">
                {done.map((d) => (
                  <li key={d.id} className="flex flex-wrap gap-2 py-1.5">
                    <span>{shortDate(d.dueOn)}</span>
                    <span className="flex-1">{d.name}</span>
                    {d.status === 'posted' ? (
                      <Badge tone="success">{d.voucher ?? d.bill}</Badge>
                    ) : (
                      <Badge>skipped{d.note ? `: ${d.note}` : ''}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One debit ledger against one credit (a voucher), or one supplier and expense (a bill): the usual shapes. */
function NewRecurring({
  entityId,
  onDone,
  onCancel,
}: {
  entityId: string;
  onDone: (r: Recurring) => void;
  onCancel: () => void;
}) {
  const chart = useChart();
  const parties = useQuery({
    queryKey: ['parties', 'all'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties'),
  });
  const projects = useQuery({
    queryKey: ['projects', 'all-for-books'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
  });
  const ledgers = ledgerOptions(chart.data?.accounts ?? []).filter((a) => a.kind !== 'party');
  const [f, setF] = useState({
    kind: 'voucher' as 'voucher' | 'bill',
    name: '',
    frequency: 'monthly',
    dayOfMonth: '1',
    startsOn: today(),
    endsOn: '',
    type: 'payment',
    debitId: '',
    creditId: '',
    partyId: '',
    amount: '',
    gstPct: '18',
    projectId: '',
    narration: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const projectId = f.projectId || null;
  const ledgerSelect = (label: string, k: 'debitId' | 'creditId') => (
    <Field label={label}>
      <Select value={f[k]} onChange={set(k)} required>
        <option value="">Choose a ledger</option>
        {ledgers.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  return (
    <Card title="Set up a recurring entry">
      <form
        aria-label="Recurring entry"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const common = {
            entityId,
            kind: f.kind,
            name: f.name,
            frequency: f.frequency,
            dayOfMonth: Number(f.dayOfMonth),
            startsOn: f.startsOn,
            endsOn: f.endsOn || null,
          };
          const body =
            f.kind === 'voucher'
              ? {
                  ...common,
                  voucher: {
                    type: f.type,
                    narration: f.narration,
                    lines: [
                      { accountId: f.debitId, debit: f.amount, projectId },
                      { accountId: f.creditId, credit: f.amount, projectId },
                    ],
                  },
                }
              : {
                  ...common,
                  bill: {
                    partyId: f.partyId,
                    projectId,
                    narration: f.narration,
                    lines: [
                      {
                        accountId: f.debitId,
                        projectId,
                        description: f.narration || f.name,
                        qty: '1',
                        rate: f.amount,
                        gstPct: f.gstPct,
                      },
                    ],
                  },
                };
          void api
            .request<Recurring>('/api/tenant/accounts/recurring', { method: 'POST', body })
            .then(onDone)
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="What">
            <Select value={f.kind} onChange={set('kind')}>
              <option value="voucher">A voucher</option>
              <option value="bill">A supplier's bill</option>
            </Select>
          </Field>
          <Field label="Name">
            <Input value={f.name} onChange={set('name')} required minLength={2} />
          </Field>
          <Field label="Comes round">
            <Select value={f.frequency} onChange={set('frequency')}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </Select>
          </Field>
          <Field label="On day">
            <Input
              type="number"
              min={1}
              max={28}
              value={f.dayOfMonth}
              onChange={set('dayOfMonth')}
            />
          </Field>
          <Field label="From">
            <Input type="date" value={f.startsOn} onChange={set('startsOn')} required />
          </Field>
          <Field label="Until">
            <Input type="date" value={f.endsOn} onChange={set('endsOn')} />
          </Field>
          <Field label="Amount (₹)">
            <Input inputMode="decimal" value={f.amount} onChange={set('amount')} required />
          </Field>
          <Field label="Project">
            <Select value={f.projectId} onChange={set('projectId')}>
              <option value="">None</option>
              {(projects.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {f.kind === 'voucher' ? (
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Voucher type">
              <Select value={f.type} onChange={set('type')}>
                <option value="payment">Payment</option>
                <option value="receipt">Receipt</option>
                <option value="journal">Journal</option>
              </Select>
            </Field>
            {ledgerSelect('Debit', 'debitId')}
            {ledgerSelect('Credit', 'creditId')}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Supplier">
              <Select value={f.partyId} onChange={set('partyId')} required>
                <option value="">Choose a supplier</option>
                {(parties.data ?? [])
                  .filter((p) => p.isVendor || p.isSubcontractor)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
            {ledgerSelect('Expense', 'debitId')}
            <Field label="GST %">
              <Input inputMode="decimal" value={f.gstPct} onChange={set('gstPct')} />
            </Field>
          </div>
        )}
        <Field label="Narration">
          <Input value={f.narration} onChange={set('narration')} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit">Save</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}
