// Bid pricing (docs/04-features.md E5): scenarios of markups and GST on a BOQ, the comparison with the client's
// estimate, the price per section, and item rates loaded for an item-rate submission.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Stat,
  Table,
  cx,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Download, Plus, Trash2 } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { api, saveFile } from '../api/client';
import type {
  GstMode,
  Markup,
  MarkupKind,
  Priced,
  PricingSummary,
  Scenario,
  TenderBidSummary,
} from '../api/types';
import { formatAmount } from '../boq/model';
import { describeError, formatInr } from '../lib/format';
import { numberLocale } from '../lib/locale';

const KINDS: { value: MarkupKind; label: string }[] = [
  { value: 'overhead', label: 'Overheads' },
  { value: 'profit', label: 'Profit' },
  { value: 'contingency', label: 'Contingency' },
  { value: 'escalation', label: 'Escalation' },
  { value: 'discount', label: 'Discount' },
  { value: 'other', label: 'Other' },
];
const GST_MODES: { value: GstMode; label: string }[] = [
  { value: 'add', label: 'Add GST on top' },
  { value: 'included', label: 'Rates already include GST' },
  { value: 'exempt', label: 'No GST (exempt)' },
];
const STARTER: Markup[] = [
  {
    kind: 'overhead',
    label: 'Site and head-office overheads',
    basis: 'base',
    pct: '7.5',
    amount: null,
  },
  { kind: 'contingency', label: 'Contingency', basis: 'base', pct: '3', amount: null },
  { kind: 'profit', label: 'Profit', basis: 'running', pct: '10', amount: null },
];

interface Draft {
  name: string;
  notes: string;
  markups: (Markup & { by: 'pct' | 'amount' })[];
  gstPct: string;
  gstMode: GstMode;
}

const NUM = /^\d+(\.\d+)?$/;
const toDraft = (s: Scenario | null): Draft =>
  s
    ? {
        name: s.name,
        notes: s.notes,
        markups: s.markups.map((m) => ({ ...m, by: m.amount ? 'amount' : 'pct' })),
        gstPct: s.gstPct.replace(/\.?0+$/, ''),
        gstMode: s.gstMode,
      }
    : {
        name: '',
        notes: '',
        markups: STARTER.map((m) => ({ ...m, by: 'pct' as const })),
        gstPct: '18',
        gstMode: 'add',
      };
const toBody = (d: Draft) => ({
  name: d.name.trim() || 'Draft',
  notes: d.notes,
  gstPct: NUM.test(d.gstPct) ? d.gstPct : '0',
  gstMode: d.gstMode,
  markups: d.markups
    .filter((m) => m.label.trim() && NUM.test((m.by === 'pct' ? m.pct : m.amount) ?? ''))
    .map((m) => ({
      kind: m.kind,
      label: m.label.trim(),
      basis: m.basis,
      ...(m.by === 'pct' ? { pct: m.pct } : { amount: m.amount }),
    })),
});

/** "5.76 % above the estimate" / "below" / "at". */
export function versusEstimate(
  pct: string | null,
): { text: string; tone: 'success' | 'warning' | 'neutral' } | null {
  if (pct === null) return null;
  const n = Number(pct);
  if (n === 0) return { text: 'at the estimate', tone: 'neutral' };
  return {
    text: `${Math.abs(n).toLocaleString(numberLocale(), { maximumFractionDigits: 2 })} % ${n > 0 ? 'above' : 'below'} the estimate`,
    tone: n > 0 ? 'warning' : 'success',
  };
}

