// The documents stock moves on (docs/wave2b-plan.md step 6): an issue slip (and what came back from site), a transfer
// (received at the other end, or cancelled while in transit), and a stock take (counted, approved, posted).
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Spinner,
  Table,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { ApprovalSteps } from '../approvals/ApprovalTrail';
import { useRun } from '../approvals/model';
import { formatQty, formatRate } from '../boq/model';
import { describeError } from '../lib/format';
import { rupees } from '../procurement/OrderLines';
import {
  COUNT_STATUS,
  today,
  trimZeros,
  type Issue,
  type StockCount,
  type Transfer,
} from '../procurement/inventory';
import { shortDate } from '../schedule/model';
import { printLink } from '../print/Letterhead';

const back = (storeId: string, name: string) => (
  <Link
    to="/stores/$storeId"
    params={{ storeId }}
    className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
  >
    <ArrowLeft className="size-4" aria-hidden /> {name}
  </Link>
);

// --- issue slip ---

export function IssueScreen({ issueId }: { issueId: string }) {
  const qc = useQueryClient();
  const key = ['issue', issueId];
  const i = useQuery({
    queryKey: key,
    queryFn: () => api.request<Issue>(`/api/tenant/issues/${issueId}`),
  });
  const [qty, setQty] = useState<Record<number, string>>({});
  const { run, busy, error } = useRun(() => {
    setQty({});
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['store'] });
  });
  if (i.isPending) return <Spinner />;
  if (i.isError) return <Alert tone="danger">{describeError(i.error)}</Alert>;
  const d = i.data;
  const out = d.lines.filter((l) => Number(l.returned) < Number(l.qty));
  return (
    <div className="space-y-5">
      {back(d.store.id, d.store.name)}
      <PageHeader
        title={`Issue slip ${d.number}`}
        subtitle={`${shortDate(d.issuedOn)} · ${d.wbs.code} ${d.wbs.name} · taken by ${d.issuedTo}`}
        actions={
          <Link to="/print/issues/$issueId" params={{ issueId: d.id }} className={printLink}>
            <Printer className="size-4" aria-hidden /> Print
          </Link>
        }
      />
      {d.purpose && <p className="text-sm">{d.purpose}</p>}
      <Card>
        <Table minWidth="36rem">
          <thead>
            <tr>
              <th>Material</th>
              <th>BOQ item</th>
              <th className="text-right">Issued</th>
              <th className="text-right">Value</th>
              <th className="text-right">Back from site</th>
            </tr>
          </thead>
          <tbody aria-label="Issued">
            {d.lines.map((l) => (
              <tr key={l.position}>
                <td>
                  <span className="mr-2 font-mono text-xs">{l.code}</span>
                  {l.name}
                </td>
                <td className="font-mono text-xs">{l.boqCode ?? ''}</td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {formatQty(l.qty)} {l.unit}
                </td>
                <td className="text-right tabular-nums">{rupees(l.value)}</td>
                <td className="text-right tabular-nums">
                  {Number(l.returned) > 0 ? formatQty(l.returned) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {d.mayReturn && (
        <Card title="Back to the store" className="print:hidden">
          <form
            className="space-y-3"
            aria-label="Return to store"
            onSubmit={(e) => {
              e.preventDefault();
              void run('return', () =>
                api.request(`/api/tenant/issues/${d.id}/returns`, {
                  method: 'POST',
                  body: {
                    returnedOn: today(),
                    lines: out
                      .filter((l) => Number(qty[l.position]) > 0)
                      .map((l) => ({ position: l.position, qty: qty[l.position]!.trim() })),
                  },
                }),
              ).then((ok) => ok && toast.success(`Return to the store on ${d.number} recorded`));
            }}
          >
            {out.map((l) => (
              <div key={l.position} className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1 pb-2 text-sm">
                  {l.name}{' '}
                  <span className="text-fg-muted">
                    ({formatQty(String(Number(l.qty) - Number(l.returned)))} {l.unit} out on site)
                  </span>
                </div>
                <Field label={`Back: ${l.name}`}>
                  <Input
                    inputMode="decimal"
                    value={qty[l.position] ?? ''}
                    className="w-24"
                    onChange={(e) => setQty({ ...qty, [l.position]: e.target.value })}
                  />
                </Field>
              </div>
            ))}
            <Button
              type="submit"
              busy={busy === 'return'}
              disabled={!out.some((l) => Number(qty[l.position]) > 0)}
            >
              Back into the store
            </Button>
            {error && <Alert tone="danger">{error}</Alert>}
          </form>
        </Card>
      )}
    </div>
  );
}

// --- transfer ---

export function TransferScreen({ transferId }: { transferId: string }) {
  const qc = useQueryClient();
  const key = ['transfer', transferId];
  const t = useQuery({
    queryKey: key,
    queryFn: () => api.request<Transfer>(`/api/tenant/transfers/${transferId}`),
  });
  const { run, busy, error } = useRun(() => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['store'] });
  });
  const confirm = useConfirm();
  // What arrived, line by line, when it is not all that was sent (step 8e.3).
  const [arrived, setArrived] = useState<Record<number, { qty: string; reason: string }>>({});
  if (t.isPending) return <Spinner />;
  if (t.isError) return <Alert tone="danger">{describeError(t.error)}</Alert>;
  const d = t.data;
  return (
    <div className="space-y-5">
      {back(d.fromStore.id, d.fromStore.name)}
      <PageHeader
        title={`Transfer ${d.number}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                d.status === 'in_transit'
                  ? 'warning'
                  : d.status === 'received'
                    ? 'success'
                    : 'neutral'
              }
            >
              {d.status === 'in_transit'
                ? 'In transit'
                : d.status === 'received'
                  ? 'Received'
                  : 'Cancelled'}
            </Badge>
            <span>
              {d.fromStore.name} ({d.fromStore.project}) to {d.toStore.name} ({d.toStore.project}),
              sent {shortDate(d.sentOn)}
              {d.receivedOn && `, received ${shortDate(d.receivedOn)}`}
            </span>
          </span>
        }
        actions={
          <div className="flex gap-2 print:hidden">
            {d.mayReceive && (
              <Button
                busy={busy === 'receive'}
                onClick={() =>
                  void run('receive', () =>
                    api.request(`/api/tenant/transfers/${d.id}/receive`, {
                      method: 'POST',
                      body: {
                        receivedOn: today(),
                        short: d.lines
                          .filter((l) => {
                            const a = arrived[l.position];
                            return a && a.qty.trim() !== '' && Number(a.qty) !== Number(l.qty);
                          })
                          .map((l) => ({
                            position: l.position,
                            receivedQty: arrived[l.position]!.qty.trim(),
                            reason: arrived[l.position]!.reason,
                          })),
                      },
                    }),
                  ).then((ok) => ok && toast.success(`Transfer ${d.number} received`))
                }
              >
                Received
              </Button>
            )}
            {d.mayCancel && (
              <Button
                variant="ghost"
                busy={busy === 'cancel'}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Cancel transfer ${d.number}?`,
                      body: `The goods go back into ${d.fromStore.name}'s stock and the transfer cannot be received.`,
                      confirmLabel: 'Cancel the transfer',
                      tone: 'danger',
                    }))
                  )
                    return;
                  if (
                    await run('cancel', () =>
                      api.request(`/api/tenant/transfers/${d.id}/cancel`, {
                        method: 'POST',
                        body: {},
                      }),
                    )
                  )
                    toast.success(`Transfer ${d.number} cancelled`);
                }}
              >
                Cancel (back to {d.fromStore.name})
              </Button>
            )}
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="size-4" aria-hidden /> Print
            </Button>
          </div>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {d.note && <p className="text-sm">{d.note}</p>}
      {(d.vehicleNo || d.transporter || d.ewayBillNo) && (
        <p className="text-sm">
          {[
            d.vehicleNo && `Vehicle ${d.vehicleNo}`,
            d.transporter,
            d.ewayBillNo && `e-way bill ${d.ewayBillNo}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <Card>
        <Table minWidth="30rem">
          <thead>
            <tr>
              <th>Material</th>
              <th className="text-right">Quantity</th>
              <th className="text-right">Value</th>
              {(d.mayReceive || d.lines.some((l) => Number(l.lostQty) > 0)) && <th>Arrived</th>}
            </tr>
          </thead>
          <tbody aria-label="Transferred">
            {d.lines.map((l) => (
              <tr key={l.position}>
                <td>
                  <span className="mr-2 font-mono text-xs">{l.code}</span>
                  {l.name}
                </td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {formatQty(l.qty)} {l.unit}
                </td>
                <td className="text-right tabular-nums">{rupees(l.value)}</td>
                {d.mayReceive ? (
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        aria-label={`Arrived of ${l.code}`}
                        inputMode="decimal"
                        className="w-24"
                        placeholder={formatQty(l.qty)}
                        value={arrived[l.position]?.qty ?? ''}
                        onChange={(e) =>
                          setArrived({
                            ...arrived,
                            [l.position]: {
                              reason: '',
                              ...arrived[l.position],
                              qty: e.target.value,
                            },
                          })
                        }
                      />
                      {arrived[l.position]?.qty &&
                        Number(arrived[l.position]!.qty) < Number(l.qty) && (
                          <Input
                            aria-label={`Why ${l.code} came short`}
                            placeholder="Why short"
                            value={arrived[l.position]!.reason}
                            onChange={(e) =>
                              setArrived({
                                ...arrived,
                                [l.position]: { ...arrived[l.position]!, reason: e.target.value },
                              })
                            }
                          />
                        )}
                    </div>
                  </td>
                ) : (
                  Number(l.lostQty) > 0 && (
                    <td className="text-sm">
                      {formatQty(l.receivedQty ?? '0')} arrived; {formatQty(l.lostQty)} lost (
                      {rupees(l.lostValue)}){l.lossReason ? `: ${l.lossReason}` : ''}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

// --- stock take ---

export function StockCountScreen({ countId }: { countId: string }) {
  const qc = useQueryClient();
  const key = ['stock-count', countId];
  const c = useQuery({
    queryKey: key,
    queryFn: () => api.request<StockCount>(`/api/tenant/stock-counts/${countId}`),
  });
  if (c.isPending) return <Spinner />;
  if (c.isError) return <Alert tone="danger">{describeError(c.error)}</Alert>;
  return (
    <CountView
      key={c.data.rowVersion}
      c={c.data}
      refresh={() => {
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: ['store'] });
        void qc.invalidateQueries({ queryKey: ['inbox'] });
      }}
    />
  );
}

function CountView({ c, refresh }: { c: StockCount; refresh: () => void }) {
  const [counted, setCounted] = useState<Record<string, { counted: string; reason: string }>>(() =>
    Object.fromEntries(
      c.lines.map((l) => [l.resourceId, { counted: trimZeros(l.countedQty), reason: l.reason }]),
    ),
  );
  const dirty = c.lines.some(
    (l) =>
      counted[l.resourceId]!.counted !== trimZeros(l.countedQty) ||
      counted[l.resourceId]!.reason !== l.reason,
  );
  const { run, busy, error } = useRun(refresh);
  const confirm = useConfirm();
  const post = (k: string, path: string, body: object, done: string) =>
    void run(k, () =>
      api.request(`/api/tenant/stock-counts/${c.id}${path}`, { method: 'POST', body }),
    ).then((ok) => ok && toast.success(done));
  const totalValue = c.lines.reduce((t, l) => t + Number(l.value), 0);
  return (
    <div className="space-y-5">
      {back(c.store.id, c.store.name)}
      <PageHeader
        title={`Stock take ${c.number}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                c.status === 'posted'
                  ? 'success'
                  : c.status === 'submitted'
                    ? 'warning'
                    : c.status === 'rejected'
                      ? 'danger'
                      : 'neutral'
              }
            >
              {COUNT_STATUS[c.status]}
            </Badge>
            <span>
              Counted {shortDate(c.countedOn)} · differences {rupees(totalValue.toFixed(2))}
            </span>
          </span>
        }
        actions={
          c.mayEdit && (
            <div className="flex gap-2">
              <Button
                busy={busy === 'submit'}
                disabled={dirty}
                title={dirty ? 'Save your counts first' : undefined}
                onClick={() =>
                  post(
                    'submit',
                    '/submit',
                    { rowVersion: c.rowVersion },
                    `Stock take ${c.number} put up for approval`,
                  )
                }
              >
                Submit for approval
              </Button>
              <Button
                variant="ghost"
                busy={busy === 'discard'}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Discard stock take ${c.number}?`,
                      body: 'The counts typed in are thrown away; the stock stays as the book has it.',
                      confirmLabel: 'Discard the stock take',
                      tone: 'danger',
                    }))
                  )
                    return;
                  post('discard', '/discard', {}, `Stock take ${c.number} discarded`);
                }}
              >
                Discard
              </Button>
            </div>
          )
        }
      />
      {c.status === 'rejected' && c.statusReason && (
        <Alert tone="warning">Rejected: {c.statusReason}</Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card
        title="Counted against the book"
        actions={
          c.mayEdit &&
          dirty && (
            <Button
              busy={busy === 'save'}
              onClick={() =>
                post(
                  'save',
                  '',
                  {
                    rowVersion: c.rowVersion,
                    countedOn: c.countedOn,
                    notes: c.notes,
                    lines: c.lines.map((l) => ({
                      resourceId: l.resourceId,
                      counted: counted[l.resourceId]!.counted.trim() || '0',
                      reason: counted[l.resourceId]!.reason,
                    })),
                  },
                  'Counts saved',
                )
              }
            >
              Save counts
            </Button>
          )
        }
      >
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Material</th>
              <th className="text-right">Book</th>
              <th className="text-right">Counted</th>
              <th className="text-right">Difference</th>
              <th className="text-right">At</th>
              <th className="text-right">Value</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody aria-label="Count">
            {c.lines.map((l) => (
              <tr key={l.resourceId}>
                <td>
                  <span className="mr-2 font-mono text-xs">{l.code}</span>
                  {l.name}
                </td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {formatQty(l.bookQty)} {l.unit}
                </td>
                <td className="text-right">
                  {c.mayEdit ? (
                    <Input
                      aria-label={`Counted ${l.name}`}
                      inputMode="decimal"
                      value={counted[l.resourceId]!.counted}
                      className="w-24 text-right"
                      onChange={(e) =>
                        setCounted({
                          ...counted,
                          [l.resourceId]: { ...counted[l.resourceId]!, counted: e.target.value },
                        })
                      }
                    />
                  ) : (
                    formatQty(l.countedQty)
                  )}
                </td>
                <td
                  className={`text-right tabular-nums ${Number(l.difference) < 0 ? 'text-danger' : ''}`}
                >
                  {Number(l.difference) === 0 ? '-' : formatQty(l.difference)}
                </td>
                <td className="text-right tabular-nums">{formatRate(l.unitCost)}</td>
                <td className="text-right tabular-nums">
                  {Number(l.value) === 0 ? '-' : rupees(l.value)}
                </td>
                <td>
                  {c.mayEdit ? (
                    <Input
                      aria-label={`Why ${l.name}`}
                      value={counted[l.resourceId]!.reason}
                      maxLength={500}
                      onChange={(e) =>
                        setCounted({
                          ...counted,
                          [l.resourceId]: { ...counted[l.resourceId]!, reason: e.target.value },
                        })
                      }
                    />
                  ) : (
                    <span className="text-sm">{l.reason}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="mt-3 text-xs text-fg-muted">
          The difference is against the book when each line was counted; once approved it posts as a
          stock adjustment.
        </p>
      </Card>
      {c.approval && (
        <Card
          title="Approval"
          actions={
            <Link
              to="/approvals/$approvalId"
              params={{ approvalId: c.approval.id }}
              className="text-sm text-accent hover:underline"
            >
              Open the approval
            </Link>
          }
        >
          {c.approval.steps.length ? (
            <ApprovalSteps approval={c.approval} />
          ) : (
            <p className="text-sm text-fg-muted">
              No approval rule applies: posted when submitted.
            </p>
          )}
          {c.approval.mayWithdraw && (
            <Button
              className="mt-3"
              variant="secondary"
              busy={busy === 'withdraw'}
              onClick={() =>
                void run('withdraw', () =>
                  api.request(`/api/tenant/approvals/${c.approval!.id}/withdraw`, {
                    method: 'POST',
                    body: {},
                  }),
                ).then((ok) => ok && toast.success(`Stock take ${c.number} withdrawn to change it`))
              }
            >
              Withdraw to change it
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}

/** The approver's view of a stock take: each difference and its value. */
export function CountDocument({ doc }: { doc: StockCount }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {doc.store.name}, counted {shortDate(doc.countedOn)}.
      </p>
      <Table minWidth="36rem">
        <thead>
          <tr>
            <th>Material</th>
            <th className="text-right">Book</th>
            <th className="text-right">Counted</th>
            <th className="text-right">Value</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody aria-label="Differences">
          {doc.lines
            .filter((l) => Number(l.difference) !== 0)
            .map((l) => (
              <tr key={l.resourceId}>
                <td>{l.name}</td>
                <td className="text-right tabular-nums">
                  {formatQty(l.bookQty)} {l.unit}
                </td>
                <td className="text-right tabular-nums">{formatQty(l.countedQty)}</td>
                <td className="text-right tabular-nums">{rupees(l.value)}</td>
                <td className="text-sm">{l.reason}</td>
              </tr>
            ))}
        </tbody>
      </Table>
    </div>
  );
}
