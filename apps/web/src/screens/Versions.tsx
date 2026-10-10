// BOQ revisions (docs/04-features.md E6): freeze a version, start the next revision, see every version with the bid
// it carried, export any of them, and compare two versions line by line.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Spinner,
  Stat,
  Table,
  Textarea,
  cx,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Download, X } from 'lucide-react';
import { useState } from 'react';
import { api, saveFile } from '../api/client';
import type { BoqVersions, VersionChange, VersionCompare } from '../api/types';
import { formatAmount, formatQty, formatRate, type BoqHeader } from '../boq/model';
import { describeError, formatDateTime, formatInr } from '../lib/format';
import { usePermission } from '../session/permissions';

const STATUS_LABEL = { draft: 'draft', submitted: 'submitted', locked: 'locked' } as const;

/** Freeze the current version: submitted to the client, or locked for an internal review. */
export function FreezeDialog({
  boqId,
  versionNo,
  onDone,
  onClose,
}: {
  boqId: string;
  versionNo: number;
  onDone: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'submitted' | 'internal'>('submitted');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const freeze = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/tenant/boqs/${boqId}/freeze`, {
        method: 'POST',
        body: { kind, label, note },
      });
      onDone();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-24"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Freeze version ${versionNo}`}
        className="w-full max-w-lg space-y-4 rounded-lg border border-line bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <h2 className="font-semibold">Freeze version {versionNo}</h2>
          <Button variant="ghost" aria-label="Close" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <p className="text-sm text-fg-muted">
          The BOQ and its bid are kept exactly as they are now. Changes afterwards need a new
          revision, and you can always compare against this version or export it.
        </p>
        <Field label="Why">
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'submitted' | 'internal')}
          >
            <option value="submitted">Submitted to the client</option>
            <option value="internal">Internal review (locked, not sent)</option>
          </Select>
        </Field>
        <Field label="Label" hint="For example: R0, Revised after pre-bid queries.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy} onClick={() => void freeze()}>
            Freeze version {versionNo}
          </Button>
        </div>
      </div>
    </div>
  );
}

function figure(a: string | null, b: string | null, fmt: (v: string | null) => string) {
  if (a === b) return <span>{fmt(b)}</span>;
  return (
    <span>
      <span className="text-fg-subtle line-through">{fmt(a)}</span>{' '}
      <span className="font-medium">{fmt(b)}</span>
    </span>
  );
}

function ChangeRow({ r }: { r: VersionChange }) {
  const tone = r.change === 'added' ? 'success' : r.change === 'removed' ? 'danger' : 'warning';
  const delta = r.type === 'item' ? Number(r.amountB ?? 0) - Number(r.amountA ?? 0) : null;
  const changed = r.change === 'changed';
  return (
    <tr className={cx(r.change === 'removed' && 'text-fg-muted')}>
      <td>
        <Badge tone={tone}>{r.change}</Badge> {r.moved && <Badge tone="neutral">moved</Badge>}
      </td>
      <td className="font-mono text-xs">
        {changed && r.codeA !== r.codeB ? (
          <>
            <span className="text-fg-subtle line-through">{r.codeA}</span> {r.codeB}
          </>
        ) : (
          (r.codeB ?? r.codeA)
        )}
      </td>
      <td className="max-w-md">
        {changed && r.descriptionA !== r.descriptionB ? (
          <span>
            <span className="text-fg-subtle line-through">{r.descriptionA}</span>
            <br />
            {r.descriptionB}
          </span>
        ) : (
          <span className="line-clamp-2">{r.descriptionB ?? r.descriptionA}</span>
        )}
        {changed && r.notesA !== r.notesB && (
          <span className="block text-xs text-fg-muted">
            Notes: {r.notesA ? <span className="line-through">{r.notesA}</span> : '(none)'} →{' '}
            {r.notesB || '(none)'}
          </span>
        )}
        {changed && r.unitA !== r.unitB && (
          <span className="block text-xs text-fg-muted">
            Unit: {r.unitA ?? '(none)'} → {r.unitB ?? '(none)'}
          </span>
        )}
      </td>
      <td className="text-right tabular-nums">
        {r.type === 'item' && figure(r.qtyA, r.qtyB, formatQty)}
      </td>
      <td className="text-right tabular-nums">
        {r.type === 'item' && figure(r.rateA, r.rateB, formatRate)}
      </td>
      <td
        className={cx(
          'text-right tabular-nums',
          delta !== null && delta > 0 && 'text-danger',
          delta !== null && delta < 0 && 'text-success',
        )}
      >
        {delta !== null && delta !== 0 && `${delta > 0 ? '+' : ''}${formatAmount(String(delta))}`}
      </td>
    </tr>
  );
}

