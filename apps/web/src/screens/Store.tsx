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
import { sendOrKeep } from '../offline';
import { formatQty, formatRate } from '../boq/model';
import { describeError } from '../lib/format';
import { useT } from '../i18n/i18n';
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
import type { OrderRow } from '../procurement/orders';
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
  const t = useT();
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
            {t('At {site} · {value} in stock · {method}', {
              site: s.site.name,
              value: rupees(total.toFixed(2)),
              method: s.valuation === 'fifo' ? 'FIFO' : t('weighted average'),
            })}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {s.mayIssue && inStock.length > 0 && (
              <Button onClick={() => setForm(form === 'issue' ? null : 'issue')}>
                <PackageMinus className="size-4" aria-hidden /> {t('Issue@@material')}
              </Button>
            )}
            {s.mayManage && inStock.length > 0 && (
              <Button
                variant="secondary"
                onClick={() => setForm(form === 'transfer' ? null : 'transfer')}
              >
                <ArrowRightLeft className="size-4" aria-hidden /> {t('Transfer')}
              </Button>
            )}
            {s.openCount ? (
              <Link
                to="/stock-counts/$countId"
                params={{ countId: s.openCount.id }}
                className="inline-flex items-center gap-1 self-center text-sm text-accent hover:underline"
              >
                {t('Stock take {n}', { n: s.openCount.number })}
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
                  <ClipboardList className="size-4" aria-hidden /> {t('Stock take')}
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
          {t('In transit:')}{' '}
          {s.transfers.map((tr, i) => (
            <span key={tr.id}>
              {i > 0 && '; '}
              <Link
                to="/transfers/$transferId"
                params={{ transferId: tr.id }}
                className="font-mono text-accent hover:underline"
              >
                {tr.number}
              </Link>{' '}
              {tr.incoming
                ? t('from {store}', { store: tr.fromStore })
                : t('to {store}', { store: tr.toStore })}
              , {t('sent {date}', { date: shortDate(tr.sentOn) })}
            </span>
          ))}
        </Alert>
      )}
      <Card
        title={t('Stock')}
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
              {t('Requisition for what is short')}
            </Button>
          )
        }
      >
        {s.stock.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {t("Empty. Goods received against the project's purchase orders come in here.")}
          </p>
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>{t('Material')}</th>
                <th className="text-right">{t('In stock')}</th>
                <th className="text-right">{t('Rate')}</th>
                <th className="text-right">{t('Value')}</th>
                <th className="text-right">{t('Reorder at')}</th>
                <th className="text-right">{t('Fill up to')}</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label={t('Stock')}>
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
                        <Badge tone="warning">{t('Below')}</Badge>
                      </>
                    )}
                    {x.above && (
                      <>
                        {' '}
                        <Badge tone="neutral">{t('Over the maximum')}</Badge>
                      </>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{x.rate ? formatRate(x.rate) : '-'}</td>
                  <td className="text-right tabular-nums">{rupees(x.value)}</td>
                  <td className="text-right">
                    {s.mayManage ? (
                      <ReorderInput
                        level={x.reorderLevel}
                        label={t('Reorder level of {name}', { name: x.name })}
                        onSave={(level) =>
                          void run('level', () =>
                            api.request(`/api/tenant/stores/${s.id}/reorder`, {
                              method: 'POST',
                              body: {
                                resourceId: x.resourceId,
                                level,
                                max: level ? x.maxLevel : null,
                              },
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
                    {s.mayManage && x.reorderLevel ? (
                      <ReorderInput
                        level={x.maxLevel}
                        label={t('Maximum of {name}', { name: x.name })}
                        onSave={(max) =>
                          void run('level', () =>
                            api.request(`/api/tenant/stores/${s.id}/reorder`, {
                              method: 'POST',
                              body: { resourceId: x.resourceId, level: x.reorderLevel, max },
                            }),
                          )
                        }
                      />
                    ) : x.maxLevel ? (
                      formatQty(x.maxLevel)
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="text-right">
                    <Button
                      variant="ghost"
                      onClick={() => setLedgerOf(ledgerOf === x.resourceId ? null : x.resourceId)}
                    >
                      {t('Ledger')}
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
        <Card title={t('Recent movements')}>
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
  const t = useT();
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
          {t('Set')}
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
  const t = useT();
  return (
    <Table minWidth="44rem">
      <thead>
        <tr>
          <th>{t('Date')}</th>
          <th>{t('Movement')}</th>
          {!running && <th>{t('Material')}</th>}
          <th className="text-right">{t('Quantity')}</th>
          <th className="text-right">{t('Value')}</th>
          {running && <th className="text-right">{t('Balance')}</th>}
          {running && <th className="text-right">{t('Value')}</th>}
        </tr>
      </thead>
      <tbody aria-label={running ? t('Ledger') : t('Movements')}>
        {moves.map((m) => (
          <tr key={m.id}>
            <td className="whitespace-nowrap tabular-nums">{shortDate(m.movedOn)}</td>
            <td>
              {t(MOVE_KIND[m.kind])} <DocLink m={m} />
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
  const t = useT();
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
      title={t('Ledger: {code} {name} ({unit})', {
        code: l.data.resource.code,
        name: l.data.resource.name,
        unit: l.data.resource.unit,
      })}
    >
      <Moves moves={l.data.moves} running />
    </Card>
  );
}

function IssueForm({ s, onCancel }: { s: Store; onCancel: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wbs = useQuery({
    queryKey: ['wbs', s.project.id],
    queryFn: () => api.request<WbsNode[]>(`/api/tenant/projects/${s.project.id}/wbs`),
  });
  // A subcontractor's work order the material goes against, for recovering what goes beyond its norm (step 8a.3).
  const workOrders = useQuery({
    queryKey: ['orders', s.project.id, 'open'],
    queryFn: () =>
      api.request<OrderRow[]>(`/api/tenant/orders?status=open&projectId=${s.project.id}`),
    select: (rows) =>
      rows.filter(
        (o) => o.kind === 'work' && (o.status === 'issued' || o.status === 'acknowledged'),
      ),
  });
  const [head, setHead] = useState({
    issuedOn: today(),
    wbsCode: '',
    issuedTo: '',
    purpose: '',
    orderId: '',
  });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [boq, setBoq] = useState<Record<string, string>>({});
  const [queued, setQueued] = useState(false);
  const { run, busy, error } = useRun(() => undefined);
  const inStock = s.stock.filter((x) => Number(x.qty) > 0);
  const lines = inStock.filter((x) => Number(qty[x.resourceId]) > 0);
  return (
    <Card title={t('Issue to work')}>
      <form
        className="space-y-3"
        aria-label={t('Issue@@material')}
        onSubmit={(e) => {
          e.preventDefault();
          void run('issue', async () => {
            const sent = await sendOrKeep<Issue>(
              `Issue from ${s.name} on ${head.issuedOn}`,
              `/api/tenant/stores/${s.id}/issues`,
              {
                ...head,
                orderId: head.orderId || null,
                lines: lines.map((x) => ({
                  resourceId: x.resourceId,
                  qty: qty[x.resourceId]!.trim(),
                  boqCode: boq[x.resourceId]?.trim() || null,
                })),
              },
            );
            if (sent.queued) {
              setQueued(true);
              setQty({});
              return;
            }
            void qc.invalidateQueries({ queryKey: ['store', s.id] });
            await navigate({ to: '/issues/$issueId', params: { issueId: sent.result.id } });
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('Issued on')}>
            <Input
              type="date"
              value={head.issuedOn}
              max={today()}
              onChange={(e) => setHead({ ...head, issuedOn: e.target.value })}
            />
          </Field>
          <div className="w-64">
            <Field label={t('For (WBS element)')}>
              <Select
                value={head.wbsCode}
                onChange={(e) => setHead({ ...head, wbsCode: e.target.value })}
              >
                <option value="">{t('Choose')}</option>
                {wbs.data?.map((w) => (
                  <option key={w.id} value={w.code}>
                    {' '.repeat(w.depth * 2)}
                    {w.code} {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {workOrders.data?.length ? (
            <Field label={t('Against work order')}>
              <Select
                value={head.orderId}
                onChange={(e) => {
                  const o = workOrders.data!.find((x) => x.id === e.target.value);
                  setHead({
                    ...head,
                    orderId: e.target.value,
                    issuedTo: o && !head.issuedTo ? o.vendor : head.issuedTo,
                  });
                }}
              >
                <option value="">{t('None (our own work)')}</option>
                {workOrders.data.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number} {o.vendor}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label={t('Taken by')}>
            <Input
              value={head.issuedTo}
              maxLength={200}
              onChange={(e) => setHead({ ...head, issuedTo: e.target.value })}
            />
          </Field>
          <div className="min-w-56 flex-1">
            <Field label={t('Purpose')}>
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
            {t("The project has no WBS yet: set it up on the project's page to issue against it.")}
          </Alert>
        )}
        {inStock.map((x) => (
          <div
            key={x.resourceId}
            role="group"
            aria-label={t('Issue {name}', { name: x.name })}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-48 flex-1 pb-2 text-sm">
              {x.name}{' '}
              <span className="text-fg-muted">
                {t('({qty} {unit} in stock)', { qty: formatQty(x.qty), unit: x.unit })}
              </span>
            </div>
            <Field label={t('Quantity')}>
              <Input
                inputMode="decimal"
                value={qty[x.resourceId] ?? ''}
                className="w-24"
                onChange={(e) => setQty({ ...qty, [x.resourceId]: e.target.value })}
              />
            </Field>
            <Field label={t('BOQ item')}>
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
            {t('Issue@@material')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('Cancel')}
          </Button>
        </div>
        {queued && (
          <Alert tone="warning">
            <span data-testid="issue-queued">
              {t('Saved on this phone; it will be sent when there is signal (see the Outbox).')}
            </span>
          </Alert>
        )}
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
  const t = useT();
  const navigate = useNavigate();
  const stores = useQuery({
    queryKey: ['stores', 'all'],
    queryFn: () => api.request<StoreRow[]>('/api/tenant/stores'),
  });
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [carrier, setCarrier] = useState({ vehicleNo: '', transporter: '', ewayBillNo: '' });
  const [qty, setQty] = useState<Record<string, string>>({});
  const { run, busy, error } = useRun(onDone);
  const inStock = s.stock.filter((x) => Number(x.qty) > 0);
  const lines = inStock.filter((x) => Number(qty[x.resourceId]) > 0);
  return (
    <Card title={t('Transfer to another store')}>
      <form
        className="space-y-3"
        aria-label={t('Transfer')}
        onSubmit={(e) => {
          e.preventDefault();
          void run('send', async () => {
            const t = await api.request<Transfer>(`/api/tenant/stores/${s.id}/transfers`, {
              method: 'POST',
              body: {
                toStoreId: to,
                sentOn: today(),
                note,
                vehicleNo: carrier.vehicleNo.trim() || null,
                transporter: carrier.transporter.trim() || null,
                ewayBillNo: carrier.ewayBillNo.trim(),
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
            <Field label={t('To@@destination')}>
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">{t('Choose a store')}</option>
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
          <Field label={t('Vehicle no.')}>
            <Input
              value={carrier.vehicleNo}
              maxLength={30}
              className="w-32"
              onChange={(e) => setCarrier({ ...carrier, vehicleNo: e.target.value })}
            />
          </Field>
          <Field label={t('Transporter')}>
            <Input
              value={carrier.transporter}
              maxLength={200}
              onChange={(e) => setCarrier({ ...carrier, transporter: e.target.value })}
            />
          </Field>
          <Field label={t('E-way bill no.')}>
            <Input
              value={carrier.ewayBillNo}
              inputMode="numeric"
              pattern="\d{12}"
              title={t('12 digits')}
              className="w-36"
              onChange={(e) => setCarrier({ ...carrier, ewayBillNo: e.target.value })}
            />
          </Field>
          <div className="min-w-56 flex-1">
            <Field label={t('Note')}>
              <Input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
        </div>
        {inStock.map((x) => (
          <div key={x.resourceId} className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1 pb-2 text-sm">
              {x.name}{' '}
              <span className="text-fg-muted">
                {t('({qty} {unit} in stock)', { qty: formatQty(x.qty), unit: x.unit })}
              </span>
            </div>
            <Field label={t('Send {name}', { name: x.name })}>
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
            {t('Send')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('Cancel')}
          </Button>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Card>
  );
}
