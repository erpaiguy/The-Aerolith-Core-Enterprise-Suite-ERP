// One store (docs/wave2b-plan.md step 6): what is in it and what it is worth, each material's ledger, issues to work,
// transfers to other stores, reorder levels and a requisition for the shortfall, and the stock take.
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
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRightLeft, ClipboardList, PackageMinus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { WbsNode } from '../api/types';
import { useRun } from '../approvals/model';
import { formatQty, formatRate } from '../boq/model';
import { describeError } from '../lib/format';
import { rupees } from '../procurement/OrderLines';
import {
  MOVE_KIND,
  today,
  trimZeros,
  type Issue,
  type Move,
  type StockCount,
  type Store,
  type StoreRow,
  type Transfer,
} from '../procurement/inventory';
import { shortDate } from '../schedule/model';

export function StoreScreen({ storeId }: { storeId: string }) {
  const qc = useQueryClient();
  const key = ['store', storeId];
  const s = useQuery({
    queryKey: key,
    queryFn: () => api.request<Store>(`/api/tenant/stores/${storeId}`),
  });
  if (s.isPending) return <Spinner />;
  if (s.isError) return <Alert tone="danger">{describeError(s.error)}</Alert>;
  return (
    <StoreView
      s={s.data}
      refresh={() => {
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: ['stores'] });
      }}
    />
  );
}

