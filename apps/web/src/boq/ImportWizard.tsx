// Import a BOQ from Excel or CSV (docs/wave1-plan.md step 4): upload -> confirm sheet, header, columns and structure
// -> check (dry run) -> import. The server does the work in the background; this screen polls the job.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Select,
  Spinner,
  Stat,
  cx,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, saveFile } from '../api/client';
import type {
  ImportField,
  ImportJob,
  ImportRevision,
  ImportSettings,
  ImportStructure,
} from '../api/types';
import { describeError, formatInr } from '../lib/format';

const RUNNING: ImportJob['status'][] = ['scanning', 'validating', 'importing'];
/** Jobs that are over: the wizard starts afresh with a file picker. */
const FINISHED: ImportJob['status'][] = ['imported', 'cancelled'];

const FIELD_LABELS: { field: ImportField; label: string; hint?: string }[] = [
  { field: 'description', label: 'Description' },
  { field: 'code', label: 'Item no. / code' },
  { field: 'unit', label: 'Unit' },
  { field: 'qty', label: 'Quantity' },
  { field: 'rate', label: 'Rate' },
  { field: 'amount', label: 'Amount', hint: 'Only checked against quantity × rate.' },
  { field: 'notes', label: 'Notes / remarks' },
  { field: 'level', label: 'Level', hint: 'For the "level" structure.' },
  { field: 'type', label: 'Line type', hint: 'section, item or note.' },
];

const STRUCTURES: { value: ImportStructure; label: string; hint: string }[] = [
  {
    value: 'numbering',
    label: 'By item numbers (1, 1.1, 1.1.1)',
    hint: 'Depth comes from the item number. Rows with a number but no quantity or rate are sections; (a), (b) go under the line above.',
  },
  {
    value: 'headings',
    label: 'By headings',
    hint: 'A row without unit, quantity and rate starts a section; the lines below belong to it.',
  },
  {
    value: 'level',
    label: 'By a Level column',
    hint: 'Depth from a Level column (0 = top). Files exported from Aerolith use this.',
  },
  { value: 'flat', label: 'No sections', hint: 'Every row at the top level.' },
];

export const columnName = (i: number): string =>
  (i >= 26 ? columnName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

const sameSettings = (a: ImportSettings | null, b: ImportSettings | null) =>
  JSON.stringify(a) === JSON.stringify(b);

function Progress({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-fg-muted">{value}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded bg-surface-2"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full bg-accent transition-[width]" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function FilePicker({ boqId, onJob }: { boqId: string; onJob: (j: ImportJob) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const upload = useMutation({
    mutationFn: (file: File) => api.upload<ImportJob>(`/api/tenant/boqs/${boqId}/imports`, file),
    onSuccess: (job, file) => {
      onJob(job);
      toast.success(`${file.name} uploaded`);
    },
  });
  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) upload.mutate(f);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files);
  };
  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cx(
          'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center',
          over ? 'border-accent bg-accent/5' : 'border-line',
        )}
      >
        <FileSpreadsheet className="size-8 text-fg-subtle" aria-hidden />
        <p className="text-sm">
          Drop an Excel (.xlsx) or CSV file here, or
          <br />
          <span className="text-fg-muted">
            the BOQ goes into this empty BOQ; nothing is saved until you confirm.
          </span>
        </p>
        <Button busy={upload.isPending} onClick={() => input.current?.click()}>
          <Upload className="size-4" aria-hidden /> Choose file
        </Button>
        <input
          ref={input}
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="sr-only"
          aria-label="BOQ file"
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {upload.isError && <Alert tone="danger">{describeError(upload.error)}</Alert>}
      <p className="text-xs text-fg-muted">
        Old .xls files: open in Excel or LibreOffice and save as .xlsx first. Up to 100 MB (about
        two million lines).
      </p>
    </div>
  );
}