function Breakdown({ p, estimate }: { p: Priced; estimate: string | null }) {
  const vs = versusEstimate(p.vsEstimatePct);
  return (
    <dl
      className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm"
      data-testid="pricing-breakdown"
    >
      <dt className="text-fg-muted">BOQ total (base)</dt>
      <dd className="text-right tabular-nums">{formatAmount(p.base)}</dd>
      {p.provisional && Number(p.provisional) !== 0 && (
        <>
          <dt className="pl-3 text-fg-subtle">of which provisional sums (no markups)</dt>
          <dd className="text-right tabular-nums text-fg-subtle" data-testid="provisional">
            {formatAmount(p.provisional)}
          </dd>
        </>
      )}
      {p.markups.map((m, i) => (
        <div key={i} className="contents">
          <dt className="text-fg-muted">
            {m.label}
            {m.pct !== null && (
              <span className="text-fg-subtle">
                {' '}
                ({m.pct} % of {m.basis === 'running' ? 'running total' : 'base'})
              </span>
            )}
          </dt>
          <dd className={cx('text-right tabular-nums', m.amount.startsWith('-') && 'text-success')}>
            {formatAmount(m.amount)}
          </dd>
        </div>
      ))}
      <dt className="border-t border-line pt-1 font-medium">Before GST</dt>
      <dd
        className="border-t border-line pt-1 text-right font-medium tabular-nums"
        data-testid="before-gst"
      >
        {formatAmount(p.beforeGst)}
      </dd>
      {p.gstIncluded !== null ? (
        <>
          <dt className="text-fg-muted">GST included in the rates</dt>
          <dd className="text-right tabular-nums text-fg-muted">{formatAmount(p.gstIncluded)}</dd>
        </>
      ) : (
        <>
          <dt className="text-fg-muted">GST</dt>
          <dd className="text-right tabular-nums">{formatAmount(p.gst)}</dd>
        </>
      )}
      <dt className="font-semibold">Bid value</dt>
      <dd className="text-right text-lg font-semibold tabular-nums" data-testid="bid-value">
        {formatInr(p.bid)}
      </dd>
      {vs && estimate && (
        <dd className="col-span-2 text-right">
          <Badge tone={vs.tone === 'neutral' ? 'neutral' : vs.tone}>{vs.text}</Badge>{' '}
          <span className="text-xs text-fg-muted">({formatInr(estimate)}, before GST)</span>
        </dd>
      )}
    </dl>
  );
}

