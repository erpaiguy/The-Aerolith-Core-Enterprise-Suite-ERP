// A goods receipt (docs/wave2b-plan.md step 5): what came against a purchase order, on which challan, at which site;
// each line accepted at the gate or held for inspection; the held ones inspected; the rejected ones returned to the
// supplier. Cancelled (with a reason) when made in error, unless something from it already went back.
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useRun } from '../approvals/model';
import { formatQty } from '../boq/model';
import { LinkedDocuments } from '../documents/LinkedDocuments';
import { describeError } from '../lib/format';
import type { Inspection, Receipt } from '../procurement/orders';
import { shortDate } from '../schedule/model';
import { printLink } from '../print/Letterhead';

const INSPECTION: Record<Inspection, string> = {
  gate: 'Accepted at the gate',
  hold: 'Held for inspection',
  inspected: 'Inspected',
};
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const trim = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

export function GoodsReceiptScreen({ receiptId }: { receiptId: string }) {
  const qc = useQueryClient();
  const key = ['receipt', receiptId];
  const r = useQuery({
    queryKey: key,
    queryFn: () => api.request<Receipt>(`/api/tenant/receipts/${receiptId}`),
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  return (
    <ReceiptView
      key={`${r.data.rowVersion}-${r.data.returns.length}`}
      r={r.data}
      onChanged={(next) => {
        qc.setQueryData(key, next);
        void qc.invalidateQueries({ queryKey: ['order', next.order.id] });
        void qc.invalidateQueries({ queryKey: ['receipts'] });
        void qc.invalidateQueries({ queryKey: ['orders'] });
      }}
    />
  );
}

function ReceiptView({ r, onChanged }: { r: Receipt; onChanged: (next: Receipt) => void }) {
  const { run, busy, error } = useRun(() => undefined);
  const call = (k: string, path: string, body: object) =>
    run(k, async () =>
      onChanged(
        await api.request<Receipt>(`/api/tenant/receipts/${r.id}/${path}`, {
          method: 'POST',
          body,
        }),
      ),
    );
  const held = r.lines.filter((l) => l.inspection === 'hold');
  const toReturn = r.lines.filter((l) => Number(l.rejected) > Number(l.returned));
  return (
    <div className="space-y-5">
      <Link
        to="/orders/$orderId"
        params={{ orderId: r.order.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> Purchase order {r.order.number}
      </Link>
      <PageHeader
        title={`Goods receipt ${r.number}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {r.status === 'cancelled' ? (
              <Badge tone="danger">Cancelled</Badge>
            ) : held.length ? (
              <Badge tone="warning">{held.length} held for inspection</Badge>
            ) : (
              <Badge tone="success">Received</Badge>
            )}
            <span>{r.vendor.name}</span>
            <span>
              {r.project.number} · {r.project.name}
            </span>
          </span>
        }
        actions={
          <div className="flex gap-2 print:hidden">
            <Link
              to="/print/receipts/$receiptId"
              params={{ receiptId: r.id }}
              className={printLink}
            >
              <Printer className="size-4" aria-hidden /> Print
            </Link>
            {r.mayCancel && (
              <Button
                variant="ghost"
                busy={busy === 'cancel'}
                onClick={() => {
                  const reason = window.prompt('Why is the receipt cancelled?');
                  if (reason && reason.trim().length >= 3)
                    void call('cancel', 'cancel', { reason: reason.trim() });
                }}
              >
                Cancel receipt
              </Button>
            )}
          </div>
        }
      />
      {r.status === 'cancelled' && r.statusReason && (
        <Alert tone="info">
          Cancelled: {r.statusReason}. What it recorded is owed again on the order.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">Received</dt>
          <dd>
            {shortDate(r.receivedOn)}
            {r.site && ` at ${r.site.name}`}
            {r.store && (
              <>
                {', into '}
                <Link
                  to="/stores/$storeId"
                  params={{ storeId: r.store.id }}
                  className="text-accent hover:underline"
                >
                  {r.store.name}
                </Link>
              </>
            )}
            {r.receivedBy && `, by ${r.receivedBy}`}
          </dd>
          <dt className="text-fg-muted">Challan</dt>
          <dd>
            {r.challanNo}
            {r.challanDate && ` of ${shortDate(r.challanDate)}`}
          </dd>
          {r.vehicleNo && (
            <>
              <dt className="text-fg-muted">Vehicle</dt>
              <dd>{r.vehicleNo}</dd>
            </>
          )}
          {r.invoiceNo && (
            <>
              <dt className="text-fg-muted">Invoice</dt>
              <dd>{r.invoiceNo}</dd>
            </>
          )}
          {r.notes && (
            <>
              <dt className="text-fg-muted">Notes</dt>
              <dd className="whitespace-pre-wrap">{r.notes}</dd>
            </>
          )}
        </dl>
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th className="w-8">#</th>
              <th>Description</th>
              <th className="text-right">Came</th>
              <th>Inspection</th>
              <th className="text-right">Accepted</th>
              <th className="text-right">Rejected</th>
              <th className="text-right">Returned</th>
            </tr>
          </thead>
          <tbody aria-label="Receipt lines">
            {r.lines.map((l) => (
              <tr key={l.position}>
                <td className="tabular-nums text-fg-muted">{l.position}</td>
                <td>
                  {l.description}
                  {!l.stocked && (
                    <span className="block text-xs text-fg-muted">
                      Typed in, not from the library: not stocked
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {formatQty(l.qty)} {l.unit}
                </td>
                <td>
                  {l.inspection === 'hold' ? (
                    <Badge tone="warning">{INSPECTION[l.inspection]}</Badge>
                  ) : (
                    <span className="text-sm">{INSPECTION[l.inspection]}</span>
                  )}
                  {l.inspectedBy && (
                    <span className="block text-xs text-fg-muted">by {l.inspectedBy}</span>
                  )}
                </td>
                <td className="text-right tabular-nums">
                  {l.inspection === 'hold' ? '' : formatQty(l.accepted)}
                </td>
                <td className="text-right tabular-nums">
                  {Number(l.rejected) > 0 ? formatQty(l.rejected) : ''}
                  {l.rejectionReason && (
                    <span className="block text-xs text-fg-muted">{l.rejectionReason}</span>
                  )}
                </td>
                <td className="text-right tabular-nums">
                  {Number(l.returned) > 0 ? formatQty(l.returned) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {(r.documents.length > 0 || r.mayAttach) && (
        <Card title="Challan and certificates">
          <LinkedDocuments
            vault={`projects/${r.project.id}`}
            kind="goods_receipt"
            targetId={r.id}
            label={`Goods receipt ${r.number}`}
            documents={r.documents}
            folder={null}
            path={`Receipts/${r.number.replaceAll('/', '-')}`}
            canAttach={r.mayAttach && r.status === 'posted'}
            onChanged={() =>
              void api
                .request<Receipt>(`/api/tenant/receipts/${r.id}`)
                .then(onChanged)
                .catch(() => undefined)
            }
          />
          {r.documents.length === 0 && (
            <p className="mt-2 text-sm text-fg-muted">
              Attach the delivery challan, the test certificates: kept in the project's documents.
            </p>
          )}
        </Card>
      )}
      {r.mayInspect && (
        <InspectForm
          lines={held}
          busy={busy === 'inspect'}
          onSubmit={(lines) => void call('inspect', 'inspect', { lines })}
        />
      )}
      {r.mayReturn && (
        <ReturnForm
          lines={toReturn}
          busy={busy === 'return'}
          onSubmit={(body) => void call('return', 'returns', body)}
        />
      )}
      {r.returns.length > 0 && (
        <Card title="Returned to the supplier">
          <ul className="space-y-2 text-sm" aria-label="Returns">
            {r.returns.map((t) => (
              <li key={t.id}>
                <span className="font-mono">{t.number}</span> on {shortDate(t.returnedOn)}
                {t.reference && ` (${t.reference})`}: {t.reason}
                <span className="block text-xs text-fg-muted">
                  {t.lines
                    .map((x) => {
                      const l = r.lines.find((g) => g.position === x.position);
                      return `${formatQty(x.qty)} ${l?.unit ?? ''} ${l?.description ?? ''}`;
                    })
                    .join('; ')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function InspectForm({
  lines,
  busy,
  onSubmit,
}: {
  lines: Receipt['lines'];
  busy: boolean;
  onSubmit: (
    lines: { position: number; accepted: string; rejected: string; reason: string }[],
  ) => void;
}) {
  const [v, setV] = useState<
    Record<number, { accepted: string; rejected: string; reason: string }>
  >(() =>
    Object.fromEntries(
      lines.map((l) => [l.position, { accepted: trim(l.qty), rejected: '0', reason: '' }]),
    ),
  );
  const set = (p: number, patch: Partial<{ accepted: string; rejected: string; reason: string }>) =>
    setV({ ...v, [p]: { ...v[p]!, ...patch } });
  return (
    <Card title="Inspection" className="print:hidden">
      <form
        className="space-y-3"
        aria-label="Inspection"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(lines.map((l) => ({ position: l.position, ...v[l.position]! })));
        }}
      >
        <p className="text-sm text-fg-muted">
          What passed and what did not: together, what came. Rejected goods are still owed by the
          supplier, and go back on a return.
        </p>
        {lines.map((l) => {
          const x = v[l.position]!;
          return (
            <div
              key={l.position}
              role="group"
              aria-label={`Inspect ${l.description}`}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="min-w-48 flex-1 pb-2 text-sm">
                {l.description}{' '}
                <span className="text-fg-muted">
                  ({formatQty(l.qty)} {l.unit} came)
                </span>
              </div>
              <Field label="Accepted">
                <Input
                  inputMode="decimal"
                  value={x.accepted}
                  className="w-24"
                  onChange={(e) => set(l.position, { accepted: e.target.value })}
                />
              </Field>
              <Field label="Rejected">
                <Input
                  inputMode="decimal"
                  value={x.rejected}
                  className="w-24"
                  onChange={(e) => set(l.position, { rejected: e.target.value })}
                />
              </Field>
              <div className="min-w-48 flex-1">
                <Field label="Why rejected">
                  <Input
                    value={x.reason}
                    maxLength={1000}
                    onChange={(e) => set(l.position, { reason: e.target.value })}
                  />
                </Field>
              </div>
            </div>
          );
        })}
        <Button type="submit" busy={busy}>
          Record the inspection
        </Button>
      </form>
    </Card>
  );
}

function ReturnForm({
  lines,
  busy,
  onSubmit,
}: {
  lines: Receipt['lines'];
  busy: boolean;
  onSubmit: (body: object) => void;
}) {
  const [returnedOn, setReturnedOn] = useState(today());
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.position, trim(String(Number(l.rejected) - Number(l.returned)))]),
    ),
  );
  return (
    <Card title="Return rejected goods" className="print:hidden">
      <form
        className="space-y-3"
        aria-label="Return to supplier"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            returnedOn,
            reference,
            reason: reason.trim(),
            lines: lines
              .filter((l) => Number(qty[l.position]) > 0)
              .map((l) => ({ position: l.position, qty: qty[l.position]!.trim() })),
          });
        }}
      >
        {lines.map((l) => (
          <div key={l.position} className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1 pb-2 text-sm">
              {l.description}{' '}
              <span className="text-fg-muted">
                ({formatQty(String(Number(l.rejected) - Number(l.returned)))} {l.unit} rejected, not
                yet returned)
              </span>
            </div>
            <Field label={`Return of ${l.description}`}>
              <Input
                inputMode="decimal"
                value={qty[l.position] ?? ''}
                className="w-24"
                onChange={(e) => setQty({ ...qty, [l.position]: e.target.value })}
              />
            </Field>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Returned on">
            <Input
              type="date"
              value={returnedOn}
              max={today()}
              onChange={(e) => setReturnedOn(e.target.value)}
            />
          </Field>
          <Field label="Gate pass or debit note">
            <Input
              value={reference}
              maxLength={200}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          <div className="min-w-56 flex-1">
            <Field label="Why it goes back">
              <Input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        </div>
        <Button type="submit" busy={busy} disabled={reason.trim().length < 3}>
          Return to the supplier
        </Button>
      </form>
    </Card>
  );
}
