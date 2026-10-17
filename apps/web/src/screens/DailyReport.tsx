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
import { useT } from '../i18n/i18n';
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
import { sendOrKeep } from '../offline';
import { here, shrink as shrinkToDataUrl } from './labour/proof';

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
  const t = useT();
  const qc = useQueryClient();
  const [r, setR] = useState(initial);
  const backup = initial.mayEdit ? readBackup(initial.id) : null;
  const restored = backup && backup.base === initial.rowVersion ? backup.draft : null;
  const [draft, setDraftState] = useState<Draft>(restored ?? toDraft(initial));
  const [state, setState] = useState<SaveState>(restored ? 'waiting' : 'saved');
  const [error, setError] = useState<string | null>(
    backup && !restored
      ? t(
          'Changes kept on this phone were older than the saved report, which someone changed since: they were not used.',
        )
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
        <ArrowLeft className="size-4" aria-hidden /> {t('Daily reports')} · {r.project.name}
      </Link>
      <PageHeader
        title={`${r.site.name}, ${shortDate(r.reportDate)}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={DSR_TONE[r.status]}>{t(DSR_STATUS[r.status])}</Badge>
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
                <Send className="size-4" aria-hidden /> {t('Submit')}
              </Button>
            )}
            {r.mayAcknowledge && (
              <Button busy={busy === 'ack'} onClick={() => void act('ack', 'acknowledge', {})}>
                {t('Acknowledge')}
              </Button>
            )}
            {r.mayCorrect && (
              <Button
                variant="secondary"
                busy={busy === 'correct'}
                onClick={() => {
                  const reason = window.prompt(t('What needs correcting?'));
                  if (reason && reason.trim().length >= 3)
                    void act('correct', 'correct', { reason: reason.trim() });
                }}
              >
                {t('Correct')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer className="size-4" aria-hidden /> {t('Print')}
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
        <Card title={t('Equipment log sheets')}>
          <ul className="space-y-1 text-sm" aria-label={t('Equipment log sheets')}>
            {r.equipmentLogs!.map((l) => (
              <li key={l.code}>
                <span className="font-mono text-xs">{l.code}</span> {l.name}:{' '}
                {t('worked {n}', { n: Number(l.worked) })}
                {Number(l.idleHours) > 0 &&
                  t(', idle {n} ({reason})', {
                    n: Number(l.idleHours),
                    reason: l.idleReason || t('no reason'),
                  })}
                {Number(l.breakdownHours) > 0 &&
                  t(', broken down {n}', { n: Number(l.breakdownHours) })}
                {l.operator && <span className="text-fg-muted"> · {l.operator}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {(r.muster?.length ?? 0) > 0 && (
        <Card title={t('Contract labour mustered')}>
          <ul className="space-y-1 text-sm" aria-label={t('Contract labour mustered')}>
            {r.muster!.map((m) => (
              <li key={`${m.contractor}-${m.trade}`}>
                {m.contractor}, {m.trade}: {t('{n} present', { n: m.present })}
                {m.halfDays > 0 && t(', {n} half day', { n: m.halfDays })}
                {Number(m.overtimeHours) > 0 &&
                  t(", {n} hours' overtime", { n: Number(m.overtimeHours) })}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title={t('Received today')}>
        {r.received.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {t('No goods received at this site on this day.')}
          </p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label={t('Received today')}>
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
                {x.inspection === 'hold' && <span className="text-warning"> {t('(held)')}</span>}
                {Number(x.rejected) > 0 && (
                  <span className="text-fg-muted">
                    {' '}
                    {t('({n} rejected)', { n: formatQty(x.rejected) })}
                  </span>
                )}
                <span className="text-fg-muted"> · {x.vendor}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('Issued to work today')}>
        {r.issued.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {t("Nothing issued from this site's stores on this day.")}
          </p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label={t('Issued today')}>
            {r.issued.map((x, i) => (
              <li key={i}>
                <Link
                  to="/issues/$issueId"
                  params={{ issueId: x.issueId }}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {x.number}
                </Link>{' '}
                {x.name}: {formatQty(x.qty)} {x.unit} {t('to {code}', { code: x.wbsCode })}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {r.events.length > 0 && (
        <Card title={t('History')}>
          <ul className="space-y-1 text-sm" aria-label={t('History')}>
            {r.events.map((e, i) => (
              <li key={i}>
                {e.kind === 'submitted'
                  ? t('Submitted')
                  : e.kind === 'acknowledged'
                    ? t('Acknowledged')
                    : t('Corrected')}{' '}
                {t('by {name}, {at}', { name: e.actor ?? '?', at: formatDateTime(e.at) })}
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
  const t = useT();
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
      {t(text[state])}
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
  const t = useT();
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
    label: string,
  ) => (
    <Button type="button" variant="ghost" aria-label={label} onClick={() => drop(k, i)}>
      <Trash2 className="size-4" aria-hidden />
    </Button>
  );
  return (
    <form className="space-y-4" aria-label={t('Daily report')} onSubmit={(e) => e.preventDefault()}>
      <datalist id={`trades-${reportId}`}>
        {TRADES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Card title={t('Weather')}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {(['weatherAm', 'weatherPm'] as const).map((k) => (
            <Field key={k} label={k === 'weatherAm' ? t('Morning') : t('Afternoon')}>
              <Select
                value={draft[k] ?? ''}
                onChange={(e) => set(k, (e.target.value || null) as Weather | null)}
              >
                <option value="">{t('Not said')}</option>
                {Object.entries(WEATHER).map(([v, l]) => (
                  <option key={v} value={v}>
                    {t(l)}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
          <Field label={t('Rain (hours)')}>
            <Input
              inputMode="decimal"
              value={draft.rainHours}
              onChange={(e) => set('rainHours', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card
        title={t('Manpower ({n})', {
          n: draft.manpower.reduce((s, m) => s + (m.headcount || 0), 0),
        })}
      >
        <div className="space-y-3">
          {draft.manpower.map((m, i) => (
            <div
              key={i}
              role="group"
              aria-label={t('Manpower {n}', { n: i + 1 })}
              className="grid grid-cols-[1fr_5rem_auto] items-end gap-2 border-b border-line pb-3 sm:grid-cols-[1fr_1fr_5rem_auto]"
            >
              <Field label={t('Trade')}>
                <Input
                  list={`trades-${reportId}`}
                  value={m.trade}
                  maxLength={100}
                  onChange={(e) => line('manpower', i, { trade: e.target.value })}
                />
              </Field>
              <div className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto">
                <Field label={t('Whose')}>
                  <Select
                    value={m.partyId ?? ''}
                    onChange={(e) => line('manpower', i, { partyId: e.target.value || null })}
                  >
                    <option value="">{t('Our own')}</option>
                    {contractors.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label={t('Number')}>
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
              {removeBtn('manpower', i, t('Remove manpower {n}', { n: i + 1 }))}
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
            <Plus className="size-4" aria-hidden /> {t('Trade')}
          </Button>
        </div>
      </Card>

      <Card title={t('Equipment')}>
        <div className="space-y-3">
          {draft.equipment.map((x, i) => (
            <div
              key={i}
              role="group"
              aria-label={t('Equipment {n}', { n: i + 1 })}
              className="grid grid-cols-2 items-end gap-2 border-b border-line pb-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
            >
              <div className="col-span-2 sm:col-span-1">
                <Field label={t('Equipment')}>
                  <Input
                    value={x.name}
                    maxLength={200}
                    onChange={(e) => line('equipment', i, { name: e.target.value })}
                  />
                </Field>
              </div>
              <Field label={t('Own or hired')}>
                <Select
                  value={x.ownership}
                  onChange={(e) =>
                    line('equipment', i, { ownership: e.target.value as 'own' | 'hired' })
                  }
                >
                  <option value="own">{t('Own')}</option>
                  <option value="hired">{t('Hired')}</option>
                </Select>
              </Field>
              <Field label={t('Hours worked')}>
                <Input
                  inputMode="decimal"
                  value={x.hoursWorked}
                  onChange={(e) => line('equipment', i, { hoursWorked: e.target.value })}
                />
              </Field>
              <Field label={t('Hours idle')}>
                <Input
                  inputMode="decimal"
                  value={x.hoursIdle}
                  onChange={(e) => line('equipment', i, { hoursIdle: e.target.value })}
                />
              </Field>
              {removeBtn('equipment', i, t('Remove equipment {n}', { n: i + 1 }))}
              {Number(x.hoursIdle) > 0 && (
                <div className="col-span-2 sm:col-span-5">
                  <Field label={t('Why idle')}>
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
            <Plus className="size-4" aria-hidden /> {t('Equipment')}
          </Button>
        </div>
      </Card>

      <Card title={t('Work done')}>
        <p className="mb-3 text-xs text-fg-muted">
          {t("The site's account of the day. What is billed is measured in the measurement book.")}
        </p>
        <div className="space-y-3">
          {draft.work.map((w, i) => (
            <div
              key={i}
              role="group"
              aria-label={t('Work {n}', { n: i + 1 })}
              className="grid grid-cols-3 items-end gap-2 border-b border-line pb-3 sm:grid-cols-[3fr_1fr_1fr_1fr_auto]"
            >
              <div className="col-span-3 sm:col-span-1">
                <Field label={t('What')}>
                  <Input
                    value={w.description}
                    maxLength={1000}
                    onChange={(e) => line('work', i, { description: e.target.value })}
                  />
                </Field>
              </div>
              <Field label={t('BOQ item')}>
                <Input
                  value={w.boqCode ?? ''}
                  maxLength={40}
                  onChange={(e) => line('work', i, { boqCode: e.target.value })}
                />
              </Field>
              <Field label={t('Quantity')}>
                <Input
                  inputMode="decimal"
                  value={w.qty ?? ''}
                  onChange={(e) => line('work', i, { qty: e.target.value })}
                />
              </Field>
              <Field label={t('Unit')}>
                <Input
                  value={w.unit}
                  maxLength={20}
                  onChange={(e) => line('work', i, { unit: e.target.value })}
                />
              </Field>
              {removeBtn('work', i, t('Remove work {n}', { n: i + 1 }))}
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              set('work', [...draft.work, { boqCode: null, description: '', qty: '', unit: '' }])
            }
          >
            <Plus className="size-4" aria-hidden /> {t('Work')}
          </Button>
        </div>
      </Card>

      <Card title={t('Hindrances')}>
        <div className="space-y-3">
          {draft.hindrances.map((h, i) => (
            <div
              key={i}
              role="group"
              aria-label={t('Hindrance {n}', { n: i + 1 })}
              className="grid grid-cols-2 items-end gap-2 border-b border-line pb-3 sm:grid-cols-[1fr_2fr_6rem_1fr_auto]"
            >
              <Field label={t('Cause')}>
                <Select
                  value={h.cause}
                  onChange={(e) => line('hindrances', i, { cause: e.target.value as Cause })}
                >
                  {Object.entries(CAUSE).map(([v, l]) => (
                    <option key={v} value={v}>
                      {t(l)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('Hours lost')}>
                <Input
                  inputMode="decimal"
                  value={h.hours}
                  onChange={(e) => line('hindrances', i, { hours: e.target.value })}
                />
              </Field>
              <div className="col-span-2 sm:col-span-1 sm:row-start-1 sm:col-start-2">
                <Field label={t('What happened')}>
                  <Input
                    value={h.description}
                    maxLength={1000}
                    onChange={(e) => line('hindrances', i, { description: e.target.value })}
                  />
                </Field>
              </div>
              <Field label={t('On whose account')}>
                <Select
                  value={h.account}
                  onChange={(e) => line('hindrances', i, { account: e.target.value as Account })}
                >
                  {Object.entries(ACCOUNT).map(([v, l]) => (
                    <option key={v} value={v}>
                      {t(l)}
                    </option>
                  ))}
                </Select>
              </Field>
              {removeBtn('hindrances', i, t('Remove hindrance {n}', { n: i + 1 }))}
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
            <Plus className="size-4" aria-hidden /> {t('Hindrance')}
          </Button>
        </div>
      </Card>

      <Card title={t('Safety, visitors, notes')}>
        <div className="space-y-3">
          <Field label={t('Safety')}>
            <Textarea
              rows={2}
              value={draft.safety}
              maxLength={4000}
              onChange={(e) => set('safety', e.target.value)}
            />
          </Field>
          <Field label={t('Visitors')}>
            <Textarea
              rows={2}
              value={draft.visitors}
              maxLength={2000}
              onChange={(e) => set('visitors', e.target.value)}
            />
          </Field>
          <Field label={t('Notes')}>
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
  const t = useT();
  return (
    <Card>
      <dl
        className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]"
        data-testid="report-summary"
      >
        <dt className="text-fg-muted">{t('Weather')}</dt>
        <dd>
          {r.weatherAm ? t(WEATHER[r.weatherAm]) : '-'} /{' '}
          {r.weatherPm ? t(WEATHER[r.weatherPm]) : '-'}
          {r.rainHours && Number(r.rainHours) > 0 && t(', rain {n} h', { n: trim(r.rainHours) })}
        </dd>
        <dt className="text-fg-muted">{t('Manpower')}</dt>
        <dd>
          {r.manpower.length === 0
            ? '-'
            : r.manpower
                .map((m) => `${m.trade} ${m.headcount}${m.contractor ? ` (${m.contractor})` : ''}`)
                .join(', ')}
        </dd>
        <dt className="text-fg-muted">{t('Equipment')}</dt>
        <dd>
          {r.equipment.length === 0
            ? '-'
            : r.equipment
                .map(
                  (e) =>
                    `${e.name} (${t(e.ownership)}): ${t('{n} h worked', { n: trim(e.hoursWorked) })}${
                      Number(e.hoursIdle) > 0
                        ? `${t(', {n} h idle', { n: trim(e.hoursIdle) })}${e.idleReason ? ` (${e.idleReason})` : ''}`
                        : ''
                    }`,
                )
                .join('; ')}
        </dd>
        <dt className="text-fg-muted">{t('Work done')}</dt>
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
        <dt className="text-fg-muted">{t('Hindrances')}</dt>
        <dd>
          {r.hindrances.length === 0
            ? '-'
            : r.hindrances
                .map(
                  (h) =>
                    `${t(CAUSE[h.cause])}: ${h.description}, ${trim(h.hours)} h (${t(ACCOUNT[h.account])})`,
                )
                .join('; ')}
        </dd>
        {r.safety && (
          <>
            <dt className="text-fg-muted">{t('Safety')}</dt>
            <dd className="whitespace-pre-wrap">{r.safety}</dd>
          </>
        )}
        {r.visitors && (
          <>
            <dt className="text-fg-muted">{t('Visitors')}</dt>
            <dd className="whitespace-pre-wrap">{r.visitors}</dd>
          </>
        )}
        {r.notes && (
          <>
            <dt className="text-fg-muted">{t('Notes')}</dt>
            <dd className="whitespace-pre-wrap">{r.notes}</dd>
          </>
        )}
        {r.submittedBy && (
          <>
            <dt className="text-fg-muted">{t('Submitted')}</dt>
            <dd>
              {r.submittedBy}, {formatDateTime(r.submittedAt!)}
              {r.acknowledgedBy && t('; acknowledged by {name}', { name: r.acknowledgedBy })}
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
  const t = useT();
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // The position is asked for when the camera is opened, so it is usually ready when the photo is; it never holds the
  // upload up for more than a moment (a phone with location refused or no fix sends the photo without one).
  const position = useRef<ReturnType<typeof here> | null>(null);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      let next: DailyReport | null = null;
      // Where the phone is now and when each picture was taken (the camera's file time), kept with the photo.
      const at = await Promise.race([
        (position.current ??= here(10_000)),
        new Promise<null>((ok) => setTimeout(() => ok(null), 1_500)),
      ]);
      position.current = null;
      for (const f of Array.from(files)) {
        const meta = {
          caption: caption.trim(),
          takenAt: new Date(f.lastModified || Date.now()).toISOString(),
          latitude: at?.latitude ?? null,
          longitude: at?.longitude ?? null,
          accuracyM: at?.accuracy ?? null,
        };
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          try {
            const q = new URLSearchParams({ caption: meta.caption, takenAt: meta.takenAt });
            if (at) {
              q.set('latitude', String(at.latitude));
              q.set('longitude', String(at.longitude));
              if (at.accuracy !== null) q.set('accuracyM', String(at.accuracy));
            }
            next = await api.upload<DailyReport>(
              `/api/tenant/daily-reports/${r.id}/photos?${q.toString()}`,
              await shrink(f),
            );
            continue;
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 0)) throw err;
          }
        }
        // No signal: a smaller copy waits in the outbox with its time and place, and goes when the signal returns.
        const sent = await sendOrKeep<DailyReport>(
          t('Photo for the daily report of {date}', { date: r.reportDate }),
          `/api/tenant/daily-reports/${r.id}/photos/inline`,
          { ...meta, photo: await shrinkToDataUrl(f, 1280, 0.7) },
        );
        if (sent.queued) setQueued((n) => n + 1);
        else next = sent.result;
      }
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
    <Card title={t('Photos ({n})', { n: r.photos.length })}>
      {r.photos.length > 0 && (
        <ul className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label={t('Photos')}>
          {r.photos.map((p) => (
            <li key={p.id} className="space-y-1">
              <Photo reportId={r.id} id={p.id} caption={p.caption} />
              <div className="flex items-start justify-between gap-1 text-xs">
                <span>
                  {p.caption}
                  {(p.takenAt || p.latitude !== null) && (
                    <span className="block text-fg-muted">
                      {p.takenAt && formatDateTime(p.takenAt)}
                      {p.latitude !== null && p.longitude !== null && (
                        <>
                          {' · '}
                          <a
                            className="underline"
                            target="_blank"
                            rel="noreferrer"
                            href={`https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=18/${p.latitude}/${p.longitude}`}
                          >
                            {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
                          </a>
                          {p.accuracyM !== null && ` ±${p.accuracyM} m`}
                        </>
                      )}
                    </span>
                  )}
                </span>
                {editing && (
                  <button
                    type="button"
                    className="text-fg-muted hover:text-danger print:hidden"
                    aria-label={t('Remove photo {caption}', { caption: p.caption })}
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
            <Field label={t('Caption')}>
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
            aria-label={t('Photo file')}
            onChange={(e) => void add(e.target.files)}
          />
          <Button
            type="button"
            busy={busy}
            onClick={() => {
              position.current = here(10_000);
              input.current?.click();
            }}
          >
            <Camera className="size-4" aria-hidden /> {t('Add photo')}
          </Button>
        </div>
      )}
      {!editing && r.photos.length === 0 && <p className="text-sm text-fg-muted">{t('None.')}</p>}
      {queued > 0 && (
        <Alert tone="info">
          {queued === 1
            ? t('No signal: {n} photo kept on this phone, sent when the signal returns.', {
                n: queued,
              })
            : t('No signal: {n} photos kept on this phone, sent when the signal returns.', {
                n: queued,
              })}
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

/** A photo fetched with the session (an <img> cannot send it), shown from memory. */
function Photo({ reportId, id, caption }: { reportId: string; id: string; caption: string }) {
  const t = useT();
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
      alt={caption || t('Site photo')}
      className="aspect-[4/3] w-full rounded-md object-cover"
    />
  ) : (
    <div className="aspect-[4/3] w-full rounded-md bg-surface-2" />
  );
}
