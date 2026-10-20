// Rate library (docs/04-features.md E1): the tenant's own resources with dated rates, and price-book import.
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
  toast,
  useConfirm,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileUp, Plus, Search, X } from 'lucide-react';
import { useDeferredValue, useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import {
  RESOURCE_KINDS,
  type PriceBookResult,
  type Resource,
  type ResourceDetail,
  type ResourceKind,
} from '../api/types';
import { formatRate } from '../boq/model';
import { describeError, formatDate } from '../lib/format';
import { usePermission } from '../session/permissions';
import { numberLocale } from '../lib/locale';

export const today = () => new Date().toISOString().slice(0, 10);
export const kindLabel = (k: ResourceKind) => RESOURCE_KINDS.find((x) => x.value === k)!.label;
const PAGE = 50;

function NewResource({ onDone }: { onDone: (r: ResourceDetail | null) => void }) {
  const [v, setV] = useState({
    code: '',
    name: '',
    kind: 'material' as ResourceKind,
    unit: '',
    rate: '',
    effectiveFrom: today(),
    source: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { rate, effectiveFrom, source, ...rest } = v;
      const r = await api.request<ResourceDetail>('/api/tenant/resources', {
        method: 'POST',
        body: rate.trim() ? { ...rest, rate: rate.trim(), effectiveFrom, source } : rest,
      });
      toast.success(`Resource ${r.code} added`);
      onDone(r);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="New resource">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Code">
            <Input value={v.code} onChange={set('code')} required maxLength={40} autoFocus />
          </Field>
          <Field label="Name">
            <Input value={v.name} onChange={set('name')} required maxLength={500} />
          </Field>
          <Field label="Type">
            <Select value={v.kind} onChange={set('kind')}>
              {RESOURCE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit" hint="bag, cum, day, kg …">
            <Input value={v.unit} onChange={set('unit')} required maxLength={20} />
          </Field>
          <Field label="Rate (₹)" hint="Optional now; add rates any time.">
            <Input value={v.rate} onChange={set('rate')} inputMode="decimal" />
          </Field>
          <Field label="Rate from">
            <Input type="date" value={v.effectiveFrom} onChange={set('effectiveFrom')} />
          </Field>
          <Field label="Source">
            <Input value={v.source} onChange={set('source')} placeholder="Dealer quote 14/2026" />
          </Field>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" busy={busy}>
            Add resource
          </Button>
          <Button type="button" variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ResourcePanel({
  id,
  canEdit,
  onClose,
}: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['resource', id],
    queryFn: () => api.request<ResourceDetail>(`/api/tenant/resources/${id}`),
  });
  const [rate, setRate] = useState({ effectiveFrom: today(), rate: '', source: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const run = async (fn: () => Promise<ResourceDetail>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['resource', id], await fn());
      await qc.invalidateQueries({ queryKey: ['resources'] });
      toast.success(done);
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const addRate = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await run(
        () => api.request(`/api/tenant/resources/${id}/rates`, { method: 'POST', body: rate }),
        'Rate added',
      )
    )
      setRate((r) => ({ ...r, rate: '', source: '' }));
  };

  if (detail.isPending) return <Spinner />;
  if (detail.isError) return <Alert tone="danger">{describeError(detail.error)}</Alert>;
  const r = detail.data;
  return (
    <Card
      title={
        <span>
          <span className="font-mono text-sm text-fg-muted">{r.code}</span> {r.name}{' '}
          {!r.active && <Badge tone="warning">archived</Badge>}
        </span>
      }
      actions={
        <Button variant="ghost" onClick={onClose} aria-label="Close resource">
          <X className="size-4" aria-hidden />
        </Button>
      }
    >
      <p className="mb-3 text-sm text-fg-muted">
        {kindLabel(r.kind)} · per {r.unit}
        {r.notes && ` · ${r.notes}`}
      </p>
      <h3 className="mb-1 text-sm font-medium">Rates</h3>
      {r.rates.length === 0 ? (
        <EmptyState title="No rate yet.">
          {canEdit ? 'Add its first rate below, with the day it applies from.' : undefined}
        </EmptyState>
      ) : (
        <table className="mb-3 w-full text-sm" aria-label="Rate history">
          <thead className="text-xs text-fg-muted">
            <tr>
              <th className="py-1 text-left font-medium">From</th>
              <th className="py-1 text-right font-medium">Rate (₹)</th>
              <th className="py-1 pl-3 text-left font-medium">Source</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {r.rates.map((x) => (
              <tr key={x.effectiveFrom} className="border-t border-line">
                <td className="py-1.5">{formatDate(x.effectiveFrom)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatRate(x.rate)}</td>
                <td className="py-1.5 pl-3 text-fg-muted">{x.source}</td>
                {canEdit && (
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      className="text-xs text-fg-subtle hover:text-danger"
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: `Remove the rate from ${formatDate(x.effectiveFrom)}?`,
                            body: `${formatRate(x.rate)} is deleted from ${r.code}'s rate history; the rate before it applies from that day.`,
                            confirmLabel: 'Remove the rate',
                            tone: 'danger',
                          }))
                        )
                          return;
                        await run(
                          () =>
                            api.request(`/api/tenant/resources/${id}/rates/delete`, {
                              method: 'POST',
                              body: { effectiveFrom: x.effectiveFrom },
                            }),
                          'Rate removed',
                        );
                      }}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit && (
        <form onSubmit={(e) => void addRate(e)} className="mb-4 flex flex-wrap items-end gap-2">
          <div className="w-36">
            <Field label="From">
              <Input
                type="date"
                value={rate.effectiveFrom}
                onChange={(e) => setRate((s) => ({ ...s, effectiveFrom: e.target.value }))}
                required
              />
            </Field>
          </div>
          <div className="w-32">
            <Field label="New rate (₹)">
              <Input
                value={rate.rate}
                onChange={(e) => setRate((s) => ({ ...s, rate: e.target.value }))}
                inputMode="decimal"
                required
              />
            </Field>
          </div>
          <div className="min-w-[10rem] flex-1">
            <Field label="Source">
              <Input
                value={rate.source}
                onChange={(e) => setRate((s) => ({ ...s, source: e.target.value }))}
              />
            </Field>
          </div>
          <Button type="submit" busy={busy}>
            Add rate
          </Button>
        </form>
      )}
      {canEdit && (
        <Button
          variant="ghost"
          onClick={async () => {
            if (
              r.active &&
              !(await confirm({
                title: `Archive ${r.code} ${r.name}?`,
                body: 'It is no longer offered for new analyses, requisitions and orders. Where it is already used, it stays.',
                confirmLabel: 'Archive the resource',
                tone: 'danger',
              }))
            )
              return;
            await run(
              () =>
                api.request(`/api/tenant/resources/${id}`, {
                  method: 'POST',
                  body: { rowVersion: r.rowVersion, active: !r.active },
                }),
              `${r.code} ${r.active ? 'archived' : 'restored'}`,
            );
          }}
        >
          {r.active ? 'Archive' : 'Restore'}
        </Button>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <h3 className="mb-1 mt-4 text-sm font-medium">Used in rate analyses</h3>
      {r.usedIn.length === 0 ? (
        <p className="text-sm text-fg-muted">Not used yet.</p>
      ) : (
        <ul className="text-sm">
          {r.usedIn.map((a) => (
            <li key={a.id}>
              <Link
                to="/rate-analyses/$analysisId"
                params={{ analysisId: a.id }}
                className="text-accent hover:underline"
              >
                {a.code}
              </Link>{' '}
              <span className="text-fg-muted">{a.description}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PriceBook({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [defaultKind, setDefaultKind] = useState<ResourceKind>('material');
  const [result, setResult] = useState<PriceBookResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ dryRun: String(dryRun), effectiveFrom, defaultKind });
      const r = await api.upload<PriceBookResult>(`/api/tenant/resources/price-book?${qs}`, file);
      setResult(r);
      if (!dryRun) {
        await qc.invalidateQueries({ queryKey: ['resources'] });
        toast.success(
          `Price book imported: ${r.created} new, ${r.updated} changed, ${r.rates} rates`,
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const applied = result && !result.dryRun;
  return (
    <Card
      title="Import a price book"
      actions={
        <Button variant="ghost" onClick={onDone} aria-label="Close price book import">
          <X className="size-4" aria-hidden />
        </Button>
      }
    >
      <p className="mb-3 text-sm text-fg-muted">
        An Excel or CSV sheet with columns <b>Code</b>, <b>Name</b> (or Description) and <b>Rate</b>
        ; <b>Unit</b>, <b>Type</b> and <b>Effective from</b> are read when present. New codes become
        resources; known codes get a new rate on their date. Check first: nothing is saved until you
        apply.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Button variant="secondary" onClick={() => input.current?.click()}>
            <FileUp className="size-4" aria-hidden /> {file ? file.name : 'Choose file'}
          </Button>
          <input
            ref={input}
            type="file"
            accept=".xlsx,.csv"
            className="sr-only"
            aria-label="Price book file"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              e.target.value = '';
            }}
          />
        </div>
        <div className="w-40">
          <Field label="Rates from" hint="When a row has no date.">
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(e) => {
                setEffectiveFrom(e.target.value);
                setResult(null);
              }}
            />
          </Field>
        </div>
        <div className="w-40">
          <Field label="Type" hint="When a row has none.">
            <Select
              value={defaultKind}
              onChange={(e) => {
                setDefaultKind(e.target.value as ResourceKind);
                setResult(null);
              }}
            >
              {RESOURCE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button busy={busy && !result} disabled={!file} onClick={() => void send(true)}>
          Check
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {result && (
        <div className="mt-4 space-y-3" data-testid="price-book-result">
          <Alert tone={applied ? 'success' : result.errors ? 'warning' : 'info'}>
            {applied ? 'Imported: ' : 'Ready to import: '}
            {result.created} new, {result.updated} changed, {result.rates} rates
            {result.unchanged > 0 && `, ${result.unchanged} unchanged`}
            {result.errors > 0 && `; ${result.errors} rows with problems are skipped`}.
          </Alert>
          {result.unitChanged.length > 0 && (
            <Alert tone="warning">
              Units change for resources used in analyses:{' '}
              {result.unitChanged.map((u) => `${u.code} (${u.from} → ${u.to})`).join(', ')}. Check
              those analyses.
            </Alert>
          )}
          {result.issues.length > 0 && (
            <ul
              className="max-h-48 overflow-auto rounded border border-line text-sm"
              aria-label="Problems"
            >
              {result.issues.map((i) => (
                <li
                  key={`${i.rowNo}-${i.message}`}
                  className="border-t border-line px-3 py-1 first:border-t-0"
                >
                  <span className="text-fg-muted">Row {i.rowNo}:</span> {i.message}
                </li>
              ))}
            </ul>
          )}
          {!applied && result.created + result.updated + result.rates > 0 && (
            <Button busy={busy} onClick={() => void send(false)}>
              Apply
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function ResourcesScreen() {
  const canEdit = usePermission('rates.edit');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<ResourceKind | ''>('');
  const [asOf, setAsOf] = useState(today());
  const [showArchived, setShowArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [mode, setMode] = useState<'new' | 'import' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const q = useDeferredValue(search.trim());
  const params = new URLSearchParams({
    asOf,
    limit: String(PAGE),
    offset: String(offset),
    active: showArchived ? 'all' : 'true',
  });
  if (q) params.set('q', q);
  if (kind) params.set('kind', kind);
  const list = useQuery({
    queryKey: ['resources', params.toString()],
    queryFn: () =>
      api.request<{ items: Resource[]; total: number }>(`/api/tenant/resources?${params}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Resources"
        subtitle="Materials, labour, equipment and subcontract rates, with the date each rate applies from."
        actions={
          canEdit && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMode('import')}>
                <FileUp className="size-4" aria-hidden /> Import price book
              </Button>
              <Button onClick={() => setMode('new')}>
                <Plus className="size-4" aria-hidden /> New resource
              </Button>
            </div>
          )
        }
      />
      {mode === 'new' && (
        <NewResource
          onDone={(r) => {
            setMode(null);
            if (r) {
              void qc.invalidateQueries({ queryKey: ['resources'] });
              setOpen(r.id);
            }
          }}
        />
      )}
      {mode === 'import' && <PriceBook onDone={() => setMode(null)} />}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            aria-label="Search resources"
            placeholder="Search code or name"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <Select
          aria-label="Type"
          className="w-40"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as ResourceKind | '');
            setOffset(0);
          }}
        >
          <option value="">All types</option>
          {RESOURCE_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Archived too
        </label>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card>
          {list.isPending ? (
            <Spinner />
          ) : list.isError ? (
            <Alert tone="danger">{describeError(list.error)}</Alert>
          ) : list.data.items.length === 0 ? (
            <EmptyState title={q || kind ? 'No resources match.' : 'No resources yet.'}>
              {q || kind ? 'Try another search or kind.' : 'Add one or import a price book.'}
            </EmptyState>
          ) : (
            <>
              <Table minWidth="36rem">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Unit</th>
                    <th className="text-right">Rate (₹)</th>
                    <th>From</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((r) => (
                    <tr
                      key={r.id}
                      className={`cursor-pointer hover:bg-surface-2 ${open === r.id ? 'bg-surface-2' : ''}`}
                      onClick={() => setOpen(r.id)}
                    >
                      <td className="font-mono text-xs">
                        <button type="button" className="text-accent hover:underline">
                          {r.code}
                        </button>
                      </td>
                      <td>
                        {r.name} {!r.active && <Badge tone="warning">archived</Badge>}
                      </td>
                      <td>{kindLabel(r.kind)}</td>
                      <td>{r.unit}</td>
                      <td className="text-right tabular-nums">
                        {r.rate === null ? (
                          <Badge tone="danger">no rate</Badge>
                        ) : (
                          formatRate(r.rate)
                        )}
                      </td>
                      <td className="text-fg-muted">{r.rateFrom ? formatDate(r.rateFrom) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="mt-3 flex items-center justify-between text-sm text-fg-muted">
                <span>
                  {offset + 1}–{offset + list.data.items.length} of{' '}
                  {list.data.total.toLocaleString(numberLocale())}
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
        {open && (
          <ResourcePanel key={open} id={open} canEdit={canEdit} onClose={() => setOpen(null)} />
        )}
      </div>
    </div>
  );
}
