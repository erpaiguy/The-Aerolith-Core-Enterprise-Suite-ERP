// A day's site report (docs/wave2b-plan.md step 7), made for a phone: one column, big targets, saved as you go. Each
// change is kept on the phone first and saved a moment later; with no signal it is kept and saved when the signal
// comes back, so nothing typed is lost even if the page is closed. Photos are shrunk on the phone before upload.
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
  Textarea,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Camera, Plus, Printer, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Party } from '../api/types';
import { formatQty } from '../boq/model';
import { describeError, formatDateTime } from '../lib/format';
import {
  ACCOUNT,
  CAUSE,
  DSR_STATUS,
  DSR_TONE,
  TRADES,
  WEATHER,
  type Account,
  type Cause,
  type DailyReport,
  type EquipmentLine,
  type HindranceLine,
  type ManpowerLine,
  type Weather,
  type WorkLine,
} from '../project/daily';
import { shortDate } from '../schedule/model';

interface Draft {
  weatherAm: Weather | null;
  weatherPm: Weather | null;
  rainHours: string;
  safety: string;
  visitors: string;
  notes: string;
  manpower: ManpowerLine[];
  equipment: EquipmentLine[];
  work: WorkLine[];
  hindrances: HindranceLine[];
}

const trim = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);
const toDraft = (r: DailyReport): Draft => ({
  weatherAm: r.weatherAm,
  weatherPm: r.weatherPm,
  rainHours: r.rainHours ? trim(r.rainHours) : '',
  safety: r.safety,
  visitors: r.visitors,
  notes: r.notes,
  manpower: r.manpower.map((m) => ({
    trade: m.trade,
    partyId: m.partyId,
    headcount: m.headcount,
    note: m.note,
  })),
  equipment: r.equipment.map((e) => ({
    ...e,
    hoursWorked: trim(e.hoursWorked),
    hoursIdle: trim(e.hoursIdle),
  })),
  work: r.work.map((w) => ({
    boqCode: w.boqCode,
    description: w.description,
    qty: w.qty ? trim(w.qty) : '',
    unit: w.unit,
  })),
  hindrances: r.hindrances.map((h) => ({ ...h, hours: trim(h.hours) })),
});
/** What the server takes: blank lines left out. */
const body = (d: Draft) => ({
  weatherAm: d.weatherAm,
  weatherPm: d.weatherPm,
  rainHours: d.rainHours.trim() || null,
  safety: d.safety,
  visitors: d.visitors,
  notes: d.notes,
  manpower: d.manpower.filter((m) => m.trade.trim() && m.headcount > 0),
  equipment: d.equipment
    .filter((e) => e.name.trim())
    .map((e) => ({ ...e, hoursWorked: e.hoursWorked || '0', hoursIdle: e.hoursIdle || '0' })),
  work: d.work
    .filter((w) => w.description.trim())
    .map((w) => ({ ...w, boqCode: w.boqCode?.trim() || null, qty: w.qty?.trim() || null })),
  hindrances: d.hindrances.filter((h) => h.description.trim() && Number(h.hours) > 0),
});
const backupKey = (id: string) => `aerolith.dsr.${id}`;
function readBackup(id: string): { base: number; draft: Draft } | null {
  try {
    const raw = localStorage.getItem(backupKey(id));
    return raw ? (JSON.parse(raw) as { base: number; draft: Draft }) : null;
  } catch {
    return null;
  }
}
function writeBackup(id: string, base: number, draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(backupKey(id), JSON.stringify({ base, draft }));
    else localStorage.removeItem(backupKey(id));
  } catch {
    // Private mode or full storage: saving to the server still works.
  }
}

/** Shrinks a camera photo to at most 1600 px on its long side, as a JPEG, before it is sent. */
async function shrink(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.8));
    return blob && blob.size < file.size
      ? new File([blob], 'photo.jpg', { type: 'image/jpeg' })
      : file;
  } catch {
    return file;
  }
}

