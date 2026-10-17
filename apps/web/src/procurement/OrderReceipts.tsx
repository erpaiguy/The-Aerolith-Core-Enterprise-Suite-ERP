// What has come against a purchase order (docs/wave2b-plan.md step 5): line by line, accepted, on hold, rejected and
// still owed; its receipts; and a new receipt, with what was rejected at the gate or held for inspection.
import { Alert, Badge, Button, Card, Field, Input, Select, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { PackageCheck } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { sendOrKeep } from '../offline';
import type { ProjectDetail } from '../api/types';
import { useRun } from '../approvals/model';
import { formatQty } from '../boq/model';
import { shortDate } from '../schedule/model';
import type { StoreRow } from './inventory';
import type { Order, Receipt } from './orders';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const trim = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

export function OrderReceipts({ o }: { o: Order }) {
  const [receiving, setReceiving] = useState(false);
  const owed = o.progress.some((l) => Number(l.outstanding) > 0);
  return (
    <Card
      title="Receipts"
      className="print:hidden"
      actions={
        o.mayReceive &&
        owed &&
        !receiving && (
          <Button variant="secondary" onClick={() => setReceiving(true)}>
            <PackageCheck className="size-4" aria-hidden /> Receive goods
          </Button>
        )
      }
    >
      <Table minWidth="40rem">
        <thead>
          <tr>
            <th>Line</th>
            <th className="text-right">Ordered</th>
            <th className="text-right">Accepted</th>
            <th className="text-right">On hold</th>
            <th className="text-right">Rejected</th>
            <th className="text-right">Still owed</th>
          </tr>
        </thead>
        <tbody aria-label="Received against the order">
          {o.progress.map((l) => (
            <tr key={l.lineKey}>
              <td>{l.description}</td>
              <td className="whitespace-nowrap text-right tabular-nums">
                {formatQty(l.ordered)} {l.unit}
              </td>
              <td className="text-right tabular-nums">{formatQty(l.accepted)}</td>
              <td className="text-right tabular-nums">
                {Number(l.onHold) > 0 ? (
                  <span className="text-warning">{formatQty(l.onHold)}</span>
                ) : (
                  '-'
                )}
              </td>
              <td className="text-right tabular-nums">
                {Number(l.rejected) > 0 ? (
                  <>
                    {formatQty(l.rejected)}
                    <span className="block text-xs text-fg-muted">
                      {Number(l.returned) >= Number(l.rejected)
                        ? 'returned'
                        : `${formatQty(String(Number(l.rejected) - Number(l.returned)))} to return`}
                    </span>
                  </>
                ) : (
                  '-'
                )}
              </td>
              <td className="text-right font-medium tabular-nums">
                {Number(l.outstanding) > 0 ? formatQty(l.outstanding) : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {receiving && <ReceiveForm o={o} onCancel={() => setReceiving(false)} />}
      {o.receipts.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm" aria-label="Receipts of the order">
          {o.receipts.map((r) => (
            <li key={r.id}>
              <Link
                to="/receipts/$receiptId"
                params={{ receiptId: r.id }}
                className="font-mono text-accent hover:underline"
              >
                {r.number}
              </Link>{' '}
              {shortDate(r.receivedOn)}, challan {r.challanNo}
              {r.status === 'cancelled' && (
                <>
                  {' '}
                  <Badge>Cancelled</Badge>
                </>
              )}
              {r.status === 'posted' && r.held > 0 && (
                <>
                  {' '}
                  <Badge tone="warning">{r.held} held for inspection</Badge>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {o.receipts.length === 0 && !receiving && (
        <p className="mt-3 text-sm text-fg-muted">Nothing received yet.</p>
      )}
    </Card>
  );
}

interface LineIn {
  qty: string;
  rejected: string;
  reason: string;
  hold: boolean;
}

function ReceiveForm({ o, onCancel }: { o: Order; onCancel: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const project = useQuery({
    queryKey: ['project', o.project.id],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${o.project.id}`),
  });
  const stores = useQuery({
    queryKey: ['stores', 'project', o.project.id],
    queryFn: () => api.request<StoreRow[]>(`/api/tenant/stores?projectId=${o.project.id}`),
  });
  const owed = o.progress.filter((l) => Number(l.outstanding) > 0);
  const [head, setHead] = useState({
    receivedOn: today(),
    siteId: o.inForce?.site?.id ?? '',
    storeId: '',
    challanNo: '',
    challanDate: '',
    vehicleNo: '',
    transporter: '',
    ewayBillNo: '',
    invoiceNo: '',
  });
  const [lines, setLines] = useState<Record<string, LineIn>>(() =>
    Object.fromEntries(
      owed.map((l) => [l.lineKey, { qty: '', rejected: '', reason: '', hold: false }]),
    ),
  );
  const set = (k: string, patch: Partial<LineIn>) =>
    setLines({ ...lines, [k]: { ...lines[k]!, ...patch } });
  const { run, busy, error } = useRun(() => undefined);
  const [queued, setQueued] = useState(false);
  const chosen = owed.filter((l) => Number(lines[l.lineKey]?.qty) > 0);
  const siteStores = (stores.data ?? []).filter((s) => s.active && s.site.id === head.siteId);
  return (
    <form
      className="mt-4 space-y-4 rounded-md border border-line p-3"
      aria-label="Receive goods"
      onSubmit={(e) => {
        e.preventDefault();
        void run('receive', async () => {
          const sent = await sendOrKeep<Receipt>(
            `Goods receipt for ${o.number}, challan ${head.challanNo.trim()}`,
            `/api/tenant/orders/${o.id}/receipts`,
            {
              receivedOn: head.receivedOn,
              siteId: head.siteId || null,
              storeId: head.storeId || null,
              challanNo: head.challanNo.trim(),
              challanDate: head.challanDate || null,
              vehicleNo: head.vehicleNo,
              transporter: head.transporter,
              ewayBillNo: head.ewayBillNo,
              invoiceNo: head.invoiceNo,
              lines: chosen.map((l) => {
                const x = lines[l.lineKey]!;
                return {
                  lineKey: l.lineKey,
                  qty: x.qty.trim(),
                  hold: x.hold,
                  rejected: x.hold ? '0' : x.rejected.trim() || '0',
                  reason: x.reason,
                };
              }),
            },
          );
          if (sent.queued) {
            setQueued(true);
            return;
          }
          void qc.invalidateQueries({ queryKey: ['order', o.id] });
          void qc.invalidateQueries({ queryKey: ['receipts'] });
          await navigate({ to: '/receipts/$receiptId', params: { receiptId: sent.result.id } });
        });
      }}
    >
      {queued && (
        <Alert tone="warning">
          <span data-testid="receipt-queued">
            Saved on this phone; it will be sent when there is signal (see the Outbox).
          </span>
        </Alert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Received on">
          <Input
            type="date"
            value={head.receivedOn}
            max={today()}
            onChange={(e) => setHead({ ...head, receivedOn: e.target.value })}
          />
        </Field>
        <div className="w-44">
          <Field label="At site">
            <Select
              value={head.siteId}
              onChange={(e) => setHead({ ...head, siteId: e.target.value, storeId: '' })}
            >
              <option value="">Not said</option>
              {project.data?.sites
                .filter((s) => s.active || s.id === head.siteId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        {siteStores.length > 1 && (
          <div className="w-44">
            <Field label="Into store">
              <Select
                value={head.storeId}
                onChange={(e) => setHead({ ...head, storeId: e.target.value })}
              >
                <option value="">Choose</option>
                {siteStores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Field label="Challan no.">
          <Input
            value={head.challanNo}
            maxLength={100}
            className="w-36"
            onChange={(e) => setHead({ ...head, challanNo: e.target.value })}
          />
        </Field>
        <Field label="Challan date">
          <Input
            type="date"
            value={head.challanDate}
            onChange={(e) => setHead({ ...head, challanDate: e.target.value })}
          />
        </Field>
        <Field label="Vehicle no.">
          <Input
            value={head.vehicleNo}
            maxLength={30}
            className="w-32"
            onChange={(e) => setHead({ ...head, vehicleNo: e.target.value })}
          />
        </Field>
        <Field label="Transporter">
          <Input
            value={head.transporter}
            maxLength={200}
            onChange={(e) => setHead({ ...head, transporter: e.target.value })}
          />
        </Field>
        <Field label="E-way bill no.">
          <Input
            value={head.ewayBillNo}
            inputMode="numeric"
            pattern="\d{12}"
            title="12 digits"
            className="w-36"
            onChange={(e) => setHead({ ...head, ewayBillNo: e.target.value })}
          />
        </Field>
        <Field label="Invoice no.">
          <Input
            value={head.invoiceNo}
            maxLength={100}
            className="w-32"
            onChange={(e) => setHead({ ...head, invoiceNo: e.target.value })}
          />
        </Field>
      </div>
      <div className="space-y-3">
        {owed.map((l) => {
          const x = lines[l.lineKey]!;
          return (
            <div
              key={l.lineKey}
              role="group"
              aria-label={l.description}
              className="flex flex-wrap items-end gap-2 border-b border-line pb-3"
            >
              <div className="min-w-48 flex-1 pb-2 text-sm">
                {l.description}
                <span className="block text-xs text-fg-muted">
                  {formatQty(l.outstanding)} {l.unit} still owed
                </span>
              </div>
              <Field label="Came">
                <Input
                  inputMode="decimal"
                  value={x.qty}
                  className="w-24"
                  onChange={(e) => set(l.lineKey, { qty: e.target.value })}
                />
              </Field>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={x.hold}
                  onChange={(e) => set(l.lineKey, { hold: e.target.checked })}
                />
                Hold for inspection
              </label>
              {!x.hold && (
                <>
                  <Field label="Rejected at the gate">
                    <Input
                      inputMode="decimal"
                      value={x.rejected}
                      className="w-24"
                      onChange={(e) => set(l.lineKey, { rejected: e.target.value })}
                    />
                  </Field>
                  {Number(x.rejected) > 0 && (
                    <div className="min-w-48 flex-1">
                      <Field label="Why rejected">
                        <Input
                          value={x.reason}
                          maxLength={1000}
                          onChange={(e) => set(l.lineKey, { reason: e.target.value })}
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          busy={busy === 'receive'}
          disabled={!head.challanNo.trim() || chosen.length === 0}
        >
          Record the receipt
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setLines(
              Object.fromEntries(
                owed.map((l) => [l.lineKey, { ...lines[l.lineKey]!, qty: trim(l.outstanding) }]),
              ),
            )
          }
        >
          Everything still owed
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}
