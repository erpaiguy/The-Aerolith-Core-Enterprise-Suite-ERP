// Backups and the audit export (docs/wave8-plan.md step 8g.2), for admins: the nightly backup's hour and how many
// are kept, every backup with whether it was proven by restoring it, a backup taken now, a download, and a ZIP of
// the books and their records for the auditors.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  Table,
  toast,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, saveFile } from '../api/client';
import { describeError, formatDateTime } from '../lib/format';
import { numberLocale } from '../lib/locale';

interface Backup {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed';
  trigger: 'schedule' | 'manual';
  takenBy: string | null;
  fileName: string | null;
  bytes: string | null;
  tables: number | null;
  rows: string | null;
  error: string | null;
  checkedAt: string | null;
  checkOk: boolean | null;
  checkNote: string | null;
}
interface Overview {
  settings: { enabled: boolean; hour: number; keep: number };
  canCheck: boolean;
  backups: Backup[];
}

const size = (bytes: string | null) => {
  const n = Number(bytes ?? 0);
  return n >= 1 << 20
    ? `${(n / (1 << 20)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
};
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function BackupsScreen() {
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.request<Overview>('/api/tenant/backups'),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ enabled: true, hour: '2', keep: '14' });
  const [asOf, setAsOf] = useState(today());
  useEffect(() => {
    const s = data.data?.settings;
    if (s) setForm({ enabled: s.enabled, hour: String(s.hour), keep: String(s.keep) });
  }, [data.data?.settings]);

  /** `done`: the toast once it worked (none for downloads, which show themselves). */
  const run = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setBusy(what);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'backups' in r) qc.setQueryData(['backups'], r);
      if (done) toast.success(done);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const d = data.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Backups and audit export"
        subtitle="A copy of all the company's records every night, proven by restoring it; and the books as CSV files for your auditors."
        actions={
          <Button
            onClick={() =>
              void run(
                'take',
                () => api.request('/api/tenant/backups', { method: 'POST' }),
                'Backup taken',
              )
            }
            disabled={busy !== null}
          >
            {busy === 'take' ? 'Taking a backup…' : 'Back up now'}
          </Button>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {data.isPending ? (
        <Spinner />
      ) : data.isError ? (
        <Alert tone="danger">{describeError(data.error)}</Alert>
      ) : (
        d && (
          <>
            {!d.canCheck && (
              <Alert tone="info">
                Your database is hosted with its provider, which keeps its own backups too. These
                copies cannot be restored on this server to check them; download them and keep them
                somewhere safe.
              </Alert>
            )}
            <Card title="Nightly backup">
              <form
                className="flex flex-wrap items-end gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    'settings',
                    () =>
                      api.request('/api/tenant/backups/settings', {
                        method: 'POST',
                        body: {
                          enabled: form.enabled,
                          hour: Number(form.hour),
                          keep: Number(form.keep),
                        },
                      }),
                    'Backup settings saved',
                  );
                }}
              >
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  Take a backup every night
                </label>
                <Field label="At (hour, IST)">
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={form.hour}
                    onChange={(e) => setForm({ ...form, hour: e.target.value })}
                    className="w-24"
                  />
                </Field>
                <Field label="Keep the last">
                  <Input
                    type="number"
                    min={1}
                    max={90}
                    value={form.keep}
                    onChange={(e) => setForm({ ...form, keep: e.target.value })}
                    className="w-24"
                  />
                </Field>
                <Button type="submit" variant="secondary" disabled={busy !== null}>
                  Save
                </Button>
              </form>
            </Card>
            <Card title="Backups">
              {d.backups.length === 0 ? (
                <EmptyState title="No backups yet.">
                  The first is taken tonight at the hour set above; Back up now takes one at once.
                </EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>Taken</th>
                      <th>By</th>
                      <th>Size</th>
                      <th className="text-right">Rows</th>
                      <th>Restore check</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.backups.map((b) => (
                      <tr key={b.id}>
                        <td>{formatDateTime(b.startedAt)}</td>
                        <td>{b.trigger === 'schedule' ? 'Nightly' : (b.takenBy ?? '—')}</td>
                        <td>{b.status === 'done' ? size(b.bytes) : '—'}</td>
                        <td className="text-right tabular-nums">
                          {b.rows ? Number(b.rows).toLocaleString(numberLocale()) : '—'}
                        </td>
                        <td>
                          {b.status === 'failed' ? (
                            <span title={b.error ?? ''}>
                              <Badge tone="danger">Failed</Badge> {b.error}
                            </span>
                          ) : b.status === 'running' ? (
                            <Badge>Running</Badge>
                          ) : b.checkOk === null ? (
                            <Badge>Not checked</Badge>
                          ) : (
                            <span title={b.checkNote ?? ''}>
                              <Badge tone={b.checkOk ? 'success' : 'danger'}>
                                {b.checkOk ? 'Restored and matched' : 'Check failed'}
                              </Badge>{' '}
                              {!b.checkOk && b.checkNote}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {b.status === 'done' && (
                            <>
                              {d.canCheck && (
                                <Button
                                  variant="ghost"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void run(
                                      `check-${b.id}`,
                                      () =>
                                        api.request(`/api/tenant/backups/${b.id}/check`, {
                                          method: 'POST',
                                        }),
                                      'Restore check finished',
                                    )
                                  }
                                >
                                  {busy === `check-${b.id}` ? 'Checking…' : 'Check again'}
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() =>
                                  void run(`dl-${b.id}`, async () => {
                                    const f = await api.download(
                                      `/api/tenant/backups/${b.id}/file`,
                                    );
                                    saveFile(f.blob, f.fileName);
                                  })
                                }
                              >
                                Download
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title="Audit export">
              <p className="mb-3 text-sm text-fg-muted">
                Every voucher and its lines, bills, receipts, payroll, assets, parties and the audit
                trail as CSV files, with each company's trial balance. Passwords and keys are never
                included; stored files (bills, photos, drawings) are downloaded from Documents.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Trial balance as of">
                  <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
                </Field>
                <Button
                  variant="secondary"
                  disabled={busy !== null || !asOf}
                  onClick={() =>
                    void run('audit', async () => {
                      const f = await api.download(`/api/tenant/audit-export?asOf=${asOf}`);
                      saveFile(f.blob, f.fileName);
                    })
                  }
                >
                  {busy === 'audit' ? 'Preparing…' : 'Download the audit export'}
                </Button>
              </div>
            </Card>
          </>
        )
      )}
    </div>
  );
}