function StoreView({ s, refresh }: { s: Store; refresh: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<'issue' | 'transfer' | null>(null);
  const [ledgerOf, setLedgerOf] = useState<string | null>(null);
  const { run, busy, error } = useRun(refresh);
  const inStock = s.stock.filter((x) => Number(x.qty) > 0);
  const below = s.stock.filter((x) => x.below);
  const total = s.stock.reduce((t, x) => t + Number(x.value), 0);
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId: s.project.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {s.project.number} · {s.project.name}
      </Link>
      <PageHeader
        title={s.name}
        subtitle={
          <span>
            At {s.site.name} · {rupees(total.toFixed(2))} in stock ·{' '}
            {s.valuation === 'fifo' ? 'FIFO' : 'weighted average'}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {s.mayIssue && inStock.length > 0 && (
              <Button onClick={() => setForm(form === 'issue' ? null : 'issue')}>
                <PackageMinus className="size-4" aria-hidden /> Issue
              </Button>
            )}
            {s.mayManage && inStock.length > 0 && (
              <Button
                variant="secondary"
                onClick={() => setForm(form === 'transfer' ? null : 'transfer')}
              >
                <ArrowRightLeft className="size-4" aria-hidden /> Transfer
              </Button>
            )}
            {s.openCount ? (
              <Link
                to="/stock-counts/$countId"
                params={{ countId: s.openCount.id }}
                className="inline-flex items-center gap-1 self-center text-sm text-accent hover:underline"
              >
                Stock take {s.openCount.number}
              </Link>
            ) : (
              s.mayManage &&
              s.stock.length > 0 && (
                <Button
                  variant="secondary"
                  busy={busy === 'count'}
                  onClick={() =>
                    void run('count', async () => {
                      const c = await api.request<StockCount>(`/api/tenant/stores/${s.id}/counts`, {
                        method: 'POST',
                        body: {
                          countedOn: today(),
                          lines: s.stock.map((x) => ({
                            resourceId: x.resourceId,
                            counted: trimZeros(x.qty),
                          })),
                        },
                      });
                      await navigate({ to: '/stock-counts/$countId', params: { countId: c.id } });
                    })
                  }
                >
                  <ClipboardList className="size-4" aria-hidden /> Stock take
                </Button>
              )
            )}
          </div>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {form === 'issue' && <IssueForm s={s} onCancel={() => setForm(null)} />}
      {form === 'transfer' && (
        <TransferForm
          s={s}
          onCancel={() => setForm(null)}
          onDone={() => {
            setForm(null);
            refresh();
          }}
        />
      )}
      {s.transfers.length > 0 && (
        <Alert tone="info">
          In transit:{' '}
          {s.transfers.map((t, i) => (
            <span key={t.id}>
              {i > 0 && '; '}
              <Link
                to="/transfers/$transferId"
                params={{ transferId: t.id }}
                className="font-mono text-accent hover:underline"
              >
                {t.number}
              </Link>{' '}
              {t.incoming ? `from ${t.fromStore}` : `to ${t.toStore}`}, sent {shortDate(t.sentOn)}
            </span>
          ))}
        </Alert>
      )}
      <Card
        title="Stock"
        actions={
          s.mayIssue &&
          below.length > 0 && (
            <Button
              variant="secondary"
              busy={busy === 'reorder'}
              onClick={() =>
                void run('reorder', async () => {
                  const r = await api.request<{ id: string }>(
                    `/api/tenant/stores/${s.id}/reorder-requisition`,
                    { method: 'POST', body: {} },
                  );
                  await navigate({
                    to: '/requisitions/$requisitionId',
                    params: { requisitionId: r.id },
                  });
                })
              }
            >
              Requisition for what is short
            </Button>
          )
        }
      >
        {s.stock.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Empty. Goods received against the project&apos;s purchase orders come in here.
          </p>
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Material</th>
                <th className="text-right">In stock</th>
                <th className="text-right">Rate</th>
                <th className="text-right">Value</th>
                <th className="text-right">Reorder at</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="Stock">
              {s.stock.map((x) => (
                <tr key={x.resourceId}>
                  <td>
                    <span className="mr-2 font-mono text-xs">{x.code}</span>
                    {x.name}
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {formatQty(x.qty)} {x.unit}
                    {x.below && (
                      <>
                        {' '}
                        <Badge tone="warning">Below</Badge>
                      </>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{x.rate ? formatRate(x.rate) : '-'}</td>
                  <td className="text-right tabular-nums">{rupees(x.value)}</td>
                  <td className="text-right">
                    {s.mayManage ? (
                      <ReorderInput
                        level={x.reorderLevel}
                        label={`Reorder level of ${x.name}`}
                        onSave={(level) =>
                          void run('level', () =>
                            api.request(`/api/tenant/stores/${s.id}/reorder`, {
                              method: 'POST',
                              body: { resourceId: x.resourceId, level },
                            }),
                          )
                        }
                      />
                    ) : x.reorderLevel ? (
                      formatQty(x.reorderLevel)
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="text-right">
                    <Button
                      variant="ghost"
                      onClick={() => setLedgerOf(ledgerOf === x.resourceId ? null : x.resourceId)}
                    >
                      Ledger
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {ledgerOf && <Ledger storeId={s.id} resourceId={ledgerOf} />}
      {s.moves.length > 0 && (
        <Card title="Recent movements">
          <Moves moves={s.moves} />
        </Card>
      )}
    </div>
  );
}

function ReorderInput({
  level,
  label,
  onSave,
}: {
  level: string | null;
  label: string;
  onSave: (level: string | null) => void;
}) {
  const [v, setV] = useState(level ? trimZeros(level) : '');
  const changed = v.trim() !== (level ? trimZeros(level) : '');
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block w-24">
        <Input
          aria-label={label}
          inputMode="decimal"
          value={v}
          className="text-right"
          onChange={(e) => setV(e.target.value)}
        />
      </span>
      {changed && (
        <Button variant="ghost" onClick={() => onSave(v.trim() ? v.trim() : null)}>
          Set
        </Button>
      )}
    </span>
  );
}

/** Where a movement came from: its document. */
function DocLink({ m }: { m: Move }) {
  const cls = 'font-mono text-accent hover:underline';
  if (m.docType === 'goods_receipt')
    return (
      <Link to="/receipts/$receiptId" params={{ receiptId: m.docId }} className={cls}>
        {m.docNumber}
      </Link>
    );
  if (m.docType === 'stock_issue')
    return (
      <Link to="/issues/$issueId" params={{ issueId: m.docId }} className={cls}>
        {m.docNumber}
      </Link>
    );
  if (m.docType === 'stock_transfer')
    return (
      <Link to="/transfers/$transferId" params={{ transferId: m.docId }} className={cls}>
        {m.docNumber}
      </Link>
    );
  return (
    <Link to="/stock-counts/$countId" params={{ countId: m.docId }} className={cls}>
      {m.docNumber}
    </Link>
  );
}

function Moves({ moves, running = false }: { moves: Move[]; running?: boolean }) {
  return (
    <Table minWidth="44rem">
      <thead>
        <tr>
          <th>Date</th>
          <th>Movement</th>
          {!running && <th>Material</th>}
          <th className="text-right">Quantity</th>
          <th className="text-right">Value</th>
          {running && <th className="text-right">Balance</th>}
          {running && <th className="text-right">Value</th>}
        </tr>
      </thead>
      <tbody aria-label={running ? 'Ledger' : 'Movements'}>
        {moves.map((m) => (
          <tr key={m.id}>
            <td className="whitespace-nowrap tabular-nums">{shortDate(m.movedOn)}</td>
            <td>
              {MOVE_KIND[m.kind]} <DocLink m={m} />
              {m.wbsCode && <span className="text-xs text-fg-muted"> · {m.wbsCode}</span>}
            </td>
            {!running && (
              <td className="text-sm">
                {m.name} <span className="text-fg-muted">{m.unit}</span>
              </td>
            )}
            <td className={`text-right tabular-nums ${Number(m.qty) < 0 ? 'text-fg-muted' : ''}`}>
              {Number(m.qty) > 0 ? '+' : ''}
              {formatQty(m.qty)}
            </td>
            <td className="text-right tabular-nums">{rupees(m.value)}</td>
            {running && (
              <td className="text-right tabular-nums">{formatQty(m.balanceQty ?? '0')}</td>
            )}
            {running && (
              <td className="text-right tabular-nums">{rupees(m.balanceValue ?? '0')}</td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Ledger({ storeId, resourceId }: { storeId: string; resourceId: string }) {
  const l = useQuery({
    queryKey: ['stock-ledger', storeId, resourceId],
    queryFn: () =>
      api.request<{ resource: { code: string; name: string; unit: string }; moves: Move[] }>(
        `/api/tenant/stores/${storeId}/ledger/${resourceId}`,
      ),
  });
  if (!l.data) return <Spinner />;
  return (
    <Card
      title={`Ledger: ${l.data.resource.code} ${l.data.resource.name} (${l.data.resource.unit})`}
    >
      <Moves moves={l.data.moves} running />
    </Card>
  );
}

function IssueForm({ s, onCancel }: { s: Store; onCancel: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wbs = useQuery({
    queryKey: ['wbs', s.project.id],
    queryFn: () => api.request<WbsNode[]>(`/api/tenant/projects/${s.project.id}/wbs`),
  });
  const [head, setHead] = useState({ issuedOn: today(), wbsCode: '', issuedTo: '', purpose: '' });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [boq, setBoq] = useState<Record<string, string>>({});
  const { run, busy, error } = useRun(() => undefined);
  const inStock = s.stock.filter((x) => Number(x.qty) > 0);
  const lines = inStock.filter((x) => Number(qty[x.resourceId]) > 0);
  return (
    <Card title="Issue to work">
      <form
        className="space-y-3"
        aria-label="Issue"
        onSubmit={(e) => {
          e.preventDefault();
          void run('issue', async () => {
            const i = await api.request<Issue>(`/api/tenant/stores/${s.id}/issues`, {
              method: 'POST',
              body: {
                ...head,
                lines: lines.map((x) => ({
                  resourceId: x.resourceId,
                  qty: qty[x.resourceId]!.trim(),
                  boqCode: boq[x.resourceId]?.trim() || null,
                })),
              },
            });
            void qc.invalidateQueries({ queryKey: ['store', s.id] });
            await navigate({ to: '/issues/$issueId', params: { issueId: i.id } });
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Issued on">
            <Input
              type="date"
              value={head.issuedOn}
              max={today()}
              onChange={(e) => setHead({ ...head, issuedOn: e.target.value })}
            />
          </Field>
          <div className="w-64">
            <Field label="For (WBS element)">
              <Select
                value={head.wbsCode}
                onChange={(e) => setHead({ ...head, wbsCode: e.target.value })}
              >
                <option value="">Choose</option>
                {wbs.data?.map((w) => (
                  <option key={w.id} value={w.code}>
                    {' '.repeat(w.depth * 2)}
                    {w.code} {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Taken by">
            <Input
              value={head.issuedTo}
              maxLength={200}
              onChange={(e) => setHead({ ...head, issuedTo: e.target.value })}
            />
          </Field>
          <div className="min-w-56 flex-1">
            <Field label="Purpose">
              <Input
                value={head.purpose}
                maxLength={1000}
                onChange={(e) => setHead({ ...head, purpose: e.target.value })}
              />
            </Field>
          </div>
        </div>
        {wbs.data?.length === 0 && (
          <Alert tone="warning">
            The project has no WBS yet: set it up on the project&apos;s page to issue against it.
          </Alert>
        )}
        {inStock.map((x) => (
          <div
            key={x.resourceId}
            role="group"
            aria-label={`Issue ${x.name}`}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-48 flex-1 pb-2 text-sm">
              {x.name}{' '}
              <span className="text-fg-muted">
                ({formatQty(x.qty)} {x.unit} in stock)
              </span>
            </div>
            <Field label="Quantity">
              <Input
                inputMode="decimal"
                value={qty[x.resourceId] ?? ''}
                className="w-24"
                onChange={(e) => setQty({ ...qty, [x.resourceId]: e.target.value })}
              />
            </Field>
            <Field label="BOQ item">
              <Input
                value={boq[x.resourceId] ?? ''}
                maxLength={40}
                className="w-24"
                onChange={(e) => setBoq({ ...boq, [x.resourceId]: e.target.value })}
              />
            </Field>
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            type="submit"
            busy={busy === 'issue'}
            disabled={!head.wbsCode || !head.issuedTo.trim() || lines.length === 0}
          >
            Issue
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Card>
  );
}

function TransferForm({
  s,
  onCancel,
  onDone,
}: {
  s: Store;
  onCancel: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const stores = useQuery({
    queryKey: ['stores', 'all'],
    queryFn: () => api.request<StoreRow[]>('/api/tenant/stores'),
  });
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const { run, busy, error } = useRun(onDone);
  const inStock = s.stock.filter((x) => Number(x.qty) > 0);
  const lines = inStock.filter((x) => Number(qty[x.resourceId]) > 0);
  return (
    <Card title="Transfer to another store">
      <form
        className="space-y-3"
        aria-label="Transfer"
        onSubmit={(e) => {
          e.preventDefault();
          void run('send', async () => {
            const t = await api.request<Transfer>(`/api/tenant/stores/${s.id}/transfers`, {
              method: 'POST',
              body: {
                toStoreId: to,
                sentOn: today(),
                note,
                lines: lines.map((x) => ({
                  resourceId: x.resourceId,
                  qty: qty[x.resourceId]!.trim(),
                })),
              },
            });
            await navigate({ to: '/transfers/$transferId', params: { transferId: t.id } });
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-80">
            <Field label="To">
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose a store</option>
                {stores.data
                  ?.filter((x) => x.id !== s.id && x.active)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} ({x.project.number})
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className="min-w-56 flex-1">
            <Field label="Note">
              <Input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
        </div>
        {inStock.map((x) => (
          <div key={x.resourceId} className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1 pb-2 text-sm">
              {x.name}{' '}
              <span className="text-fg-muted">
                ({formatQty(x.qty)} {x.unit} in stock)
              </span>
            </div>
            <Field label={`Send ${x.name}`}>
              <Input
                inputMode="decimal"
                value={qty[x.resourceId] ?? ''}
                className="w-24"
                onChange={(e) => setQty({ ...qty, [x.resourceId]: e.target.value })}
              />
            </Field>
          </div>
        ))}
        <div className="flex gap-2">
          <Button type="submit" busy={busy === 'send'} disabled={!to || lines.length === 0}>
            Send
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Card>
  );
}
