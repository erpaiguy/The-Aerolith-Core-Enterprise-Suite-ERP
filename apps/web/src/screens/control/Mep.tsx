// The MEP pack (docs/wave4-plan.md step 7): load the system-wise BOQ templates and testing and commissioning
// checklists; per project, the equipment schedule (commissioned on a passed checklist) and the clash log.
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
  Table,
  toast,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { useProjectParam } from '../../lib/project-param';

const SYSTEMS = ['hvac', 'electrical', 'plumbing', 'fire', 'elv'] as const;
const STATUSES = ['planned', 'ordered', 'delivered', 'installed', 'tested', 'commissioned'];
interface Reg {
  equipment: {
    id: string;
    tag: string;
    system: string;
    description: string;
    capacity: string;
    location: string;
    status: string;
    checklistId: string | null;
    rowVersion: number;
  }[];
  byStatus: Record<string, number>;
  issues: {
    id: string;
    number: string;
    systems: string[];
    location: string;
    description: string;
    raisedOn: string;
    status: string;
    resolution: string | null;
  }[];
  checklists: { id: string; template: string; doneOn: string; location: string; result: string }[];
}

export function MepScreen() {
  const qc = useQueryClient();
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useProjectParam();
  const [loaded, setLoaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader
        title="MEP"
        subtitle="System-wise templates and checklists, the equipment schedule and the clash log."
        actions={
          <Select
            aria-label="Project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Choose a project…</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} {p.name}
              </option>
            ))}
          </Select>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="The MEP pack">
        <p className="text-sm text-fg-muted">
          BOQ templates for HVAC, electrical, plumbing, fire fighting and ELV, and a testing and
          commissioning checklist for each. Loaded once; anything already there is kept.
        </p>
        <Button
          type="button"
          className="mt-2"
          onClick={async () => {
            setError(null);
            try {
              const r = await api.request<{ boqTemplates: string[]; checklists: string[] }>(
                '/api/tenant/mep-pack',
                { method: 'POST', body: {} },
              );
              setLoaded(
                `${r.boqTemplates.length} BOQ templates and ${r.checklists.length} checklists added.`,
              );
              toast.success('MEP pack loaded');
              void qc.invalidateQueries({ queryKey: ['mep'] });
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          Load the MEP pack
        </Button>
        {loaded && (
          <p className="mt-2 text-sm" data-testid="mep-loaded">
            {loaded}
          </p>
        )}
      </Card>
      {projectId && <ProjectMep key={projectId} projectId={projectId} onError={setError} />}
    </div>
  );
}

function ProjectMep({
  projectId,
  onError,
}: {
  projectId: string;
  onError: (e: string | null) => void;
}) {
  const qc = useQueryClient();
  const key = ['mep', projectId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Reg>(`/api/tenant/projects/${projectId}/mep`),
  });
  const [eq, setEq] = useState({
    tag: '',
    system: 'hvac',
    description: '',
    capacity: '',
    location: '',
  });
  const [is, setIs] = useState({
    systems: ['hvac', 'electrical'] as string[],
    location: '',
    description: '',
  });
  const [pick, setPick] = useState<Record<string, string>>({});
  const call = async (path: string, body: object, done?: string) => {
    onError(null);
    try {
      await api.request(path, { method: 'POST', body });
      if (done) toast.success(done);
      void qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (err) {
      onError(describeError(err));
      return false;
    }
  };
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const d = q.data;
  const passed = d.checklists.filter((c) => c.result === 'passed');
  return (
    <>
      <Card title="Equipment schedule">
        <p className="mb-2 text-sm text-fg-muted">
          {STATUSES.map((s) => `${s} ${d.byStatus[s] ?? 0}`).join(' · ')}
        </p>
        {d.equipment.length > 0 && (
          <Table minWidth="52rem">
            <thead>
              <tr>
                <th>Tag</th>
                <th>System</th>
                <th>What</th>
                <th>Where</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.equipment.map((e) => (
                <tr key={e.id} aria-label={e.tag}>
                  <td>{e.tag}</td>
                  <td>{e.system}</td>
                  <td>
                    {e.description} <span className="text-fg-muted">{e.capacity}</span>
                  </td>
                  <td>{e.location}</td>
                  <td className="flex flex-wrap items-center gap-1">
                    <Select
                      aria-label={`Status, ${e.tag}`}
                      value={e.status}
                      onChange={(x) =>
                        void call(
                          `/api/tenant/mep-equipment/${e.id}/status`,
                          {
                            status: x.target.value,
                            checklistId: pick[e.id] || null,
                            rowVersion: e.rowVersion,
                          },
                          `${e.tag} marked ${x.target.value}`,
                        )
                      }
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                    {e.status !== 'commissioned' && (
                      <Select
                        aria-label={`T&C checklist, ${e.tag}`}
                        value={pick[e.id] ?? ''}
                        onChange={(x) => setPick({ ...pick, [e.id]: x.target.value })}
                      >
                        <option value="">T&amp;C checklist…</option>
                        {d.checklists.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.template} {c.doneOn} {c.location} ({c.result})
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {passed.length === 0 && d.equipment.length > 0 && (
          <p className="mt-2 text-xs text-fg-muted">
            Commissioning needs a passed testing and commissioning checklist (Quality).
          </p>
        )}
        <form
          aria-label="New equipment"
          className="mt-3 grid gap-3 sm:grid-cols-6"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await call(
                `/api/tenant/projects/${projectId}/mep/equipment`,
                eq,
                `Equipment ${eq.tag} added`,
              )
            )
              setEq({ ...eq, tag: '', description: '', capacity: '', location: '' });
          }}
        >
          <Field label="Tag">
            <Input
              value={eq.tag}
              onChange={(e) => setEq({ ...eq, tag: e.target.value })}
              required
            />
          </Field>
          <Field label="System">
            <Select value={eq.system} onChange={(e) => setEq({ ...eq, system: e.target.value })}>
              {SYSTEMS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description">
            <Input
              value={eq.description}
              onChange={(e) => setEq({ ...eq, description: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="Capacity">
            <Input
              value={eq.capacity}
              onChange={(e) => setEq({ ...eq, capacity: e.target.value })}
            />
          </Field>
          <Field label="Location">
            <Input
              value={eq.location}
              onChange={(e) => setEq({ ...eq, location: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Add</Button>
          </div>
        </form>
      </Card>

      <Card title="Coordination and clash log">
        <ul className="space-y-1 text-sm">
          {d.issues.map((i) => (
            <li key={i.id} aria-label={i.number}>
              {i.number} · {i.systems.join(' / ')} · {i.location} · {i.description}{' '}
              <Badge tone={i.status === 'resolved' ? 'success' : 'warning'}>{i.status}</Badge>
              {i.resolution && <span className="text-fg-muted"> {i.resolution}</span>}
              {i.status === 'open' && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    const resolution = window.prompt('How was it resolved?');
                    if (resolution)
                      void call(
                        `/api/tenant/coordination-issues/${i.id}/resolve`,
                        { resolution, on: today() },
                        `${i.number} resolved`,
                      );
                  }}
                >
                  Resolve
                </Button>
              )}
            </li>
          ))}
        </ul>
        <form
          aria-label="New clash"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await call(
                `/api/tenant/projects/${projectId}/mep/issues`,
                { ...is, raisedOn: today() },
                'Clash logged',
              )
            )
              setIs({ ...is, location: '', description: '' });
          }}
        >
          <Field label="Systems">
            <Select
              multiple
              value={is.systems}
              onChange={(e) =>
                setIs({ ...is, systems: [...e.target.selectedOptions].map((o) => o.value) })
              }
            >
              {SYSTEMS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Location">
            <Input
              value={is.location}
              onChange={(e) => setIs({ ...is, location: e.target.value })}
            />
          </Field>
          <Field label="Clash">
            <Input
              value={is.description}
              onChange={(e) => setIs({ ...is, description: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Raise</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