function ScenarioEditor({
  boqId,
  scenario,
  estimate,
  onSaved,
}: {
  boqId: string;
  scenario: Scenario | null;
  estimate: string | null;
  onSaved: (s: PricingSummary, focus: string | null) => void;
}) {
  const [d, setD] = useState<Draft>(() => toDraft(scenario));
  const [copyName, setCopyName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const body = useMemo(() => toBody(d), [d]);
  const key = useDeferredValue(JSON.stringify(body));
  const preview = useQuery({
    queryKey: ['pricing-preview', boqId, key],
    queryFn: () =>
      api.request<Priced>(`/api/tenant/boqs/${boqId}/pricing/preview`, {
        method: 'POST',
        body: JSON.parse(key) as object,
      }),
    placeholderData: keepPreviousData,
  });
  // Which preview line belongs to each markup row (incomplete rows are left out of the preview).
  const previewIndex = useMemo(() => {
    let n = 0;
    return d.markups.map((m) =>
      m.label.trim() && NUM.test((m.by === 'pct' ? m.pct : m.amount) ?? '') ? n++ : null,
    );
  }, [d.markups]);
  const setM = (i: number, patch: Partial<Draft['markups'][number]>) =>
    setD({ ...d, markups: d.markups.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  const run = async (
    path: string,
    payload: object,
    focus: (s: PricingSummary) => string | null,
    done: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.request<PricingSummary>(path, { method: 'POST', body: payload });
      toast.success(done);
      onSaved(s, focus(s));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    scenario
      ? run(
          `/api/tenant/scenarios/${scenario.id}`,
          { ...body, name: d.name, rowVersion: scenario.rowVersion },
          () => scenario.id,
          `Scenario ${d.name.trim()} saved`,
        )
      : run(
          `/api/tenant/boqs/${boqId}/scenarios`,
          { ...body, name: d.name },
          (s) => s.scenarios.at(-1)?.id ?? null,
          `Scenario ${d.name.trim()} created`,
        );

  return (
    <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card title={scenario ? `Scenario: ${scenario.name}` : 'New scenario'}>
        <div className="space-y-4">
          <div className="max-w-sm">
            <Field label="Scenario name" hint="For example: Standard, Aggressive, With escalation.">
              <Input
                value={d.name}
                onChange={(e) => setD({ ...d, name: e.target.value })}
                maxLength={100}
              />
            </Field>
          </div>
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm" aria-label="Markups">
              <thead className="text-xs text-fg-muted">
                <tr className="[&_th]:px-2 [&_th]:pb-1 [&_th]:font-medium">
                  <th className="w-36 pl-5 text-left">Kind</th>
                  <th className="text-left">Label</th>
                  <th className="w-48 text-left">Applies to</th>
                  <th className="w-36 text-right">% or ₹</th>
                  <th className="w-32 text-right">Amount</th>
                  <th className="w-10 pr-5" />
                </tr>
              </thead>
              <tbody>
                {d.markups.map((m, i) => (
                  <tr key={i} className="border-t border-line [&_td]:px-2 [&_td]:py-1">
                    <td className="pl-5">
                      <Select
                        aria-label="Kind"
                        value={m.kind}
                        onChange={(e) => setM(i, { kind: e.target.value as MarkupKind })}
                      >
                        {KINDS.map((k) => (
                          <option key={k.value} value={k.value}>
                            {k.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <Input
                        aria-label="Label"
                        value={m.label}
                        onChange={(e) => setM(i, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      <Select
                        aria-label="Applies to"
                        value={m.by === 'amount' ? 'fixed' : m.basis}
                        onChange={(e) =>
                          e.target.value === 'fixed'
                            ? setM(i, { by: 'amount', amount: m.amount ?? '' })
                            : setM(i, {
                                by: 'pct',
                                basis: e.target.value as Markup['basis'],
                                pct: m.pct ?? '',
                              })
                        }
                      >
                        <option value="base">% of BOQ total</option>
                        <option value="running">% of running total</option>
                        <option value="fixed">Fixed amount (₹)</option>
                      </Select>
                    </td>
                    <td>
                      <Input
                        aria-label={m.by === 'pct' ? 'Percent' : 'Amount (₹)'}
                        className="text-right"
                        inputMode="decimal"
                        value={(m.by === 'pct' ? m.pct : m.amount) ?? ''}
                        onChange={(e) =>
                          setM(
                            i,
                            m.by === 'pct' ? { pct: e.target.value } : { amount: e.target.value },
                          )
                        }
                      />
                    </td>
                    <td className="text-right tabular-nums">
                      {formatAmount(
                        previewIndex[i] === null
                          ? null
                          : (preview.data?.markups[previewIndex[i]!]?.amount ?? null),
                      )}
                    </td>
                    <td className="pr-5">
                      <Button
                        variant="ghost"
                        aria-label="Remove markup"
                        onClick={() => setD({ ...d, markups: d.markups.filter((_, j) => j !== i) })}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            variant="ghost"
            onClick={() =>
              setD({
                ...d,
                markups: [
                  ...d.markups,
                  { kind: 'other', label: '', basis: 'base', pct: '', amount: null, by: 'pct' },
                ],
              })
            }
          >
            <Plus className="size-4" aria-hidden /> Add markup
          </Button>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64">
              <Field label="GST">
                <Select
                  value={d.gstMode}
                  onChange={(e) => setD({ ...d, gstMode: e.target.value as GstMode })}
                >
                  {GST_MODES.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {d.gstMode !== 'exempt' && (
              <div className="w-28">
                <Field label="GST %" hint="Works contracts: 18 or 12">
                  <Input
                    className="text-right"
                    inputMode="decimal"
                    value={d.gstPct}
                    onChange={(e) => setD({ ...d, gstPct: e.target.value })}
                  />
                </Field>
              </div>
            )}
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            <Button busy={busy} disabled={!d.name.trim()} onClick={() => void save()}>
              {scenario ? 'Save scenario' : 'Create scenario'}
            </Button>
            {scenario && !scenario.selected && (
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void run(
                    `/api/tenant/scenarios/${scenario.id}/select`,
                    {},
                    () => scenario.id,
                    `${scenario.name} is now the bid`,
                  )
                }
              >
                Use as the bid
              </Button>
            )}
            {scenario && (
              <>
                <span className="ml-auto flex items-center gap-2">
                  <Input
                    aria-label="Name for the copy"
                    placeholder="Copy as…"
                    className="w-40"
                    value={copyName}
                    onChange={(e) => setCopyName(e.target.value)}
                  />
                  <Button
                    variant="secondary"
                    disabled={!copyName.trim()}
                    onClick={() =>
                      void run(
                        `/api/tenant/scenarios/${scenario.id}/copy`,
                        { name: copyName.trim() },
                        (s) => s.scenarios.find((x) => x.name === copyName.trim())?.id ?? null,
                        `Copied as ${copyName.trim()}`,
                      )
                    }
                  >
                    Copy
                  </Button>
                </span>
                <Button
                  variant="ghost"
                  aria-label="Delete scenario"
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: `Delete scenario ${scenario.name}?`,
                        body: 'Its markups and the prices worked out from them are deleted. The BOQ and its rates stay as they are.',
                        confirmLabel: 'Delete the scenario',
                        tone: 'danger',
                      }))
                    )
                      return;
                    await run(
                      `/api/tenant/scenarios/${scenario.id}/delete`,
                      {},
                      () => null,
                      `Scenario ${scenario.name} deleted`,
                    );
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>
      <Card title="This scenario">
        {preview.isError ? (
          <Alert tone="danger">{describeError(preview.error)}</Alert>
        ) : !preview.data ? (
          <Spinner label="Pricing" />
        ) : (
          <Breakdown p={preview.data} estimate={estimate} />
        )}
      </Card>
    </div>
  );
}

export function BoqPricingScreen({ boqId }: { boqId: string }) {
  const qc = useQueryClient();
  const summary = useQuery({
    queryKey: ['pricing', boqId],
    queryFn: () => api.request<PricingSummary>(`/api/tenant/boqs/${boqId}/pricing`),
  });
  const [focus, setFocus] = useState<string | 'new' | null>(null);
  useEffect(() => {
    if (summary.data && focus === null)
      setFocus(
        summary.data.scenarios.find((s) => s.selected)?.id ??
          summary.data.scenarios[0]?.id ??
          'new',
      );
  }, [summary.data, focus]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  if (summary.isPending) return <Spinner />;
  if (summary.isError) return <Alert tone="danger">{describeError(summary.error)}</Alert>;
  const s = summary.data;
  const selected = s.scenarios.find((x) => x.selected) ?? null;
  const current = focus === 'new' ? null : (s.scenarios.find((x) => x.id === focus) ?? null);
  // A section's share of the base, applied to the bid before GST (sections then add up to it).
  const share = (amount: string) =>
    selected && Number(s.boq.base) !== 0
      ? String((Number(amount) / Number(s.boq.base)) * Number(selected.result.beforeGst))
      : null;

  const exportQuoted = async () => {
    if (!selected) return;
    setExporting(true);
    setExportError(null);
    try {
      const { blob, fileName } = await api.download(
        `/api/tenant/boqs/${boqId}/export?format=xlsx&scenario=${selected.id}`,
      );
      saveFile(blob, fileName);
    } catch (err) {
      setExportError(describeError(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <Link
        to="/boqs/$boqId"
        params={{ boqId }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {s.tender.number} · {s.boq.name}
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Pricing · {s.boq.name}</h1>
          <p className="text-sm text-fg-muted">
            {s.tender.title}
            {s.tender.estimatedValue &&
              ` · client's estimate ${formatInr(s.tender.estimatedValue)}`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="BOQ total (base)" value={formatInr(s.boq.base)} />
        <Stat label="Items" value={s.counts.items.toLocaleString(numberLocale())} />
        <Stat
          label="Items without a rate"
          value={s.counts.unpriced.toLocaleString(numberLocale())}
          tone={s.counts.unpriced ? 'danger' : undefined}
        />
        <Stat
          label="Items without a quantity"
          value={s.counts.noQty.toLocaleString(numberLocale())}
          tone={s.counts.noQty ? 'warning' : undefined}
        />
      </div>
      {s.counts.unpriced > 0 && (
        <Alert tone="warning">
          {s.counts.unpriced.toLocaleString(numberLocale())} items have a quantity but no rate: they
          count as nothing in every scenario below.
        </Alert>
      )}

      <Card
        title="Scenarios"
        actions={
          <Button variant="secondary" onClick={() => setFocus('new')}>
            <Plus className="size-4" aria-hidden /> New scenario
          </Button>
        }
      >
        {s.scenarios.length === 0 ? (
          <EmptyState title="No scenario yet.">
            The first one you create becomes the bid.
          </EmptyState>
        ) : (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Scenario</th>
                <th className="text-right">Before GST</th>
                <th className="text-right">GST</th>
                <th className="text-right">Bid value</th>
                <th>Against the estimate</th>
              </tr>
            </thead>
            <tbody>
              {s.scenarios.map((x) => {
                const vs = versusEstimate(x.result.vsEstimatePct);
                return (
                  <tr key={x.id} className={cx(focus === x.id && 'bg-surface-2')}>
                    <td>
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => setFocus(x.id)}
                      >
                        {x.name}
                      </button>{' '}
                      {x.selected && <Badge tone="success">bid</Badge>}
                    </td>
                    <td className="text-right tabular-nums">{formatAmount(x.result.beforeGst)}</td>
                    <td className="text-right tabular-nums">{formatAmount(x.result.gst)}</td>
                    <td className="text-right font-medium tabular-nums">
                      {formatAmount(x.result.bid)}
                    </td>
                    <td>
                      {vs ? (
                        <Badge tone={vs.tone === 'neutral' ? 'neutral' : vs.tone}>{vs.text}</Badge>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {focus !== null && (
        <ScenarioEditor
          key={
            focus === 'new' ? `new-${s.scenarios.length}` : `${focus}-${current?.rowVersion ?? 0}`
          }
          boqId={boqId}
          scenario={current}
          estimate={s.tender.estimatedValue}
          onSaved={(next, f) => {
            qc.setQueryData(['pricing', boqId], next);
            void qc.invalidateQueries({ queryKey: ['bid-summary', s.tender.id] });
            setFocus(
              f ?? next.scenarios.find((x) => x.selected)?.id ?? next.scenarios[0]?.id ?? 'new',
            );
          }}
        />
      )}

      {selected && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={`Bid by section (${selected.name})`}>
            <Table minWidth="24rem">
              <thead>
                <tr>
                  <th>Section</th>
                  <th className="text-right">Base</th>
                  <th className="text-right">Before GST</th>
                </tr>
              </thead>
              <tbody>
                {s.sections.map((x) => (
                  <tr key={x.id}>
                    <td>
                      {x.code && <span className="font-mono text-xs text-fg-muted">{x.code} </span>}
                      {x.description}
                    </td>
                    <td className="text-right tabular-nums">{formatAmount(x.subtotal)}</td>
                    <td className="text-right tabular-nums">{formatAmount(share(x.subtotal))}</td>
                  </tr>
                ))}
                {s.unsectioned.items > 0 && (
                  <tr>
                    <td className="text-fg-muted">Items outside sections</td>
                    <td className="text-right tabular-nums">
                      {formatAmount(s.unsectioned.amount)}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatAmount(share(s.unsectioned.amount))}
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Card>
          <Card title="Item-rate submission">
            {s.quoted && (
              <div className="space-y-3 text-sm" data-testid="quoted">
                <p>
                  Every item rate ×{' '}
                  <span className="font-mono">{Number(s.quoted.factor).toFixed(6)}</span>, rounded
                  to paise, gives a BOQ of <b>{formatAmount(s.quoted.total)}</b> before GST
                  {Number(s.quoted.difference) === 0
                    ? ', exactly the bid.'
                    : ` (${formatAmount(s.quoted.difference.replace(/^-/, ''))} ${Number(s.quoted.difference) > 0 ? 'over' : 'under'} the bid, from rounding each rate).`}
                </p>
                <Button variant="secondary" busy={exporting} onClick={() => void exportQuoted()}>
                  <Download className="size-4" aria-hidden /> Export BOQ with quoted rates (Excel)
                </Button>
                {exportError && <Alert tone="danger">{exportError}</Alert>}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/** On the tender page: the bid over all its BOQs, each priced by its selected scenario. */
export function TenderBidSummaryCard({ tenderId }: { tenderId: string }) {
  const q = useQuery({
    queryKey: ['bid-summary', tenderId],
    queryFn: () => api.request<TenderBidSummary>(`/api/tenant/tenders/${tenderId}/bid-summary`),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const s = q.data;
  if (s.boqs.length === 0) return null;
  const vs = versusEstimate(s.vsEstimatePct);
  return (
    <Card title="Bid summary">
      <Table minWidth="32rem">
        <thead>
          <tr>
            <th>BOQ</th>
            <th>Scenario</th>
            <th className="text-right">Before GST</th>
            <th className="text-right">Bid value</th>
          </tr>
        </thead>
        <tbody>
          {s.boqs.map((b) => (
            <tr key={b.id}>
              <td>
                <Link
                  to="/boqs/$boqId/pricing"
                  params={{ boqId: b.id }}
                  className="text-accent hover:underline"
                >
                  {b.name}
                </Link>
                {b.unpriced > 0 && (
                  <span className="ml-2">
                    <Badge tone="danger">{b.unpriced} without rate</Badge>
                  </span>
                )}
              </td>
              <td>{b.scenario ? b.scenario.name : <Badge tone="warning">not priced</Badge>}</td>
              <td className="text-right tabular-nums">
                {b.beforeGst ? formatAmount(b.beforeGst) : '-'}
              </td>
              <td className="text-right tabular-nums">{b.bid ? formatAmount(b.bid) : '-'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line font-semibold [&_td]:px-5 [&_td]:py-2.5">
            <td colSpan={2}>Total</td>
            <td className="text-right tabular-nums">{formatAmount(s.beforeGst)}</td>
            <td className="text-right tabular-nums" data-testid="tender-bid">
              {formatInr(s.bid)}
            </td>
          </tr>
        </tfoot>
      </Table>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {vs && <Badge tone={vs.tone === 'neutral' ? 'neutral' : vs.tone}>{vs.text}</Badge>}
        {!s.complete && (
          <span className="text-fg-muted">
            Some BOQs have no scenario yet; the total leaves them out.
          </span>
        )}
      </div>
    </Card>
  );
}