function Compare({ boqId, data }: { boqId: string; data: BoqVersions }) {
  const latest = data.current.versionNo;
  const [from, setFrom] = useState(Math.max(1, latest - 1));
  const [to, setTo] = useState(latest);
  const [filter, setFilter] = useState<'all' | 'added' | 'removed' | 'changed'>('all');
  const [pages, setPages] = useState(1);
  const PAGE = 200;
  const q = useQuery({
    queryKey: ['compare', boqId, from, to, filter, pages],
    queryFn: () =>
      api.request<VersionCompare>(
        `/api/tenant/boqs/${boqId}/compare?from=${from}&to=${to}&filter=${filter}&limit=${PAGE * pages}`,
      ),
    placeholderData: keepPreviousData,
    enabled: from !== to,
  });
  const label = (v: number) =>
    v === latest && data.current.status === 'draft'
      ? `Version ${v} (working draft)`
      : `Version ${v}${data.versions.find((x) => x.versionNo === v)?.label ? ` · ${data.versions.find((x) => x.versionNo === v)!.label}` : ''}`;
  const options = Array.from({ length: latest }, (_, i) => i + 1);
  const delta = q.data ? Number(q.data.summary.itemsDelta) : 0;
  return (
    <Card title="Compare versions">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Field label="From">
            <Select
              value={from}
              onChange={(e) => {
                setFrom(Number(e.target.value));
                setPages(1);
              }}
            >
              {options.map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-64">
          <Field label="To">
            <Select
              value={to}
              onChange={(e) => {
                setTo(Number(e.target.value));
                setPages(1);
              }}
            >
              {options.map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      {from === to ? (
        <p className="text-sm text-fg-muted">Choose two different versions.</p>
      ) : q.isPending ? (
        <Spinner label="Comparing" />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <div className="space-y-4" data-testid="compare">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Added" value={q.data.summary.added.toLocaleString('en-IN')} />
            <Stat label="Removed" value={q.data.summary.removed.toLocaleString('en-IN')} />
            <Stat label="Changed" value={q.data.summary.changed.toLocaleString('en-IN')} />
            <Stat
              label={`Value ${formatInr(q.data.from.total)} → ${formatInr(q.data.to.total)}`}
              value={`${delta > 0 ? '+' : ''}${formatInr(q.data.summary.itemsDelta)}`}
              tone={delta > 0 ? 'warning' : undefined}
            />
          </div>
          <div className="flex gap-1" role="tablist" aria-label="Show">
            {(['all', 'added', 'removed', 'changed'] as const).map((f) => (
              <Button
                key={f}
                role="tab"
                aria-selected={filter === f}
                variant={filter === f ? 'secondary' : 'ghost'}
                onClick={() => {
                  setFilter(f);
                  setPages(1);
                }}
              >
                {f === 'all' ? 'All' : f[0]!.toUpperCase() + f.slice(1)}
              </Button>
            ))}
          </div>
          {q.data.rows.length === 0 ? (
            <p className="text-sm text-fg-muted">No differences.</p>
          ) : (
            <Table minWidth="48rem">
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Code</th>
                  <th>Description</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Amount Δ</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <ChangeRow key={r.lineKey} r={r} />
                ))}
              </tbody>
            </Table>
          )}
          {q.data.hasMore && (
            <Button variant="secondary" onClick={() => setPages((p) => p + 1)} busy={q.isFetching}>
              Show more
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function BoqVersionsScreen({ boqId }: { boqId: string }) {
  const qc = useQueryClient();
  const canEdit = usePermission('boq.edit');
  const canPrice = usePermission('pricing.edit');
  const versions = useQuery({
    queryKey: ['boq-versions', boqId],
    queryFn: () => api.request<BoqVersions>(`/api/tenant/boqs/${boqId}/versions`),
  });
  const header = useQuery({
    queryKey: ['boq', boqId],
    queryFn: () => api.request<BoqHeader>(`/api/tenant/boqs/${boqId}`),
  });
  const [freezing, setFreezing] = useState(false);
  const [busy, setBusy] = useState<number | 'revise' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['boq-versions', boqId] });
    void qc.invalidateQueries({ queryKey: ['boq', boqId] });
    void qc.invalidateQueries({ queryKey: ['compare', boqId] });
  };
  const revise = async () => {
    setBusy('revise');
    setError(null);
    try {
      await api.request(`/api/tenant/boqs/${boqId}/revise`, { method: 'POST', body: {} });
      refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  const exportVersion = async (v: number) => {
    setBusy(v);
    setError(null);
    try {
      const { blob, fileName } = await api.download(
        `/api/tenant/boqs/${boqId}/export?format=xlsx${v === versions.data?.current.versionNo ? '' : `&version=${v}`}`,
      );
      saveFile(blob, fileName);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  if (versions.isPending) return <Spinner />;
  if (versions.isError) return <Alert tone="danger">{describeError(versions.error)}</Alert>;
  const d = versions.data;
  const draft = d.current.status === 'draft';
  return (
    <div className="space-y-5">
      <Link
        to="/boqs/$boqId"
        params={{ boqId }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />{' '}
        {header.data?.tender?.number ?? header.data?.project?.number} · {header.data?.name}
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Versions · {header.data?.name}</h1>
          <p className="text-sm text-fg-muted">
            Now: version {d.current.versionNo} ({STATUS_LABEL[d.current.status]}),{' '}
            {formatInr(d.current.total)}
          </p>
        </div>
        {canEdit &&
          !header.data?.archivedAt &&
          (draft ? (
            <Button onClick={() => setFreezing(true)}>Freeze version {d.current.versionNo}</Button>
          ) : (
            <Button busy={busy === 'revise'} onClick={() => void revise()}>
              Start revision {d.current.versionNo + 1}
            </Button>
          ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {freezing && (
        <FreezeDialog
          boqId={boqId}
          versionNo={d.current.versionNo}
          onClose={() => setFreezing(false)}
          onDone={() => {
            setFreezing(false);
            refresh();
          }}
        />
      )}
      <Card title="All versions">
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Version</th>
              <th>Frozen</th>
              <th className="text-right">BOQ total</th>
              {canPrice && <th className="text-right">Bid (incl. GST)</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {draft && (
              <tr>
                <td>
                  <span className="font-medium">Version {d.current.versionNo}</span>{' '}
                  <Badge tone="accent">working draft</Badge>
                </td>
                <td className="text-fg-muted">not yet</td>
                <td className="text-right tabular-nums">{formatAmount(d.current.total)}</td>
                {canPrice && <td />}
                <td className="text-right">
                  <Button
                    variant="ghost"
                    busy={busy === d.current.versionNo}
                    onClick={() => void exportVersion(d.current.versionNo)}
                  >
                    <Download className="size-4" aria-hidden /> Excel
                  </Button>
                </td>
              </tr>
            )}
            {d.versions.map((v) => (
              <tr key={v.versionNo}>
                <td>
                  <span className="font-medium">Version {v.versionNo}</span>{' '}
                  <Badge tone={v.kind === 'submitted' ? 'success' : 'neutral'}>
                    {v.kind === 'submitted' ? 'submitted' : 'internal'}
                  </Badge>
                  {v.label && <div className="text-xs text-fg-muted">{v.label}</div>}
                  {v.note && <div className="text-xs text-fg-subtle">{v.note}</div>}
                </td>
                <td className="text-sm text-fg-muted">
                  {formatDateTime(v.frozenAt)}
                  {v.frozenBy && <div className="text-xs">{v.frozenBy}</div>}
                </td>
                <td className="text-right tabular-nums">{formatAmount(v.total)}</td>
                {canPrice && (
                  <td className="text-right tabular-nums">
                    {v.scenario ? (
                      <>
                        {formatAmount(v.scenario.result.bid)}
                        <div className="text-xs text-fg-muted">{v.scenario.name}</div>
                      </>
                    ) : (
                      <span className="text-fg-subtle">not priced</span>
                    )}
                  </td>
                )}
                <td className="text-right">
                  <Button
                    variant="ghost"
                    busy={busy === v.versionNo}
                    onClick={() => void exportVersion(v.versionNo)}
                  >
                    <Download className="size-4" aria-hidden /> Excel
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {d.current.versionNo > 1 && <Compare key={d.current.versionNo} boqId={boqId} data={d} />}
    </div>
  );
}
