import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Download,
  FileUp,
  History,
  IndianRupee,
  ListTree,
  Lock,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  X,
  LayoutTemplate,
} from 'lucide-react';
import { useCallback, useDeferredValue, useRef, useState, type FormEvent } from 'react';
import { api, saveFile } from '../api/client';
import type { AnalysisSummary, BoqTemplate } from '../api/types';
import { BoqGrid, type GridHandle } from '../boq/BoqGrid';
import { MeasurementSheet } from '../boq/MeasurementSheet';
import { BoqReportsMenu } from './Reports';
import { VERTICALS } from './TenderForm';
import { SaveTemplateDialog } from './Templates';
import { FreezeDialog } from './Versions';
import {
  ImportBanner,
  ImportWizard,
  useImportFinished,
  useLatestImport,
} from '../boq/ImportWizard';
import { formatAmount, type BoqHeader, type BoqRow } from '../boq/model';
import { describeError, formatInr } from '../lib/format';
import { usePermission } from '../session/permissions';

/** Sections (outline) or search results; clicking one opens the grid at that line. */
function SidePanel({ boqId, onJump }: { boqId: string; onJump: (key: string) => void }) {
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const outline = useQuery({
    queryKey: ['boq-outline', boqId],
    queryFn: () => api.request<BoqRow[]>(`/api/tenant/boqs/${boqId}/outline?maxDepth=1`),
  });
  const results = useQuery({
    queryKey: ['boq-search', boqId, q],
    queryFn: () =>
      api.request<{ rows: BoqRow[]; hasMore: boolean }>(
        `/api/tenant/boqs/${boqId}/search?limit=100&q=${encodeURIComponent(q)}`,
      ),
    enabled: q.length >= 2,
  });
  const list = q.length >= 2 ? results.data?.rows : outline.data;
  const busy = q.length >= 2 ? results.isFetching : outline.isPending;

  return (
    <aside className="flex min-h-0 flex-col rounded-lg border border-line bg-surface lg:w-60 lg:shrink-0">
      <div className="relative border-b border-line p-2">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden
        />
        <Input
          aria-label="Search this BOQ"
          placeholder="Search code or description"
          className="pl-8 pr-8"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute right-4 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg"
            onClick={() => setSearch('')}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-3 pt-2 text-xs font-medium text-fg-muted">
        {q.length >= 2 ? (
          <>
            <Search className="size-3.5" aria-hidden /> Results
            {results.data?.hasMore && <span className="text-fg-subtle">(first 100)</span>}
          </>
        ) : (
          <>
            <ListTree className="size-3.5" aria-hidden /> Sections
          </>
        )}
      </div>
      <nav
        aria-label={q.length >= 2 ? 'Search results' : 'BOQ sections'}
        className="max-h-64 min-h-0 flex-1 overflow-y-auto p-1 lg:max-h-none"
      >
        {busy && !list ? (
          <Spinner />
        ) : !list || list.length === 0 ? (
          <p className="p-3 text-sm text-fg-muted">
            {q.length >= 2 ? 'No lines match.' : 'No sections yet.'}
          </p>
        ) : (
          <ul>
            {list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onJump(r.sortKey)}
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  style={{ paddingLeft: q.length >= 2 ? undefined : 8 + r.depth * 12 }}
                >
                  {r.code && (
                    <span className="shrink-0 font-mono text-xs text-fg-muted">{r.code}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {r.description || (r.type === 'section' ? 'Untitled section' : '-')}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
                    {formatAmount(r.type === 'section' ? r.subtotal : r.amount)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

export function BoqScreen({ boqId }: { boqId: string }) {
  const qc = useQueryClient();
  const canEditBoq = usePermission('boq.edit');
  const grid = useRef<GridHandle>(null);
  const [saving, setSaving] = useState(0);
  // The outline takes width the grid needs on laptop screens; open by default only on wide ones.
  const [panel, setPanel] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1280,
  );
  const header = useQuery({
    queryKey: ['boq', boqId],
    queryFn: () => api.request<BoqHeader>(`/api/tenant/boqs/${boqId}`),
  });
  const [wizard, setWizard] = useState(false);
  const [measuring, setMeasuring] = useState<BoqRow | null>(null);
  const [freezing, setFreezing] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const canPrice = usePermission('pricing.edit');
  const [picking, setPicking] = useState<{
    row: BoqRow;
    resolve: (id: string | null) => void;
  } | null>(null);
  const pickAnalysis = useCallback(
    (row: BoqRow) => new Promise<string | null>((resolve) => setPicking({ row, resolve })),
    [],
  );
  const reload = useCallback(() => {
    setGridKey((k) => k + 1);
    void qc.invalidateQueries({ queryKey: ['boq', boqId] });
    void qc.invalidateQueries({ queryKey: ['boq-outline', boqId] });
    void qc.invalidateQueries({ queryKey: ['tender-boqs'] });
  }, [qc, boqId]);
  const [gridKey, setGridKey] = useState(0);
  const latestImport = useLatestImport(boqId, canEditBoq);
  const importJob = latestImport.data?.job;
  useImportFinished(
    importJob,
    useCallback(() => {
      setWizard(false);
      setGridKey((k) => k + 1); // the grid re-reads its window
      void qc.invalidateQueries({ queryKey: ['boq', boqId] });
      void qc.invalidateQueries({ queryKey: ['boq-outline', boqId] });
      void qc.invalidateQueries({ queryKey: ['tender-boqs'] });
    }, [qc, boqId]),
  );
  const onHeader = useCallback(
    (h: BoqHeader) => {
      qc.setQueryData<BoqHeader>(['boq', boqId], (old) => ({ ...old, ...h }));
      void qc.invalidateQueries({ queryKey: ['boq-outline', boqId] });
    },
    [qc, boqId],
  );

  if (header.isPending) return <Spinner />;
  if (header.isError) return <Alert tone="danger">{describeError(header.error)}</Alert>;
  const h = header.data;
  const archived = Boolean(h.archivedAt);
  const canEdit = canEditBoq && h.status === 'draft' && !archived;
  const running = importJob?.status === 'importing';
  const setArchived = async (to: boolean) => {
    setArchiveError(null);
    try {
      qc.setQueryData(
        ['boq', boqId],
        await api.request<BoqHeader>(`/api/tenant/boqs/${boqId}/archive`, {
          method: 'POST',
          body: { archived: to },
        }),
      );
      void qc.invalidateQueries({ queryKey: ['tender-boqs'] });
      void qc.invalidateQueries({ queryKey: ['bid-summary'] });
      setGridKey((k) => k + 1);
    } catch (err) {
      setArchiveError(describeError(err));
    }
  };

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[34rem] flex-col gap-3">
      {h.tender && (
        <Link
          to="/tenders/$tenderId"
          params={{ tenderId: h.tender.id }}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> {h.tender.number} · {h.tender.title}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{h.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Link
              to="/boqs/$boqId/versions"
              params={{ boqId }}
              className="hover:underline"
              title="Versions: freeze, revise, compare"
            >
              <Badge tone={h.status === 'draft' ? 'accent' : 'warning'}>
                Version {h.versionNo ?? 1} · {h.status === 'draft' ? 'draft' : h.status}
              </Badge>
            </Link>
            {archived && <Badge tone="danger">Archived</Badge>}
            <span>
              {h.itemCount.toLocaleString('en-IN')} items · {h.nodeCount.toLocaleString('en-IN')}{' '}
              lines
            </span>
            <span aria-live="polite" className="text-xs">
              {saving > 0 ? 'Saving…' : canEdit ? 'All changes saved' : 'Read only'}
            </span>
          </p>
          <RatesBar header={h} canEdit={canEdit && !running} onRefreshed={reload} />
        </div>
        <div className="flex items-end gap-4">
          {canEdit && !wizard && (
            <Button variant="secondary" onClick={() => setWizard(true)}>
              <FileUp className="size-4" aria-hidden />{' '}
              {h.nodeCount === 0 ? 'Import' : 'Import revised BOQ'}
            </Button>
          )}
          {canEditBoq && h.status === 'draft' && !archived && !wizard && (
            <Button variant="secondary" onClick={() => setFreezing(true)}>
              <Lock className="size-4" aria-hidden /> Freeze
            </Button>
          )}
          {h.status !== 'draft' && (
            <Link
              to="/boqs/$boqId/versions"
              params={{ boqId }}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3.5 py-2 text-sm font-medium hover:bg-surface-3"
            >
              <History className="size-4" aria-hidden /> Versions
            </Link>
          )}
          <BoqReportsMenu boqId={boqId} />
          {canEditBoq && h.nodeCount > 0 && (
            <Button
              variant="ghost"
              onClick={() => setTemplating(true)}
              title="Save this BOQ as a template"
            >
              <LayoutTemplate className="size-4" aria-hidden /> Save as template
            </Button>
          )}
          <ExportMenu boqId={boqId} />
          {canPrice && (
            <Link
              to="/boqs/$boqId/pricing"
              params={{ boqId }}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3.5 py-2 text-sm font-medium hover:bg-surface-3"
            >
              <IndianRupee className="size-4" aria-hidden /> Pricing
            </Link>
          )}
          {canEditBoq && !wizard && !running && (
            <Button
              variant="ghost"
              onClick={() => void setArchived(!archived)}
              title={
                archived
                  ? 'Make this BOQ part of the tender again'
                  : 'Made by mistake? Archive it: read only, left out of the bid. It can be restored.'
              }
            >
              {archived ? (
                <>
                  <ArchiveRestore className="size-4" aria-hidden /> Restore
                </>
              ) : (
                <>
                  <Archive className="size-4" aria-hidden /> Archive
                </>
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            aria-pressed={panel}
            onClick={() => setPanel((p) => !p)}
            title="Show or hide the outline and search"
          >
            <PanelLeft className="size-4" aria-hidden /> Outline
          </Button>
          <div className="text-right">
            <div className="text-xs text-fg-muted">Total</div>
            <div className="text-2xl font-semibold tabular-nums" data-testid="boq-total">
              {formatInr(h.total)}
            </div>
          </div>
        </div>
      </div>
      {archiveError && <Alert tone="danger">{archiveError}</Alert>}
      {archived && (
        <Alert tone="warning">
          This BOQ is archived: read only and left out of the tender&apos;s bid.
        </Alert>
      )}
      {running && !wizard && importJob && <ImportBanner job={importJob} />}
      {wizard ? (
        <ImportWizard boqId={boqId} revising={h.nodeCount > 0} onClose={() => setWizard(false)} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
          {panel && <SidePanel boqId={boqId} onJump={(key) => grid.current?.jumpTo(key)} />}
          <BoqGrid
            key={gridKey}
            ref={grid}
            boqId={boqId}
            canEdit={canEdit && !running}
            onHeader={onHeader}
            onSaving={setSaving}
            onPickAnalysis={pickAnalysis}
            onMeasure={setMeasuring}
            onBulkDone={reload}
          />
        </div>
      )}
      {templating && (
        <SaveTemplateDialog boqId={boqId} boqName={h.name} onClose={() => setTemplating(false)} />
      )}
      {freezing && (
        <FreezeDialog
          boqId={boqId}
          versionNo={h.versionNo ?? 1}
          onClose={() => setFreezing(false)}
          onDone={() => {
            setFreezing(false);
            void qc.invalidateQueries({ queryKey: ['boq', boqId] });
            void qc.invalidateQueries({ queryKey: ['boq-versions', boqId] });
            setGridKey((k) => k + 1);
          }}
        />
      )}
      {measuring && (
        <MeasurementSheet
          boqId={boqId}
          item={measuring}
          canEdit={canEdit && !running}
          currentVersion={() => grid.current?.row(measuring.id)?.rowVersion ?? measuring.rowVersion}
          onSaved={(rows, header) => {
            grid.current?.apply(rows, header);
            void qc.invalidateQueries({ queryKey: ['boq-outline', boqId] });
            setMeasuring(null);
          }}
          onClose={() => setMeasuring(null)}
        />
      )}
      {picking && (
        <AnalysisPicker
          row={picking.row}
          rateDate={h.rateDate ?? ''}
          onDone={(id) => {
            picking.resolve(id);
            setPicking(null);
          }}
        />
      )}
      <p className={wizard ? 'hidden' : 'hidden text-xs text-fg-subtle lg:block'}>
        Arrows move · Enter or type to edit · Tab next cell · Ctrl+Enter add item · Ctrl+Shift+Enter
        add section · Alt+Shift+arrows indent/move · Space folds a section · Ctrl+Home/End · Paste
        rows from Excel · Formulas like =12*3.5
      </p>
    </div>
  );
}

/** The date rates from analyses are taken as on, and re-pricing every linked item to it. */
function RatesBar({
  header,
  canEdit,
  onRefreshed,
}: {
  header: BoqHeader;
  canEdit: boolean;
  onRefreshed: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const setDate = async (rateDate: string) => {
    setMessage(null);
    try {
      const h = await api.request<BoqHeader>(`/api/tenant/boqs/${header.id}`, {
        method: 'POST',
        body: { rowVersion: header.rowVersion, rateDate },
      });
      qc.setQueryData(['boq', header.id], h);
    } catch (err) {
      setMessage({ tone: 'danger', text: describeError(err) });
    }
  };
  const refresh = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.request<{ changed: number; linked: number }>(
        `/api/tenant/boqs/${header.id}/refresh-rates`,
        { method: 'POST', body: {} },
      );
      setMessage({
        tone: 'success',
        text:
          r.linked === 0
            ? 'No items take their rate from an analysis yet.'
            : `${r.changed.toLocaleString('en-IN')} of ${r.linked.toLocaleString('en-IN')} linked items re-priced.`,
      });
      if (r.changed > 0) onRefreshed();
    } catch (err) {
      setMessage({ tone: 'danger', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
      <label className="flex items-center gap-2">
        Rates as on
        <Input
          type="date"
          aria-label="BOQ rates as on"
          className="h-8 w-40 py-1"
          value={header.rateDate ?? ''}
          disabled={!canEdit}
          onChange={(e) => e.target.value && void setDate(e.target.value)}
        />
      </label>
      {canEdit && (
        <Button
          variant="ghost"
          busy={busy}
          onClick={() => void refresh()}
          title="Re-price every item linked to a rate analysis, as on this date"
        >
          <RefreshCw className="size-4" aria-hidden /> Refresh rates
        </Button>
      )}
      {message && (
        <span role="status" className={message.tone === 'danger' ? 'text-danger' : 'text-success'}>
          {message.text}
        </span>
      )}
    </div>
  );
}

/** Choose a rate analysis for an item: shows each analysis' rate as on the BOQ's rate date. */
function AnalysisPicker({
  row,
  rateDate,
  onDone,
}: {
  row: BoqRow;
  rateDate: string;
  onDone: (id: string | null) => void;
}) {
  const [search, setSearch] = useState(row.description.slice(0, 30));
  const q = useDeferredValue(search.trim());
  const list = useQuery({
    queryKey: ['rate-analyses', 'picker', q, rateDate],
    queryFn: () =>
      api.request<{ items: AnalysisSummary[] }>(
        `/api/tenant/rate-analyses?limit=20&asOf=${rateDate}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
  });
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-24"
      onKeyDown={(e) => e.key === 'Escape' && onDone(null)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a rate analysis"
        className="w-full max-w-2xl rounded-lg border border-line bg-surface p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-semibold">Rate from analysis</h2>
          <Button variant="ghost" aria-label="Close" onClick={() => onDone(null)}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <p className="mb-2 text-sm text-fg-muted">
          For “{row.description || row.code || 'this item'}”{row.unit ? ` (${row.unit})` : ''}.
          Rates as on {rateDate}.
        </p>
        <Input
          autoFocus
          aria-label="Search rate analyses"
          placeholder="Code or description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="mt-2 max-h-80 overflow-auto">
          {list.isPending ? (
            <Spinner />
          ) : list.isError ? (
            <Alert tone="danger">{describeError(list.error)}</Alert>
          ) : list.data.items.length === 0 ? (
            <p className="p-3 text-sm text-fg-muted">No analyses match.</p>
          ) : (
            <ul>
              {list.data.items.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    disabled={a.missing > 0}
                    onClick={() => onDone(a.id)}
                    className="flex w-full items-baseline gap-3 rounded px-2 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-60"
                  >
                    <span className="font-mono text-xs text-fg-muted">{a.code}</span>
                    <span className="min-w-0 flex-1 truncate">{a.description}</span>
                    <span className="shrink-0 tabular-nums">
                      {a.missing > 0 ? (
                        <Badge tone="danger">{a.missing} without rate</Badge>
                      ) : (
                        `₹${formatAmount(a.boqRate)} / ${a.unit}`
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** Download the BOQ as Excel (with outline levels) or CSV. Anyone who can read the BOQ can export it. */
function ExportMenu({ boqId }: { boqId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (format: 'xlsx' | 'csv', unpriced = false) => {
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = await api.download(
        `/api/tenant/boqs/${boqId}/export?format=${format}${unpriced ? '&unpriced=true' : ''}`,
      );
      saveFile(blob, fileName);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative">
      <Button
        variant="secondary"
        busy={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Download className="size-4" aria-hidden /> Export
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-line bg-surface p-1 shadow-lg"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2"
            onClick={() => void run('xlsx')}
          >
            Excel (.xlsx)
          </button>
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2"
            onClick={() => void run('csv')}
          >
            CSV (.csv)
          </button>
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2"
            title="Quantities without rates or amounts: for subcontractors' quotes"
            onClick={() => void run('xlsx', true)}
          >
            Without rates (.xlsx)
          </button>
        </div>
      )}
      {error && (
        <div className="absolute right-0 z-20 mt-1 w-72">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </div>
  );
}

/** BOQs of a tender, on the tender page. */
export function TenderBoqs({ tenderId, canEdit }: { tenderId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [adding, setAdding] = useState(false);
  const templates = useQuery({
    queryKey: ['boq-templates'],
    queryFn: () => api.request<BoqTemplate[]>('/api/tenant/boq-templates'),
    enabled: adding,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boqs = useQuery({
    queryKey: ['tender-boqs', tenderId],
    queryFn: () => api.request<BoqHeader[]>(`/api/tenant/tenders/${tenderId}/boqs`),
  });
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const b = templateId
        ? await api.request<{ id: string }>(`/api/tenant/tenders/${tenderId}/boqs/from-template`, {
            method: 'POST',
            body: { name, templateId },
          })
        : await api.request<BoqHeader>(`/api/tenant/tenders/${tenderId}/boqs`, {
            method: 'POST',
            body: { name },
          });
      await navigate({ to: '/boqs/$boqId', params: { boqId: b.id } });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <Card
      title="BOQs"
      actions={
        canEdit &&
        !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> New BOQ
          </Button>
        )
      }
    >
      {adding && (
        <form onSubmit={(e) => void create(e)} className="mb-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <Field label="BOQ name" hint="For example: Civil works, Interiors, MEP.">
              <Input
                name="boqName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </Field>
          </div>
          <Field label="Start from">
            <Select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-64"
              aria-label="Start from"
            >
              <option value="">An empty BOQ</option>
              {(templates.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({VERTICALS[t.vertical] ?? t.vertical}, {t.lineCount} lines)
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" busy={busy}>
            Create
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {boqs.isPending ? (
        <Spinner />
      ) : boqs.isError ? (
        <Alert tone="danger">{describeError(boqs.error)}</Alert>
      ) : boqs.data.length === 0 ? (
        <p className="text-sm text-fg-muted">No BOQ yet.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {[
            ...boqs.data.filter((b) => !b.archivedAt),
            ...boqs.data.filter((b) => b.archivedAt),
          ].map((b) => (
            <li
              key={b.id}
              className={`flex items-center justify-between gap-3 py-2 ${b.archivedAt ? 'opacity-60' : ''}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Link
                  to="/boqs/$boqId"
                  params={{ boqId: b.id }}
                  className="min-w-0 truncate font-medium text-accent hover:underline"
                >
                  {b.name}
                </Link>
                {b.archivedAt && <Badge tone="neutral">archived</Badge>}
              </span>
              <span className="shrink-0 text-right">
                <span className="tabular-nums">{formatInr(b.total)}</span>
                <span className="block text-xs text-fg-muted">
                  {b.itemCount.toLocaleString('en-IN')} items
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
