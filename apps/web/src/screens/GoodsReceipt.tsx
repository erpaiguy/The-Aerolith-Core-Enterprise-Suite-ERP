// A goods receipt (docs/wave2b-plan.md step 5): what came against a purchase order, on which challan, at which site;
// each line accepted at the gate or held for inspection; the held ones inspected; the rejected ones returned to the
// supplier. Cancelled (with a reason) when made in error, unless something from it already went back.
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
import { useRun } from '../approvals/model';
import { formatQty } from '../boq/model';
import { LinkedDocuments } from '../documents/LinkedDocuments';
import { describeError } from '../lib/format';
import { useT } from '../i18n/i18n';
import type { Inspection, Receipt } from '../procurement/orders';
import { shortDate } from '../schedule/model';
import { printLink } from '../print/Letterhead';
import { PurchaseFlow } from './shell/FlowStrip';

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
  const t = useT();
  const confirm = useConfirm();
  const { run, busy, error } = useRun(() => undefined);
  const call = (k: string, path: string, body: object, done: string) =>
    run(k, async () =>
      onChanged(
        await api.request<Receipt>(`/api/tenant/receipts/${r.id}/${path}`, {
          method: 'POST',
          body,
        }),
      ),
    ).then((ok) => ok && toast.success(done));
  const held = r.lines.filter((l) => l.inspection === 'hold');
  const toReturn = r.lines.filter((l) => Number(l.rejected) > Number(l.returned));
  return (
    <div className="space-y-5">
      <Link
        to="/orders/$orderId"
        params={{ orderId: r.order.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden />{' '}
        {t('Purchase order {n}', { n: r.order.number })}
      </Link>
      <PageHeader
        title={t('Goods receipt {n}', { n: r.number })}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {r.status === 'cancelled' ? (
              <Badge tone="danger">{t('Cancelled')}</Badge>
            ) : held.length ? (
              <Badge tone="warning">{t('{n} held for inspection', { n: held.length })}</Badge>
            ) : (
              <Badge tone="success">{t('Received')}</Badge>
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
              <Printer className="size-4" aria-hidden /> {t('Print')}
            </Link>
            {r.mayCancel && (
              <Button
                variant="ghost"
                busy={busy === 'cancel'}
                onClick={() => {
                  const reason = window.prompt(t('Why is the receipt cancelled?'));
                  if (reason && reason.trim().length >= 3)
                    void call(
                      'cancel',
                      'cancel',
                      { reason: reason.trim() },
                      t('Receipt {n} cancelled', { n: r.number }),
                    );
                }}
              >
                {t('Cancel receipt')}
              </Button>
            )}
          </div>
        }
      />
      <PurchaseFlow kind="receipt" id={r.id} stamp={`${r.rowVersion}-${r.status}`} />
      {r.status === 'cancelled' && r.statusReason && (
        <Alert tone="info">
          {t('Cancelled: {reason}. What it recorded is owed again on the order.', {
            reason: r.statusReason,
          })}
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">{t('Received')}</dt>
          <dd>
            {shortDate(r.receivedOn)}
            {r.site && ` ${t('at {site}', { site: r.site.name })}`}
            {r.store && (
              <>
                {`, ${t('into')} `}
                <Link
                  to="/stores/$storeId"
                  params={{ storeId: r.store.id }}
                  className="text-accent hover:underline"
                >
                  {r.store.name}
                </Link>
              </>
            )}
            {r.receivedBy && `, ${t('by {name}', { name: r.receivedBy })}`}
          </dd>
          <dt className="text-fg-muted">{t('Challan')}</dt>
          <dd>
            {r.challanNo}
            {r.challanDate && ` ${t('of {date}', { date: shortDate(r.challanDate) })}`}
          </dd>
          {r.vehicleNo && (
            <>
              <dt className="text-fg-muted">{t('Vehicle')}</dt>
              <dd>{r.vehicleNo}</dd>
            </>
          )}
          {r.invoiceNo && (
            <>
              <dt className="text-fg-muted">{t('Invoice')}</dt>
              <dd>{r.invoiceNo}</dd>
            </>
          )}
          {r.notes && (
            <>
              <dt className="text-fg-muted">{t('Notes')}</dt>
              <dd className="whitespace-pre-wrap">{r.notes}</dd>
            </>
          )}
        </dl>
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th className="w-8">#</th>
              <th>{t('Description')}</th>
              <th className="text-right">{t('Came')}</th>
              <th>{t('Inspection')}</th>
              <th className="text-right">{t('Accepted')}</th>
              <th className="text-right">{t('Rejected')}</th>
              <th className="text-right">{t('Returned')}</th>
            </tr>
          </thead>
          <tbody aria-label={t('Receipt lines')}>
            {r.lines.map((l) => (
              <tr key={l.position}>
                <td className="tabular-nums text-fg-muted">{l.position}</td>
                <td>
                  {l.description}
                  {!l.stocked && (
                    <span className="block text-xs text-fg-muted">
                      {t('Typed in, not from the library: not stocked')}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {formatQty(l.qty)} {l.unit}
                </td>
                <td>
                  {l.inspection === 'hold' ? (
                    <Badge tone="warning">{t(INSPECTION[l.inspection])}</Badge>
                  ) : (
                    <span className="text-sm">{t(INSPECTION[l.inspection])}</span>
                  )}
                  {l.inspectedBy && (
                    <span className="block text-xs text-fg-muted">
                      {t('by {name}', { name: l.inspectedBy })}
                    </span>
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
        <Card title={t('Challan and certificates')}>
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
              {t(
                "Attach the delivery challan, the test certificates: kept in the project's documents.",
              )}
            </p>
          )}
        </Card>
      )}
      {r.mayInspect && (
        <InspectForm
          lines={held}
          busy={busy === 'inspect'}
          onSubmit={(lines) => void call('inspect', 'inspect', { lines }, t('Inspection recorded'))}
        />
      )}
      {r.mayReturn && (
        <ReturnForm
          lines={toReturn}
          busy={busy === 'return'}
          onSubmit={async (body) => {
            if (
              !(await confirm({
                title: t('Return the goods to {vendor}?', { vendor: r.vendor.name }),
                body: t(
                  'A return note is made against this receipt and the order owes them again.',
                ),
                confirmLabel: t('Return the goods'),
                cancelLabel: t('Keep it'),
                tone: 'danger',
              }))
            )
              return;
            await call('return', 'returns', body, t('Goods returned to the supplier'));
          }}
        />
      )}
      {r.returns.length > 0 && (
        <Card title={t('Returned to the supplier')}>
          <ul className="space-y-2 text-sm" aria-label={t('Returns')}>
            {r.returns.map((ret) => (
              <li key={ret.id}>
                <span className="font-mono">{ret.number}</span>{' '}
                {t('on {date}', { date: shortDate(ret.returnedOn) })}
                {ret.reference && ` (${ret.reference})`}: {ret.reason}
                <span className="block text-xs text-fg-muted">
                  {ret.lines
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
  const t = useT();
  return (
    <Card title={t('Inspection')} className="print:hidden">
      <form
        className="space-y-3"
        aria-label={t('Inspection')}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(lines.map((l) => ({ position: l.position, ...v[l.position]! })));
        }}
      >
        <p className="text-sm text-fg-muted">
          {t(
            'What passed and what did not: together, what came. Rejected goods are still owed by the supplier, and go back on a return.',
          )}
        </p>
        {lines.map((l) => {
          const x = v[l.position]!;
          return (
            <div
              key={l.position}
              role="group"
              aria-label={t('Inspect {name}', { name: l.description })}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="min-w-48 flex-1 pb-2 text-sm">
                {l.description}{' '}
                <span className="text-fg-muted">
                  {t('({qty} {unit} came)', { qty: formatQty(l.qty), unit: l.unit })}
                </span>
              </div>
              <Field label={t('Accepted')}>
                <Input
                  inputMode="decimal"
                  value={x.accepted}
                  className="w-24"
                  onChange={(e) => set(l.position, { accepted: e.target.value })}
                />
              </Field>
              <Field label={t('Rejected')}>
                <Input
                  inputMode="decimal"
                  value={x.rejected}
                  className="w-24"
                  onChange={(e) => set(l.position, { rejected: e.target.value })}
                />
              </Field>
              <div className="min-w-48 flex-1">
                <Field label={t('Why rejected')}>
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
          {t('Record the inspection')}
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
  const t = useT();
  const [returnedOn, setReturnedOn] = useState(today());
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.position, trim(String(Number(l.rejected) - Number(l.returned)))]),
    ),
  );
  return (
    <Card title={t('Return rejected goods')} className="print:hidden">
      <form
        className="space-y-3"
        aria-label={t('Return to supplier')}
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
                {t('({qty} {unit} rejected, not yet returned)', {
                  qty: formatQty(String(Number(l.rejected) - Number(l.returned))),
                  unit: l.unit,
                })}
              </span>
            </div>
            <Field label={t('Return of {name}', { name: l.description })}>
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
          <Field label={t('Returned on')}>
            <Input
              type="date"
              value={returnedOn}
              max={today()}
              onChange={(e) => setReturnedOn(e.target.value)}
            />
          </Field>
          <Field label={t('Gate pass or debit note')}>
            <Input
              value={reference}
              maxLength={200}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          <div className="min-w-56 flex-1">
            <Field label={t('Why it goes back')}>
              <Input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        </div>
        <Button type="submit" busy={busy} disabled={reason.trim().length < 3}>
          {t('Return to the supplier')}
        </Button>
      </form>
    </Card>
  );
}
