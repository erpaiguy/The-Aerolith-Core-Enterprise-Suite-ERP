// Rate analysis (docs/04-features.md E2): list, and the editor with live costing as on a date.
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Spinner, Table } from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Search, Trash2 } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type {
  AnalysisDetail,
  AnalysisLine,
  AnalysisSummary,
  Costing,
  Resource,
  ResourceKind,
} from '../api/types';
import { formatAmount, formatQty, formatRate } from '../boq/model';
import { describeError } from '../lib/format';
import { usePermission } from '../session/permissions';
import { kindLabel, today } from './Resources';

const PAGE = 50;

export function RateAnalysesScreen() {
  const canEdit = usePermission('rates.edit');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [offset, setOffset] = useState(0);
  const q = useDeferredValue(search.trim());
  const params = new URLSearchParams({ asOf, limit: String(PAGE), offset: String(offset) });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['rate-analyses', params.toString()],
    queryFn: () =>
      api.request<{ items: AnalysisSummary[]; total: number }>(
        `/api/tenant/rate-analyses?${params}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Rate analyses"
        subtitle="Item rates built from resources, sub-analyses, wastage, overheads and profit."
        actions={
          canEdit && (
            <Button
              onClick={() =>
                void navigate({ to: '/rate-analyses/$analysisId', params: { analysisId: 'new' } })
              }
            >
              <Plus className="size-4" aria-hidden /> New analysis
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            aria-label="Search rate analyses"
            placeholder="Search code or description"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          Rates as on
          <Input
            type="date"
            aria-label="Rates as on"
            className="w-40"
            value={asOf}
            onChange={(e) => e.target.value && setAsOf(e.target.value)}
          />
        </label>
      </div>
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : list.data.items.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {q ? 'No analyses match.' : 'No rate analyses yet.'}
          </p>
        ) : (
          <>
            <Table minWidth="36rem">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Description</th>
                  <th>Unit</th>
                  <th className="text-right">Rate (₹)</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono text-xs">
                      <Link
                        to="/rate-analyses/$analysisId"
                        params={{ analysisId: a.id }}
                        className="text-accent hover:underline"
                      >
                        {a.code}
                      </Link>
                    </td>
                    <td className="max-w-md truncate">
                      {a.description} {!a.active && <Badge tone="warning">archived</Badge>}
                    </td>
                    <td>{a.unit}</td>
                    <td className="text-right tabular-nums">
                      {a.missing > 0 ? (
                        <Badge tone="danger">{a.missing} without rate</Badge>
                      ) : (
                        formatRate(a.boqRate)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-3 flex items-center justify-between text-sm text-fg-muted">
              <span>
                {offset + 1}–{offset + list.data.items.length} of{' '}
                {list.data.total.toLocaleString('en-IN')}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="ghost"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                >
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  disabled={offset + PAGE >= list.data.total}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  Next
                </Button>
              </span>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// --- editor ---

interface Ref {
  code: string;
  name: string;
  unit: string;
  kind?: ResourceKind;
}

interface DraftLine {
  key: number;
  kind: AnalysisLine['kind'];
  refId: string | null;
  ref: Ref | null;
  description: string;
  qty: string;
  wastagePct: string;
  amount: string;
}

interface Draft {
  code: string;
  description: string;
  unit: string;
  outputQty: string;
  notes: string;
  active: boolean;
  additions: { label: string; pct: string }[];
  lines: DraftLine[];
}

let nextKey = 1;
const NUM = /^\d+(\.\d+)?$/;

const fromDetail = (a: AnalysisDetail): Draft => ({
  code: a.code,
  description: a.description,
  unit: a.unit,
  outputQty: a.outputQty.replace(/\.?0+$/, '') || '1',
  notes: a.notes,
  active: a.active,
  additions: a.additions,
  lines: a.lines.map((l) => ({
    key: nextKey++,
    kind: l.kind,
    refId: l.resourceId ?? l.subAnalysisId,
    ref: l.resource
      ? {
          code: l.resource.code,
          name: l.resource.name,
          unit: l.resource.unit,
          kind: l.resource.kind,
        }
      : l.subAnalysis
        ? { code: l.subAnalysis.code, name: l.subAnalysis.description, unit: l.subAnalysis.unit }
        : null,
    description: l.description,
    qty: l.qty.replace(/\.?0+$/, '') || '0',
    wastagePct: l.wastagePct.replace(/\.?0+$/, '') || '0',
    amount: l.amount?.replace(/\.?0+$/, '') ?? '',
  })),
});

const blank = (): Draft => ({
  code: '',
  description: '',
  unit: '',
  outputQty: '1',
  notes: '',
  active: true,
  additions: [],
  lines: [],
});

const lineComplete = (l: DraftLine) =>
  l.kind === 'lump_sum'
    ? l.description.trim() !== '' && NUM.test(l.amount)
    : l.refId !== null && NUM.test(l.qty) && NUM.test(l.wastagePct || '0');

/** The API body; incomplete lines are left out (they are shown as such). */
const toBody = (d: Draft, forPreview: boolean) => ({
  code: d.code.trim() || (forPreview ? 'DRAFT' : ''),
  description: d.description.trim() || (forPreview ? 'Draft' : ''),
  unit: d.unit.trim() || (forPreview ? 'unit' : ''),
  outputQty:
    NUM.test(d.outputQty) && Number(d.outputQty) > 0 ? d.outputQty : forPreview ? '1' : d.outputQty,
  notes: d.notes,
  active: d.active,
  additions: d.additions.filter((x) => x.label.trim() && NUM.test(x.pct)),
  lines: d.lines
    .filter((l) => !forPreview || lineComplete(l))
    .map((l) =>
      l.kind === 'lump_sum'
        ? { kind: l.kind, description: l.description, amount: l.amount }
        : {
            kind: l.kind,
            [l.kind === 'resource' ? 'resourceId' : 'subAnalysisId']: l.refId,
            description: l.description,
            qty: l.qty,
            wastagePct: l.wastagePct || '0',
          },
    ),
});

/** Finds a resource or an analysis by code or name. */
function RefPicker({
  kind,
  exclude,
  onPick,
}: {
  kind: 'resource' | 'analysis';
  exclude?: string | undefined;
  onPick: (id: string, ref: Ref) => void;
}) {
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const results = useQuery({
    queryKey: ['ref-picker', kind, q],
    queryFn: async () =>
      kind === 'resource'
        ? (
            await api.request<{ items: Resource[] }>(
              `/api/tenant/resources?limit=8&q=${encodeURIComponent(q)}`,
            )
          ).items.map((r) => ({
            id: r.id,
            ref: { code: r.code, name: r.name, unit: r.unit, kind: r.kind },
          }))
        : (
            await api.request<{ items: AnalysisSummary[] }>(
              `/api/tenant/rate-analyses?limit=8&q=${encodeURIComponent(q)}`,
            )
          ).items
            .filter((a) => a.id !== exclude)
            .map((a) => ({ id: a.id, ref: { code: a.code, name: a.description, unit: a.unit } })),
    enabled: q.length >= 1,
  });
  return (
    <div className="relative">
      <Input
        autoFocus
        aria-label={kind === 'resource' ? 'Find resource' : 'Find analysis'}
        placeholder={kind === 'resource' ? 'Resource code or name' : 'Analysis code or description'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {q.length >= 1 && results.data && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full min-w-[18rem] overflow-auto rounded-md border border-line bg-surface p-1 shadow-lg"
        >
          {results.data.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-fg-muted">Nothing found.</li>
          ) : (
            results.data.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="flex w-full gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  onClick={() => onPick(r.id, r.ref)}
                >
                  <span className="font-mono text-xs text-fg-muted">{r.ref.code}</span>
                  <span className="min-w-0 flex-1 truncate">{r.ref.name}</span>
                  <span className="text-xs text-fg-subtle">{r.ref.unit}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

const PRESET = [
  { label: 'Water charges', pct: '1' },
  { label: "Contractor's profit and overheads", pct: '15' },
];

export function AnalysisEditor({ analysisId }: { analysisId: string }) {
  const isNew = analysisId === 'new';
  const canEdit = usePermission('rates.edit');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [asOf, setAsOf] = useState(today());
  const detail = useQuery({
    queryKey: ['rate-analysis', analysisId],
    queryFn: () => api.request<AnalysisDetail>(`/api/tenant/rate-analyses/${analysisId}`),
    enabled: !isNew,
  });
  const [draft, setDraft] = useState<Draft | null>(isNew ? blank() : null);
  const [rowVersion, setRowVersion] = useState<number | null>(null);
  useEffect(() => {
    if (detail.data && draft === null) {
      setDraft(fromDetail(detail.data));
      setRowVersion(detail.data.rowVersion);
    }
  }, [detail.data, draft]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyCode, setCopyCode] = useState('');

  const previewBody = useMemo(() => (draft ? toBody(draft, true) : null), [draft]);
  const previewKey = useDeferredValue(JSON.stringify(previewBody));
  const preview = useQuery({
    queryKey: ['analysis-preview', analysisId, asOf, previewKey],
    queryFn: () =>
      api.request<Costing>(
        `/api/tenant/rate-analyses/preview?asOf=${asOf}${isNew ? '' : `&id=${analysisId}`}`,
        { method: 'POST', body: JSON.parse(previewKey) as object },
      ),
    enabled: previewBody !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });

  if (!isNew && detail.isPending) return <Spinner />;
  if (!isNew && detail.isError) return <Alert tone="danger">{describeError(detail.error)}</Alert>;
  if (!draft) return <Spinner />;

  const ro = !canEdit;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const setLine = (key: number, patch: Partial<DraftLine>) =>
    set(
      'lines',
      draft.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
  const addLine = (kind: DraftLine['kind']) =>
    set('lines', [
      ...draft.lines,
      {
        key: nextKey++,
        kind,
        refId: null,
        ref: null,
        description: '',
        qty: '',
        wastagePct: '0',
        amount: '',
      },
    ]);
  const moveLine = (i: number, by: -1 | 1) => {
    const lines = [...draft.lines];
    const [l] = lines.splice(i, 1);
    lines.splice(i + by, 0, l!);
    set('lines', lines);
  };
  // Preview costs are for the complete lines, in order.
  const costOf = new Map<number, { unitCost: string | null; cost: string }>();
  if (preview.data) {
    let n = 0;
    for (const l of draft.lines)
      if (lineComplete(l)) {
        const c = preview.data.lines[n++];
        if (c) costOf.set(l.key, c);
      }
  }
  const c = preview.data;
  const outputQty = NUM.test(draft.outputQty) ? draft.outputQty : '1';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = toBody(draft, false);
      if (draft.lines.some((l) => !lineComplete(l)))
        throw new Error('Complete or remove the unfinished lines first.');
      const saved = await api.request<AnalysisDetail>(
        isNew ? '/api/tenant/rate-analyses' : `/api/tenant/rate-analyses/${analysisId}`,
        { method: 'POST', body: isNew ? body : { ...body, rowVersion } },
      );
      await qc.invalidateQueries({ queryKey: ['rate-analyses'] });
      qc.setQueryData(['rate-analysis', saved.id], saved);
      setRowVersion(saved.rowVersion);
      setDraft(fromDetail(saved));
      if (isNew)
        await navigate({ to: '/rate-analyses/$analysisId', params: { analysisId: saved.id } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.request<AnalysisDetail>(
        `/api/tenant/rate-analyses/${analysisId}/copy`,
        {
          method: 'POST',
          body: { code: copyCode },
        },
      );
      await qc.invalidateQueries({ queryKey: ['rate-analyses'] });
      setCopyCode('');
      await navigate({ to: '/rate-analyses/$analysisId', params: { analysisId: saved.id } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Link
        to="/rate-analyses"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Rate analyses
      </Link>
      <PageHeader
        title={isNew ? 'New rate analysis' : `${draft.code} · ${draft.description}`}
        actions={
          <label className="flex items-center gap-2 text-sm">
            Rates as on
            <Input
              type="date"
              aria-label="Rates as on"
              className="w-40"
              value={asOf}
              onChange={(e) => e.target.value && setAsOf(e.target.value)}
            />
          </label>
        }
      />
      <Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[10rem_minmax(0,1fr)_8rem_10rem]">
          <Field label="Code">
            <Input
              value={draft.code}
              onChange={(e) => set('code', e.target.value)}
              disabled={ro}
              maxLength={40}
            />
          </Field>
          <Field label="Description">
            <Input
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              disabled={ro}
            />
          </Field>
          <Field label="Unit">
            <Input
              value={draft.unit}
              onChange={(e) => set('unit', e.target.value)}
              disabled={ro}
              maxLength={20}
            />
          </Field>
          <Field
            label="Analysis for"
            hint={`Quantity of ${draft.unit || 'units'} the lines produce.`}
          >
            <Input
              value={draft.outputQty}
              onChange={(e) => set('outputQty', e.target.value)}
              inputMode="decimal"
              disabled={ro}
            />
          </Field>
        </div>
      </Card>

      <Card title="Lines">
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm" aria-label="Analysis lines">
            <thead className="text-xs text-fg-muted">
              <tr className="[&_th]:px-2 [&_th]:pb-2 [&_th]:font-medium">
                <th className="w-8 pl-5 text-left">#</th>
                <th className="text-left">Item</th>
                <th className="w-16 text-left">Unit</th>
                <th className="w-28 text-right">Quantity</th>
                <th className="w-24 text-right">Wastage %</th>
                <th className="w-28 text-right">Rate</th>
                <th className="w-32 text-right">Cost</th>
                <th className="w-24 pr-5" />
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const cost = costOf.get(l.key);
                return (
                  <tr
                    key={l.key}
                    className="border-t border-line [&_td]:px-2 [&_td]:py-1.5"
                    data-testid="analysis-line"
                  >
                    <td className="pl-5 text-fg-muted">{i + 1}</td>
                    <td>
                      {l.kind === 'lump_sum' ? (
                        <Input
                          aria-label="Lump sum description"
                          placeholder="Sundries, carriage …"
                          value={l.description}
                          onChange={(e) => setLine(l.key, { description: e.target.value })}
                          disabled={ro}
                        />
                      ) : l.ref ? (
                        <span className="flex items-baseline gap-2">
                          <span className="font-mono text-xs text-fg-muted">{l.ref.code}</span>
                          <span className="truncate">{l.ref.name}</span>
                          <Badge tone={l.kind === 'analysis' ? 'accent' : 'neutral'}>
                            {l.kind === 'analysis' ? 'analysis' : kindLabel(l.ref.kind ?? 'other')}
                          </Badge>
                        </span>
                      ) : (
                        <RefPicker
                          kind={l.kind}
                          exclude={isNew ? undefined : analysisId}
                          onPick={(id, ref) => setLine(l.key, { refId: id, ref })}
                        />
                      )}
                    </td>
                    <td>{l.kind === 'lump_sum' ? 'LS' : (l.ref?.unit ?? '')}</td>
                    <td>
                      {l.kind !== 'lump_sum' && (
                        <Input
                          aria-label="Quantity"
                          className="text-right"
                          value={l.qty}
                          onChange={(e) => setLine(l.key, { qty: e.target.value })}
                          inputMode="decimal"
                          disabled={ro}
                        />
                      )}
                    </td>
                    <td>
                      {l.kind !== 'lump_sum' && (
                        <Input
                          aria-label="Wastage %"
                          className="text-right"
                          value={l.wastagePct}
                          onChange={(e) => setLine(l.key, { wastagePct: e.target.value })}
                          inputMode="decimal"
                          disabled={ro}
                        />
                      )}
                    </td>
                    <td className="text-right tabular-nums text-fg-muted">
                      {l.kind === 'lump_sum' ? (
                        ''
                      ) : cost?.unitCost === null ? (
                        <Badge tone="danger">no rate</Badge>
                      ) : (
                        formatRate(cost?.unitCost ?? null)
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      {l.kind === 'lump_sum' ? (
                        <Input
                          aria-label="Lump sum amount"
                          className="text-right"
                          value={l.amount}
                          onChange={(e) => setLine(l.key, { amount: e.target.value })}
                          inputMode="decimal"
                          disabled={ro}
                        />
                      ) : (
                        formatAmount(cost?.cost ?? null)
                      )}
                    </td>
                    <td className="pr-5 text-right">
                      {!ro && (
                        <span className="inline-flex">
                          <Button
                            variant="ghost"
                            aria-label="Move line up"
                            disabled={i === 0}
                            onClick={() => moveLine(i, -1)}
                          >
                            <ArrowUp className="size-3.5" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label="Move line down"
                            disabled={i === draft.lines.length - 1}
                            onClick={() => moveLine(i, 1)}
                          >
                            <ArrowDown className="size-3.5" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label="Remove line"
                            onClick={() =>
                              set(
                                'lines',
                                draft.lines.filter((x) => x.key !== l.key),
                              )
                            }
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {draft.lines.length === 0 && <p className="text-sm text-fg-muted">No lines yet.</p>}
        {!ro && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => addLine('resource')}>
              <Plus className="size-4" aria-hidden /> Resource
            </Button>
            <Button variant="secondary" onClick={() => addLine('analysis')}>
              <Plus className="size-4" aria-hidden /> Sub-analysis
            </Button>
            <Button variant="secondary" onClick={() => addLine('lump_sum')}>
              <Plus className="size-4" aria-hidden /> Lump sum
            </Button>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Overheads and profit"
          actions={
            !ro &&
            draft.additions.length === 0 && (
              <Button variant="ghost" onClick={() => set('additions', PRESET)}>
                Water 1 % + profit and overheads 15 %
              </Button>
            )
          }
        >
          <p className="mb-3 text-xs text-fg-muted">
            Each percentage applies to the running total, in this order.
          </p>
          <ul className="space-y-2">
            {draft.additions.map((a, i) => (
              <li key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <Input
                    aria-label="Addition"
                    value={a.label}
                    onChange={(e) =>
                      set(
                        'additions',
                        draft.additions.map((x, j) =>
                          j === i ? { ...x, label: e.target.value } : x,
                        ),
                      )
                    }
                    disabled={ro}
                  />
                </div>
                <div className="w-24">
                  <Input
                    aria-label="Percent"
                    className="text-right"
                    value={a.pct}
                    onChange={(e) =>
                      set(
                        'additions',
                        draft.additions.map((x, j) =>
                          j === i ? { ...x, pct: e.target.value } : x,
                        ),
                      )
                    }
                    inputMode="decimal"
                    disabled={ro}
                  />
                </div>
                <span className="w-28 pb-2 text-right text-sm tabular-nums">
                  {formatAmount(c?.additions[i]?.amount ?? null)}
                </span>
                {!ro && (
                  <Button
                    variant="ghost"
                    aria-label="Remove addition"
                    onClick={() =>
                      set(
                        'additions',
                        draft.additions.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {!ro && (
            <Button
              variant="ghost"
              className="mt-2"
              onClick={() => set('additions', [...draft.additions, { label: '', pct: '' }])}
            >
              <Plus className="size-4" aria-hidden /> Add percentage
            </Button>
          )}
        </Card>

        <Card title="Rate">
          {preview.isError ? (
            <Alert tone="danger">{describeError(preview.error)}</Alert>
          ) : !c ? (
            <Spinner label="Costing" />
          ) : (
            <div className="space-y-3" data-testid="analysis-totals">
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-muted">
                  Lines, for {formatQty(outputQty)} {draft.unit}
                </dt>
                <dd className="text-right tabular-nums">{formatAmount(c.subtotal)}</dd>
                <dt className="text-fg-muted">With overheads and profit</dt>
                <dd className="text-right tabular-nums">{formatAmount(c.total)}</dd>
                <dt className="font-medium">Rate per {draft.unit || 'unit'}</dt>
                <dd
                  className="text-right text-xl font-semibold tabular-nums"
                  data-testid="analysis-rate"
                >
                  ₹{formatAmount(c.boqRate)}
                </dd>
              </dl>
              <div>
                <h3 className="mb-1 text-xs font-medium text-fg-muted">
                  Per {draft.unit || 'unit'}, by type
                </h3>
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 text-sm">
                  {(Object.entries(c.byKind) as [ResourceKind, string][])
                    .filter(([, v]) => Number(v) !== 0)
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt>{kindLabel(k)}</dt>
                        <dd className="text-right tabular-nums">{formatRate(v)}</dd>
                      </div>
                    ))}
                  {Number(c.additionsPerUnit) !== 0 && (
                    <>
                      <dt>Overheads and profit</dt>
                      <dd className="text-right tabular-nums">{formatRate(c.additionsPerUnit)}</dd>
                    </>
                  )}
                </dl>
              </div>
              {c.missing.length > 0 && (
                <Alert tone="warning">
                  No rate on {asOf} for {c.missing.map((m) => m.code).join(', ')}; they count as
                  nothing above.
                </Alert>
              )}
            </div>
          )}
        </Card>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {!ro && (
        <div className="flex flex-wrap items-center gap-3">
          <Button busy={busy} onClick={() => void save()}>
            {isNew ? 'Create analysis' : 'Save'}
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => set('active', e.target.checked)}
            />
            In use (untick to archive)
          </label>
          {!isNew && (
            <span className="ml-auto flex items-center gap-2">
              <Input
                aria-label="Code for the copy"
                placeholder="New code"
                className="w-36"
                value={copyCode}
                onChange={(e) => setCopyCode(e.target.value)}
              />
              <Button variant="secondary" disabled={!copyCode.trim()} onClick={() => void copy()}>
                Copy
              </Button>
            </span>
          )}
        </div>
      )}

      {!isNew && detail.data && (detail.data.usedBy.length > 0 || detail.data.boqs.length > 0) && (
        <Card title="Where it is used">
          {detail.data.usedBy.length > 0 && (
            <p className="mb-2 text-sm">
              In analyses:{' '}
              {detail.data.usedBy.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ', '}
                  <Link
                    to="/rate-analyses/$analysisId"
                    params={{ analysisId: a.id }}
                    className="text-accent hover:underline"
                  >
                    {a.code}
                  </Link>
                </span>
              ))}
            </p>
          )}
          {detail.data.boqs.length > 0 && (
            <ul className="text-sm">
              {detail.data.boqs.map((b) => (
                <li key={b.id}>
                  <Link
                    to="/boqs/$boqId"
                    params={{ boqId: b.id }}
                    className="text-accent hover:underline"
                  >
                    {b.tenderNumber} · {b.name}
                  </Link>{' '}
                  <span className="text-fg-muted">({b.items} items)</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-fg-muted">
            BOQs keep the rate they were given; use “Refresh rates” on a BOQ to take changes.
          </p>
        </Card>
      )}
    </div>
  );
}