function SettingsForm({
  job,
  draft,
  setDraft,
}: {
  job: ImportJob;
  draft: ImportSettings;
  setDraft: (s: ImportSettings) => void;
}) {
  const sheet = job.sheets[draft.sheet];
  const header = sheet?.preview.find((r) => r.rowNo === draft.headerRow);
  const columns = Math.max(sheet?.columns ?? 0, header?.cells.length ?? 0);
  const label = (i: number) => {
    const h = header?.cells[i]?.trim();
    return h ? `${columnName(i)} · ${h.slice(0, 40)}` : `Column ${columnName(i)}`;
  };
  const fieldOf = new Map(Object.entries(draft.mapping).map(([f, c]) => [c, f as ImportField]));
  const structure = STRUCTURES.find((s) => s.value === draft.structure)!;

  const setColumn = (field: ImportField, value: string) => {
    const mapping = { ...draft.mapping };
    if (value === '') delete mapping[field];
    else {
      const col = Number(value);
      // A column feeds one field: taking it from another field clears that one.
      for (const [f, c] of Object.entries(mapping)) if (c === col) delete mapping[f as ImportField];
      mapping[field] = col;
    }
    setDraft({ ...draft, mapping });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {job.sheets.length > 1 && (
          <Field label="Sheet">
            <Select
              value={draft.sheet}
              onChange={(e) => {
                const i = Number(e.target.value);
                const d = job.sheets[i]!.detected;
                setDraft({ ...draft, sheet: i, ...d });
              }}
            >
              {job.sheets.map((s, i) => (
                <option key={i} value={i} disabled={s.rows === 0}>
                  {s.name} ({s.rows.toLocaleString('en-IN')} rows)
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Header row" hint="Rows up to and including it are skipped.">
          <Select
            value={draft.headerRow ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                headerRow: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          >
            <option value="">No header row</option>
            {sheet?.preview.map((r) => (
              <option key={r.rowNo} value={r.rowNo}>
                Row {r.rowNo}: {r.cells.filter(Boolean).join(' | ').slice(0, 60)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Sections" hint={structure.hint}>
          <Select
            value={draft.structure}
            onChange={(e) => setDraft({ ...draft, structure: e.target.value as ImportStructure })}
          >
            {STRUCTURES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <legend className="mb-2 text-sm font-medium">Columns</legend>
        {FIELD_LABELS.filter(
          (f) =>
            (f.field !== 'level' && f.field !== 'type') ||
            draft.structure === 'level' ||
            draft.mapping[f.field] !== undefined,
        ).map((f) => (
          <Field key={f.field} label={f.label} {...(f.hint ? { hint: f.hint } : {})}>
            <Select
              value={draft.mapping[f.field] ?? ''}
              onChange={(e) => setColumn(f.field, e.target.value)}
            >
              <option value="">Not in the file</option>
              {Array.from({ length: columns }, (_, i) => (
                <option key={i} value={i}>
                  {label(i)}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.normaliseUnits}
          onChange={(e) => setDraft({ ...draft, normaliseUnits: e.target.checked })}
        />
        Write units the standard way (Cu.M, m3 → cum)
      </label>

      {sheet && sheet.preview.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-medium">
            First rows of {sheet.name}{' '}
            <span className="font-normal text-fg-muted">
              ({sheet.rows.toLocaleString('en-IN')} rows in all)
            </span>
          </h3>
          <div className="max-h-72 overflow-auto rounded border border-line">
            <table className="w-full text-xs" aria-label="File preview">
              <thead className="sticky top-0 bg-surface-2">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-fg-muted">Row</th>
                  {Array.from({ length: columns }, (_, i) => (
                    <th key={i} className="px-2 py-1 text-left font-medium">
                      {columnName(i)}
                      {fieldOf.has(i) && (
                        <span className="ml-1">
                          <Badge tone="accent">
                            {FIELD_LABELS.find((f) => f.field === fieldOf.get(i))!.label}
                          </Badge>
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.preview.map((r) => (
                  <tr
                    key={r.rowNo}
                    className={cx(
                      'border-t border-line',
                      draft.headerRow !== null && r.rowNo < draft.headerRow && 'text-fg-subtle',
                      r.rowNo === draft.headerRow && 'bg-accent/10 font-medium',
                    )}
                  >
                    <td className="px-2 py-1 tabular-nums text-fg-muted">{r.rowNo}</td>
                    {Array.from({ length: columns }, (_, i) => (
                      <td key={i} className="max-w-64 truncate px-2 py-1" title={r.cells[i]}>
                        {r.cells[i]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const CHANGE_TONE = {
  added: 'success',
  removed: 'danger',
  changed: 'warning',
  moved: 'neutral',
} as const;

/** What a revised BOQ file changes in this draft, before anything is saved. */
function RevisionSummary({ r }: { r: ImportRevision }) {
  return (
    <div className="space-y-3" data-testid="revision-summary">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <Stat
          label="Matched"
          value={(r.matchedByCode + r.matchedByDescription).toLocaleString('en-IN')}
        />
        <Stat label="Changed" value={r.changed.toLocaleString('en-IN')} />
        <Stat label="Moved" value={r.moved.toLocaleString('en-IN')} />
        <Stat label="Added" value={r.added.toLocaleString('en-IN')} />
        <Stat
          label="Removed"
          value={r.removed.toLocaleString('en-IN')}
          tone={r.removed > 0 ? 'warning' : undefined}
        />
        <Stat label="Total after" value={formatInr(r.total)} />
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-muted">
        <li>
          Lines are matched by item code ({r.matchedByCode.toLocaleString('en-IN')}), then by
          description ({r.matchedByDescription.toLocaleString('en-IN')}). A line matched wrongly
          shows as removed and added.
        </li>
        {r.ratesKept > 0 && (
          <li>
            {r.ratesKept.toLocaleString('en-IN')} items have no rate in the file and keep this
            BOQ&apos;s rate
            {r.ratesFromFile > 0 &&
              `; ${r.ratesFromFile.toLocaleString('en-IN')} take the file's rate`}
            .
          </li>
        )}
        {r.measuredOverridden > 0 && (
          <li className="text-warning">
            {r.measuredOverridden.toLocaleString('en-IN')} measured items get the file&apos;s
            quantity; their measurement sheets are kept but no longer set the quantity.
          </li>
        )}
        <li>Blank cells in the file never clear what the BOQ has.</li>
      </ul>
      {r.samples.length > 0 && (
        <div className="max-h-64 overflow-auto rounded border border-line">
          <table className="w-full text-xs" aria-label="Changes">
            <tbody>
              {r.samples.map((c, n) => (
                <tr key={n} className="border-t border-line first:border-t-0">
                  <td className="w-20 px-2 py-1">
                    <Badge tone={CHANGE_TONE[c.change]}>{c.change}</Badge>
                  </td>
                  <td className="w-20 px-2 py-1 font-mono">{c.code ?? ''}</td>
                  <td className="px-2 py-1">{c.description}</td>
                  <td className="px-2 py-1 text-fg-muted">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Summary({
  job,
  skipErrors,
  setSkipErrors,
}: {
  job: ImportJob;
  skipErrors: boolean;
  setSkipErrors: (v: boolean) => void;
}) {
  const s = job.summary!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob } = await api.download(`/api/tenant/imports/${job.id}/issues`);
      saveFile(blob, `${job.fileName.replace(/\.[^.]+$/, '')} - issues.csv`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const errors = s.counts.errors;
  return (
    <div className="space-y-3" data-testid="import-summary">
      {s.revision && <RevisionSummary r={s.revision} />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat
          label={s.revision ? 'Lines in the file' : 'Lines to import'}
          value={s.lines.toLocaleString('en-IN')}
        />
        <Stat label="Sections" value={s.counts.sections.toLocaleString('en-IN')} />
        <Stat label="Items" value={s.counts.items.toLocaleString('en-IN')} />
        <Stat label={s.revision ? "File's total" : 'Total'} value={formatInr(s.total)} />
        <Stat
          label="Errors · warnings"
          value={`${errors.toLocaleString('en-IN')} · ${s.counts.warnings.toLocaleString('en-IN')}`}
          tone={errors > 0 ? 'danger' : s.counts.warnings > 0 ? 'warning' : undefined}
        />
      </div>
      {s.counts.unitsNormalised > 0 && (
        <p className="text-sm text-fg-muted">
          {s.counts.unitsNormalised.toLocaleString('en-IN')} units will be written the standard way.
        </p>
      )}
      {s.unknownUnits.length > 0 && (
        <p className="text-sm text-fg-muted">
          Units not in the units list (kept as written):{' '}
          {s.unknownUnits.map((u) => `${u.unit} (${u.rows})`).join(', ')}
        </p>
      )}
      {s.issues.length > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              Issues
              {s.moreIssues > 0 &&
                ` (first ${s.issues.length} of ${(s.issues.length + s.moreIssues).toLocaleString('en-IN')})`}
            </h3>
            <Button variant="ghost" busy={busy} onClick={() => void report()}>
              <Download className="size-4" aria-hidden /> Download all issues
            </Button>
          </div>
          <div className="max-h-56 overflow-auto rounded border border-line">
            <table className="w-full text-xs" aria-label="Issues">
              <tbody>
                {s.issues.map((i, n) => (
                  <tr key={n} className="border-t border-line first:border-t-0">
                    <td className="w-16 px-2 py-1 tabular-nums text-fg-muted">Row {i.rowNo}</td>
                    <td className="w-20 px-2 py-1">
                      <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>
                        {i.severity}
                      </Badge>
                    </td>
                    <td className="px-2 py-1">{i.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {errors > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={skipErrors}
            onChange={(e) => setSkipErrors(e.target.checked)}
          />
          Import without the rows that have errors
        </label>
      )}
    </div>
  );
}

/** The newest import job of a BOQ, polled while it runs. */
export function useLatestImport(boqId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['boq-import', boqId],
    queryFn: () =>
      api.request<{ job: ImportJob | null }>(`/api/tenant/boqs/${boqId}/imports/latest`),
    enabled,
    refetchInterval: (q) =>
      q.state.data?.job && RUNNING.includes(q.state.data.job.status) ? 700 : false,
  });
}

/** Calls `onImported` when an import into this BOQ finishes while the screen is open. */
export function useImportFinished(job: ImportJob | null | undefined, onImported: () => void) {
  const last = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    if (!job) return;
    const prev = last.current;
    last.current = { id: job.id, status: job.status };
    if (prev?.id === job.id && prev.status === 'importing' && job.status === 'imported') {
      toast.success(
        job.summary?.revision
          ? 'Revised BOQ applied'
          : `${job.summary?.lines.toLocaleString('en-IN') ?? 'All'} lines imported`,
      );
      onImported();
    }
  }, [job, onImported]);
}

export function ImportBanner({ job }: { job: ImportJob }) {
  return (
    <Alert tone="info">
      Importing {job.fileName}: {job.progress}%. The BOQ cannot be edited until it finishes.
    </Alert>
  );
}

/** The import wizard, shown in place of the grid while open. */
export function ImportWizard({
  boqId,
  onClose,
  revising = false,
}: {
  boqId: string;
  onClose: () => void;
  /** The BOQ has lines: the file is a revised BOQ (step 8). */
  revising?: boolean;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const latest = useLatestImport(boqId, true);
  const setJob = (job: ImportJob) => qc.setQueryData(['boq-import', boqId], { job });
  const job =
    latest.data?.job && !FINISHED.includes(latest.data.job.status) ? latest.data.job : null;

  const [draft, setDraft] = useState<ImportSettings | null>(null);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [skipErrors, setSkipErrors] = useState(false);
  useEffect(() => {
    if (job?.settings && draftFor !== job.id) {
      setDraft(job.settings);
      setDraftFor(job.id);
    }
  }, [job, draftFor]);

  const act = useMutation({
    mutationFn: (a: 'validate' | 'start' | 'cancel') =>
      api.request<ImportJob>(`/api/tenant/imports/${job!.id}/${a}`, {
        method: 'POST',
        body: a === 'validate' ? draft : a === 'start' ? { skipErrors } : {},
      }),
    onSuccess: (j, a) => {
      setJob(j);
      if (a === 'start') toast.success('Import started');
    },
  });

  const dirty = job !== null && draft !== null && !sameSettings(draft, job.settings);
  const canCheck =
    draft !== null && (draft.mapping.description !== undefined || draft.mapping.code !== undefined);

  let body;
  if (latest.isPending) body = <Spinner />;
  else if (latest.isError) body = <Alert tone="danger">{describeError(latest.error)}</Alert>;
  else if (!job)
    body = (
      <div className="space-y-3">
        {revising && (
          <Alert tone="info">
            The file is the client&apos;s revised BOQ. Its lines are matched to this draft&apos;s by
            item code, then by description; checking it lists what changes, is added, moved or
            removed before anything is saved. Rates the file leaves blank are kept, so a client BOQ
            without rates keeps your pricing.
          </Alert>
        )}
        <FilePicker boqId={boqId} onJob={setJob} />
      </div>
    );
  else if (job.status === 'scanning')
    body = <Progress label="Reading the file" value={job.progress} />;
  else if (job.status === 'importing')
    body = (
      <div className="space-y-3">
        <Progress
          label={`Importing ${job.summary?.lines.toLocaleString('en-IN') ?? ''} lines`}
          value={job.progress}
        />
        <p className="text-sm text-fg-muted">
          The BOQ cannot be edited until this finishes. You can close this and come back.
        </p>
        <Button
          variant="secondary"
          busy={act.isPending}
          onClick={async () => {
            if (
              !(await confirm({
                title: 'Cancel the import?',
                body: 'Lines imported so far are taken out again and the BOQ stays as it was.',
                confirmLabel: 'Cancel the import',
                cancelLabel: 'Keep importing',
                tone: 'danger',
              }))
            )
              return;
            act.mutate('cancel', { onSuccess: () => toast.success('Import cancelled') });
          }}
        >
          Cancel import
        </Button>
      </div>
    );
  else if (!draft) body = <Spinner />;
  else
    body = (
      <div className="space-y-5">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <FileSpreadsheet className="size-4 text-fg-muted" aria-hidden />
          <span className="font-medium">{job.fileName}</span>
          <span className="text-fg-muted">{(job.fileSize / 1024 / 1024).toFixed(1)} MB</span>
          <Button
            variant="ghost"
            busy={act.isPending && act.variables === 'cancel'}
            onClick={() => act.mutate('cancel')}
          >
            Use another file
          </Button>
        </p>
        <SettingsForm job={job} draft={draft} setDraft={setDraft} />
        {job.status === 'failed' && job.error && <Alert tone="danger">{job.error}</Alert>}
        {job.status === 'validating' ? (
          <Progress label="Checking every row" value={job.progress} />
        ) : job.status === 'validated' && job.summary && !dirty ? (
          <>
            <Summary job={job} skipErrors={skipErrors} setSkipErrors={setSkipErrors} />
            <div className="flex flex-wrap gap-2">
              <Button
                busy={act.isPending && act.variables === 'start'}
                disabled={job.summary.lines === 0 || (job.summary.counts.errors > 0 && !skipErrors)}
                onClick={() => act.mutate('start')}
              >
                {job.summary.revision
                  ? 'Apply the revision'
                  : `Import ${job.summary.lines.toLocaleString('en-IN')} lines`}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              busy={act.isPending && act.variables === 'validate'}
              disabled={!canCheck}
              onClick={() => act.mutate('validate')}
            >
              Check file
            </Button>
            <span className="text-sm text-fg-muted">
              {canCheck
                ? 'Reads every row and lists problems. Nothing is saved yet.'
                : 'Choose the description column first.'}
            </span>
          </div>
        )}
        {act.isError && <Alert tone="danger">{describeError(act.error)}</Alert>}
      </div>
    );

  return (
    <Card
      className="min-h-0 flex-1 overflow-auto"
      title={revising ? 'Import a revised BOQ' : 'Import from Excel or CSV'}
      actions={
        <Button variant="ghost" onClick={onClose} aria-label="Close import">
          <X className="size-4" aria-hidden />
        </Button>
      }
    >
      {body}
    </Card>
  );
}
