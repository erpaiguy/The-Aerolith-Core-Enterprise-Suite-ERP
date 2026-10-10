// A project's schedules on its page (docs/wave2a-plan.md step 4): the list, a new schedule (empty, or laid out on the
// project's WBS) and a schedule from an MS Project XML or Primavera XER file. The tender's programme is not copied.
import { Alert, Button, Card, Field, Input, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, Upload } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { shortDate, type ProgrammeDetail } from '../schedule/model';
import { usePermission } from '../session/permissions';

interface ScheduleSummary {
  id: string;
  name: string;
  startOn: string;
  finishOn: string | null;
  dataDate: string | null;
  duration: number | null;
  activityCount: number;
  archivedAt: string | null;
  baseline: { name: string; finishOn: string | null } | null;
}

export function ProjectSchedules({ project: p }: { project: ProjectDetail }) {
  const navigate = useNavigate();
  const canPlan = usePermission('programme.edit') && (p.canEdit || p.myRole === 'member');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('Construction schedule');
  const [startOn, setStartOn] = useState(p.startOn ?? new Date().toISOString().slice(0, 10));
  const [fromWbs, setFromWbs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useQuery({
    queryKey: ['programmes', p.id],
    queryFn: () => api.request<ScheduleSummary[]>(`/api/tenant/projects/${p.id}/schedules`),
  });
  const open = (planId: string) => navigate({ to: '/programmes/$planId', params: { planId } });
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const plan = await api.request<ProgrammeDetail>(`/api/tenant/projects/${p.id}/schedules`, {
        method: 'POST',
        body: { name, startOn, fromWbs },
      });
      await open(plan.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.upload<{ plan: ProgrammeDetail }>(
        `/api/tenant/projects/${p.id}/schedules/import`,
        file,
      );
      await open(r.plan.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <Card
      title="Schedules"
      actions={
        canPlan &&
        !adding && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" busy={busy} onClick={() => fileInput.current?.click()}>
              <Upload className="size-4" aria-hidden /> Import file
            </Button>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> New schedule
            </Button>
          </div>
        )
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept=".xml,.xer"
        className="hidden"
        aria-label="Schedule file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
      {adding && (
        <form onSubmit={(e) => void create(e)} className="mb-4 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Schedule name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
              />
            </Field>
            <Field label="Start">
              <Input
                type="date"
                value={startOn}
                onChange={(e) => setStartOn(e.target.value)}
                required
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fromWbs}
              onChange={(e) => setFromWbs(e.target.checked)}
            />
            Lay it out on the project&apos;s WBS (an activity or summary for each element)
          </label>
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>
              Create schedule
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {list.data && list.data.length === 0 && !adding && (
        <p className="text-sm text-fg-muted">
          No schedule yet. Start one on the WBS, or import one from MS Project or Primavera.
        </p>
      )}
      {list.data && list.data.some((x) => !x.archivedAt) && (
        <p className="mb-2 text-sm">
          <Link
            to="/projects/$projectId/macro"
            params={{ projectId: p.id }}
            className="text-accent hover:underline"
          >
            Macro plan
          </Link>
          <span className="text-fg-muted">
            : the schedules rolled up through the WBS, by package, trade and zone, and the
            milestones.
          </span>
        </p>
      )}
      {list.data && list.data.length > 0 && (
        <Table minWidth="30rem">
          <thead>
            <tr>
              <th>Schedule</th>
              <th>Dates</th>
              <th>Data date</th>
              <th>Baseline finish</th>
            </tr>
          </thead>
          <tbody aria-label="Schedules">
            {list.data.map((s) => (
              <tr key={s.id} className={s.archivedAt ? 'text-fg-subtle' : ''}>
                <td>
                  <Link
                    to="/programmes/$planId"
                    params={{ planId: s.id }}
                    className="text-accent hover:underline"
                  >
                    {s.name}
                  </Link>
                  <div className="text-xs text-fg-muted">
                    {s.activityCount.toLocaleString('en-IN')} activities
                    {s.archivedAt ? ' · archived' : ''}
                  </div>
                </td>
                <td className="whitespace-nowrap tabular-nums">
                  {shortDate(s.startOn)} to {shortDate(s.finishOn)}
                </td>
                <td className="whitespace-nowrap tabular-nums">
                  {shortDate(s.dataDate ?? s.startOn)}
                </td>
                <td className="whitespace-nowrap tabular-nums">
                  {s.baseline ? `${shortDate(s.baseline.finishOn)} (${s.baseline.name})` : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