export function DailyReportScreen({ reportId }: { reportId: string }) {
  const r = useQuery({
    queryKey: ['daily-report', reportId],
    queryFn: () => api.request<DailyReport>(`/api/tenant/daily-reports/${reportId}`),
    // An editor keeps its own copy; it is not replaced under the person typing.
    refetchOnWindowFocus: false,
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  return <ReportView key={`${r.data.status}-${r.data.mayEdit}`} initial={r.data} />;
}

type SaveState = 'saved' | 'waiting' | 'saving' | 'offline' | 'failed';

function ReportView({ initial }: { initial: DailyReport }) {
  const qc = useQueryClient();
  const [r, setR] = useState(initial);
  const backup = initial.mayEdit ? readBackup(initial.id) : null;
  const restored = backup && backup.base === initial.rowVersion ? backup.draft : null;
  const [draft, setDraftState] = useState<Draft>(restored ?? toDraft(initial));
  const [state, setState] = useState<SaveState>(restored ? 'waiting' : 'saved');
  const [error, setError] = useState<string | null>(
    backup && !restored
      ? 'Changes kept on this phone were older than the saved report, which someone changed since: they were not used.'
      : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const version = useRef(initial.rowVersion);
  const latest = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (backup && !restored) writeBackup(initial.id, 0, null);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const sent = latest.current;
    setState('saving');
    try {
      const next = await api.request<DailyReport>(`/api/tenant/daily-reports/${r.id}`, {
        method: 'POST',
        body: { rowVersion: version.current, ...body(sent) },
      });
      version.current = next.rowVersion;
      setR(next);
      qc.setQueryData(['daily-report', r.id], next);
      if (latest.current === sent) {
        writeBackup(r.id, 0, null);
        setState('saved');
        setError(null);
      } else {
        writeBackup(r.id, next.rowVersion, latest.current);
        setState('waiting');
        timer.current = setTimeout(() => void save(), 1500);
      }
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        // No signal: kept on the phone, tried again shortly.
        setState('offline');
        timer.current = setTimeout(() => void save(), 10_000);
      } else {
        setState('failed');
        setError(describeError(err));
      }
      return false;
    }
  }, [qc, r.id]);

  useEffect(() => {
    if (restored) timer.current = setTimeout(() => void save(), 500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // Once, for changes restored from the phone.
  }, []);

  const setDraft = (d: Draft) => {
    latest.current = d;
    setDraftState(d);
    writeBackup(r.id, version.current, d);
    if (state !== 'offline') setState('waiting');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 1500);
  };

  const act = async (k: string, path: string, payload: object) => {
    setBusy(k);
    setError(null);
    try {
      if (k === 'submit' && state !== 'saved' && !(await save())) return;
      const next = await api.request<DailyReport>(`/api/tenant/daily-reports/${r.id}/${path}`, {
        method: 'POST',
        body: k === 'submit' ? { rowVersion: version.current } : payload,
      });
      qc.setQueryData(['daily-report', r.id], next);
      void qc.invalidateQueries({ queryKey: ['daily-reports', r.project.id] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const editing = r.mayEdit;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        to="/projects/$projectId/daily-reports"
        params={{ projectId: r.project.id }}
        search={{ site: r.site.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> Daily reports · {r.project.name}
      </Link>
      <PageHeader
        title={`${r.site.name}, ${shortDate(r.reportDate)}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={DSR_TONE[r.status]}>{DSR_STATUS[r.status]}</Badge>
            {editing && <SaveBadge state={state} />}
            <span className="text-xs">
              {r.project.number} · {r.project.name}
            </span>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            {r.maySubmit && (
              <Button busy={busy === 'submit'} onClick={() => void act('submit', 'submit', {})}>
                <Send className="size-4" aria-hidden /> Submit
              </Button>
            )}
            {r.mayAcknowledge && (
              <Button busy={busy === 'ack'} onClick={() => void act('ack', 'acknowledge', {})}>
                Acknowledge
              </Button>
            )}
            {r.mayCorrect && (
              <Button
                variant="secondary"
                busy={busy === 'correct'}
                onClick={() => {
                  const reason = window.prompt('What needs correcting?');
                  if (reason && reason.trim().length >= 3)
                    void act('correct', 'correct', { reason: reason.trim() });
                }}
              >
                Correct
              </Button>
            )}
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer className="size-4" aria-hidden /> Print
            </Button>
          </div>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {editing ? <Editor reportId={r.id} draft={draft} setDraft={setDraft} /> : <ReadOnly r={r} />}
      <Photos
        r={r}
        editing={editing}
        onChanged={(next) => {
          version.current = next.rowVersion;
          setR(next);
          qc.setQueryData(['daily-report', r.id], next);
        }}
      />
      {(r.equipmentLogs?.length ?? 0) > 0 && (
        <Card title="Equipment log sheets">
          <ul className="space-y-1 text-sm" aria-label="Equipment log sheets">
            {r.equipmentLogs!.map((l) => (
              <li key={l.code}>
                <span className="font-mono text-xs">{l.code}</span> {l.name}: worked{' '}
                {Number(l.worked)}
                {Number(l.idleHours) > 0 &&
                  `, idle ${Number(l.idleHours)} (${l.idleReason || 'no reason'})`}
                {Number(l.breakdownHours) > 0 && `, broken down ${Number(l.breakdownHours)}`}
                {l.operator && <span className="text-fg-muted"> · {l.operator}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {(r.muster?.length ?? 0) > 0 && (
        <Card title="Contract labour mustered">
          <ul className="space-y-1 text-sm" aria-label="Contract labour mustered">
            {r.muster!.map((m) => (
              <li key={`${m.contractor}-${m.trade}`}>
                {m.contractor}, {m.trade}: {m.present} present
                {m.halfDays > 0 && `, ${m.halfDays} half day`}
                {Number(m.overtimeHours) > 0 && `, ${Number(m.overtimeHours)} hours' overtime`}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Received today">
        {r.received.length === 0 ? (
          <p className="text-sm text-fg-muted">No goods received at this site on this day.</p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label="Received today">
            {r.received.map((x, i) => (
              <li key={i}>
                <Link
                  to="/receipts/$receiptId"
                  params={{ receiptId: x.receiptId }}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {x.number}
                </Link>{' '}
                {x.description}: {formatQty(x.qty)} {x.unit}
                {x.inspection === 'hold' && <span className="text-warning"> (held)</span>}
                {Number(x.rejected) > 0 && (
                  <span className="text-fg-muted"> ({formatQty(x.rejected)} rejected)</span>
                )}
                <span className="text-fg-muted"> · {x.vendor}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Issued to work today">
        {r.issued.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Nothing issued from this site&apos;s stores on this day.
          </p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label="Issued today">
            {r.issued.map((x, i) => (
              <li key={i}>
                <Link
                  to="/issues/$issueId"
                  params={{ issueId: x.issueId }}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {x.number}
                </Link>{' '}
                {x.name}: {formatQty(x.qty)} {x.unit} to {x.wbsCode}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {r.events.length > 0 && (
        <Card title="History">
          <ul className="space-y-1 text-sm" aria-label="History">
            {r.events.map((e, i) => (
              <li key={i}>
                {e.kind === 'submitted'
                  ? 'Submitted'
                  : e.kind === 'acknowledged'
                    ? 'Acknowledged'
                    : 'Corrected'}{' '}
                by {e.actor ?? '?'}, {formatDateTime(e.at)}
                {e.comment && <span className="text-fg-muted"> · {e.comment}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  const text: Record<SaveState, string> = {
    saved: 'Saved',
    waiting: 'Saving soon',
    saving: 'Saving…',
    offline: 'No signal: kept on this phone, will save',
    failed: 'Not saved',
  };
  return (
    <span
      className={`text-xs ${state === 'offline' || state === 'failed' ? 'text-warning' : 'text-fg-muted'}`}
      data-testid="save-state"
      aria-live="polite"
    >
      {text[state]}
    </span>
  );
}

function Editor({
  reportId,
  draft,
  setDraft,
}: {
  reportId: string;
  draft: Draft;
  setDraft: (d: Draft) => void;
}) {
  const contractors = useQuery({
    queryKey: ['parties', 'subcontractor'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=subcontractor'),
  });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const line = <K extends 'manpower' | 'equipment' | 'work' | 'hindrances'>(
    k: K,
    i: number,
    patch: Partial<Draft[K][number]>,
  ) => set(k, draft[k].map((x, j) => (j === i ? { ...x, ...patch } : x)) as Draft[K]);
  const drop = (k: 'manpower' | 'equipment' | 'work' | 'hindrances', i: number) =>
    set(k, draft[k].filter((_, j) => j !== i) as never);
  const removeBtn = (
    k: 'manpower' | 'equipment' | 'work' | 'hindrances',
    i: number,
    what: string,
  ) => (
    <Button type="button" variant="ghost" aria-label={`Remove ${what}`} onClick={() => drop(k, i)}>
      <Trash2 className="size-4" aria-hidden />
    </Button>
  );
  return (
    <form className="space-y-4" aria-label="Daily report" onSubmit={(e) => e.preventDefault()}>
      <datalist id={`trades-${reportId}`}>
        {TRADES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Card title="Weather">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {(['weatherAm', 'weatherPm'] as const).map((k) => (
            <Field key={k} label={k === 'weatherAm' ? 'Morning' : 'Afternoon'}>
              <Select
                value={draft[k] ?? ''}
                onChange={(e) => set(k, (e.target.value || null) as Weather | null)}
              >
                <option value="">Not said</option>
                {Object.entries(WEATHER).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
          <Field label="Rain (hours)">
            <Input
              inputMode="decimal"
              value={draft.rainHours}
              onChange={(e) => set('rainHours', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card title={`Manpower (${draft.manpower.reduce((s, m) => s + (m.headcount || 0), 0)})`}>
        <div className="space-y-3">
          {draft.manpower.map((m, i) => (
            <div
              key={i}
              role="group"
              aria-label={`Manpower ${i + 1}`}
              className="grid grid-cols-[1fr_5rem_auto] items-end gap-2 border-b border-line pb-3 sm:grid-cols-[1fr_1fr_5rem_auto]"
            >
              <Field label="Trade">
                <Input
                  list={`trades-${reportId}`}
                  value={m.trade}
                  maxLength={100}
                  onChange={(e) => line('manpower', i, { trade: e.target.value })}
                />
              </Field>
              <div className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto">
                <Field label="Whose">
                  <Select
                    value={m.partyId ?? ''}
                    onChange={(e) => line('manpower', i, { partyId: e.target.value || null })}
                  >
                    <option value="">Our own</option>
                    {contractors.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Number">
                <Input
                  inputMode="numeric"
                  value={m.headcount ? String(m.headcount) : ''}
                  onChange={(e) =>
                    line('manpower', i, {
                      headcount: Number(e.target.value.replace(/\D/g, '')) || 0,
                    })
                  }
                />
              </Field>
              {removeBtn('manpower', i, `manpower ${i + 1}`)}
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              set('manpower', [
                ...draft.manpower,
                { trade: '', partyId: null, headcount: 0, note: '' },
              ])
            }
          >
            <Plus className="size-4" aria-hidden /> Trade
          </Button>
        </div>
      </Card>

      <Card title="Equipment">
        <div className="space-y-3">
          {draft.equipment.map((x, i) => (
            <div
              key={i}
              role="group"
              aria-label={`Equipment ${i + 1}`}
              className="grid grid-cols-2 items-end gap-2 border-b border-line pb-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
            >
              <div className="col-span-2 sm:col-span-1">
                <Field label="Equipment">
                  <Input
                    value={x.name}
                    maxLength={200}
                    onChange={(e) => line('equipment', i, { name: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Own or hired">
                <Select
                  value={x.ownership}
                  onChange={(e) =>
                    line('equipment', i, { ownership: e.target.value as 'own' | 'hired' })
                  }
                >
                  <option value="own">Own</option>
                  <option value="hired">Hired</option>
                </Select>
              </Field>
              <Field label="Hours worked">
                <Input
                  inputMode="decimal"
                  value={x.hoursWorked}
                  onChange={(e) => line('equipment', i, { hoursWorked: e.target.value })}
                />
              </Field>
              <Field label="Hours idle">
                <Input
                  inputMode="decimal"
                  value={x.hoursIdle}
                  onChange={(e) => line('equipment', i, { hoursIdle: e.target.value })}
                />
              </Field>
              {removeBtn('equipment', i, `equipment ${i + 1}`)}
              {Number(x.hoursIdle) > 0 && (
                <div className="col-span-2 sm:col-span-5">
                  <Field label="Why idle">
                    <Input
                      value={x.idleReason}
                      maxLength={500}
                      onChange={(e) => line('equipment', i, { idleReason: e.target.value })}
                    />
                  </Field>
                </div>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              set('equipment', [
                ...draft.equipment,
                {
                  name: '',
                  ownership: 'own',
                  count: 1,
                  hoursWorked: '',
                  hoursIdle: '',
                  idleReason: '',
                },
              ])
            }
          >
            <Plus className="size-4" aria-hidden /> Equipment
          </Button>
        </div>
      </Card>

      <Card title="Work done">
        <p className="mb-3 text-xs text-fg-muted">
          The site&apos;s account of the day. What is billed is measured in the measurement book.
        </p>
        <div className="space-y-3">
          {draft.work.map((w, i) => (
            <div
              key={i}
              role="group"
              aria-label={`Work ${i + 1}`}
              className="grid grid-cols-3 items-end gap-2 border-b border-line pb-3 sm:grid-cols-[3fr_1fr_1fr_1fr_auto]"
            >
              <div className="col-span-3 sm:col-span-1">
                <Field label="What">
                  <Input
                    value={w.description}
                    maxLength={1000}
                    onChange={(e) => line('work', i, { description: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="BOQ item">
                <Input
                  value={w.boqCode ?? ''}
                  maxLength={40}
                  onChange={(e) => line('work', i, { boqCode: e.target.value })}
                />
              </Field>
              <Field label="Quantity">
                <Input
                  inputMode="decimal"
                  value={w.qty ?? ''}
                  onChange={(e) => line('work', i, { qty: e.target.value })}
                />
              </Field>
              <Field label="Unit">
                <Input
                  value={w.unit}
                  maxLength={20}
                  onChange={(e) => line('work', i, { unit: e.target.value })}
                />
              </Field>
              {removeBtn('work', i, `work ${i + 1}`)}
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              set('work', [...draft.work, { boqCode: null, description: '', qty: '', unit: '' }])
            }
          >
            <Plus className="size-4" aria-hidden /> Work
          </Button>
        </div>
      </Card>

      <Card title="Hindrances">
        <div className="space-y-3">
          {draft.hindrances.map((h, i) => (
            <div
              key={i}
              role="group"
              aria-label={`Hindrance ${i + 1}`}
              className="grid grid-cols-2 items-end gap-2 border-b border-line pb-3 sm:grid-cols-[1fr_2fr_6rem_1fr_auto]"
            >
              <Field label="Cause">
                <Select
                  value={h.cause}
                  onChange={(e) => line('hindrances', i, { cause: e.target.value as Cause })}
                >
                  {Object.entries(CAUSE).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Hours lost">
                <Input
                  inputMode="decimal"
                  value={h.hours}
                  onChange={(e) => line('hindrances', i, { hours: e.target.value })}
                />
              </Field>
              <div className="col-span-2 sm:col-span-1 sm:row-start-1 sm:col-start-2">
                <Field label="What happened">
                  <Input
                    value={h.description}
                    maxLength={1000}
                    onChange={(e) => line('hindrances', i, { description: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="On whose account">
                <Select
                  value={h.account}
                  onChange={(e) => line('hindrances', i, { account: e.target.value as Account })}
                >
                  {Object.entries(ACCOUNT).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              {removeBtn('hindrances', i, `hindrance ${i + 1}`)}
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              set('hindrances', [
                ...draft.hindrances,
                { cause: 'rain', description: '', hours: '', account: 'neutral' },
              ])
            }
          >
            <Plus className="size-4" aria-hidden /> Hindrance
          </Button>
        </div>
      </Card>

      <Card title="Safety, visitors, notes">
        <div className="space-y-3">
          <Field label="Safety">
            <Textarea
              rows={2}
              value={draft.safety}
              maxLength={4000}
              onChange={(e) => set('safety', e.target.value)}
            />
          </Field>
          <Field label="Visitors">
            <Textarea
              rows={2}
              value={draft.visitors}
              maxLength={2000}
              onChange={(e) => set('visitors', e.target.value)}
            />
          </Field>
          <Field label="Notes">
            <Textarea
              rows={3}
              value={draft.notes}
              maxLength={8000}
              onChange={(e) => set('notes', e.target.value)}
            />
          </Field>
        </div>
      </Card>
    </form>
  );
}

function ReadOnly({ r }: { r: DailyReport }) {
  return (
    <Card>
      <dl
        className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]"
        data-testid="report-summary"
      >
        <dt className="text-fg-muted">Weather</dt>
        <dd>
          {r.weatherAm ? WEATHER[r.weatherAm] : '-'} / {r.weatherPm ? WEATHER[r.weatherPm] : '-'}
          {r.rainHours && Number(r.rainHours) > 0 && `, rain ${trim(r.rainHours)} h`}
        </dd>
        <dt className="text-fg-muted">Manpower</dt>
        <dd>
          {r.manpower.length === 0
            ? '-'
            : r.manpower
                .map((m) => `${m.trade} ${m.headcount}${m.contractor ? ` (${m.contractor})` : ''}`)
                .join(', ')}
        </dd>
        <dt className="text-fg-muted">Equipment</dt>
        <dd>
          {r.equipment.length === 0
            ? '-'
            : r.equipment
                .map(
                  (e) =>
                    `${e.name} (${e.ownership}): ${trim(e.hoursWorked)} h worked${
                      Number(e.hoursIdle) > 0
                        ? `, ${trim(e.hoursIdle)} h idle${e.idleReason ? ` (${e.idleReason})` : ''}`
                        : ''
                    }`,
                )
                .join('; ')}
        </dd>
        <dt className="text-fg-muted">Work done</dt>
        <dd>
          {r.work.length === 0
            ? '-'
            : r.work
                .map(
                  (w) =>
                    `${w.boqCode ? `${w.boqCode}: ` : ''}${w.description}${w.qty ? ` ${trim(w.qty)} ${w.unit}` : ''}`,
                )
                .join('; ')}
        </dd>
        <dt className="text-fg-muted">Hindrances</dt>
        <dd>
          {r.hindrances.length === 0
            ? '-'
            : r.hindrances
                .map(
                  (h) =>
                    `${CAUSE[h.cause]}: ${h.description}, ${trim(h.hours)} h (${ACCOUNT[h.account]})`,
                )
                .join('; ')}
        </dd>
        {r.safety && (
          <>
            <dt className="text-fg-muted">Safety</dt>
            <dd className="whitespace-pre-wrap">{r.safety}</dd>
          </>
        )}
        {r.visitors && (
          <>
            <dt className="text-fg-muted">Visitors</dt>
            <dd className="whitespace-pre-wrap">{r.visitors}</dd>
          </>
        )}
        {r.notes && (
          <>
            <dt className="text-fg-muted">Notes</dt>
            <dd className="whitespace-pre-wrap">{r.notes}</dd>
          </>
        )}
        {r.submittedBy && (
          <>
            <dt className="text-fg-muted">Submitted</dt>
            <dd>
              {r.submittedBy}, {formatDateTime(r.submittedAt!)}
              {r.acknowledgedBy && `; acknowledged by ${r.acknowledgedBy}`}
            </dd>
          </>
        )}
      </dl>
    </Card>
  );
}

function Photos({
  r,
  editing,
  onChanged,
}: {
  r: DailyReport;
  editing: boolean;
  onChanged: (next: DailyReport) => void;
}) {
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      let next: DailyReport | null = null;
      for (const f of Array.from(files))
        next = await api.upload<DailyReport>(
          `/api/tenant/daily-reports/${r.id}/photos?caption=${encodeURIComponent(caption.trim())}`,
          await shrink(f),
        );
      if (next) onChanged(next);
      setCaption('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Card title={`Photos (${r.photos.length})`}>
      {r.photos.length > 0 && (
        <ul className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Photos">
          {r.photos.map((p) => (
            <li key={p.id} className="space-y-1">
              <Photo reportId={r.id} id={p.id} caption={p.caption} />
              <div className="flex items-start justify-between gap-1 text-xs">
                <span>{p.caption}</span>
                {editing && (
                  <button
                    type="button"
                    className="text-fg-muted hover:text-danger print:hidden"
                    aria-label={`Remove photo ${p.caption}`}
                    onClick={() =>
                      void api
                        .request<DailyReport>(
                          `/api/tenant/daily-reports/${r.id}/photos/${p.id}/remove`,
                          {
                            method: 'POST',
                            body: {},
                          },
                        )
                        .then(onChanged, (e: unknown) => setError(describeError(e)))
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <div className="flex flex-wrap items-end gap-2 print:hidden">
          <div className="min-w-48 flex-1">
            <Field label="Caption">
              <Input value={caption} maxLength={300} onChange={(e) => setCaption(e.target.value)} />
            </Field>
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            aria-label="Photo file"
            onChange={(e) => void add(e.target.files)}
          />
          <Button type="button" busy={busy} onClick={() => input.current?.click()}>
            <Camera className="size-4" aria-hidden /> Add photo
          </Button>
        </div>
      )}
      {!editing && r.photos.length === 0 && <p className="text-sm text-fg-muted">None.</p>}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

/** A photo fetched with the session (an <img> cannot send it), shown from memory. */
function Photo({ reportId, id, caption }: { reportId: string; id: string; caption: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    let made: string | null = null;
    void api.download(`/api/tenant/daily-reports/${reportId}/photos/${id}`).then(
      ({ blob }) => {
        if (gone) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => undefined,
    );
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [reportId, id]);
  return url ? (
    <img
      src={url}
      alt={caption || 'Site photo'}
      className="aspect-[4/3] w-full rounded-md object-cover"
    />
  ) : (
    <div className="aspect-[4/3] w-full rounded-md bg-surface-2" />
  );
}
