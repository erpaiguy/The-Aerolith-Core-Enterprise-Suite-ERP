// Inspection and test plan (docs/wave7-plan.md step 7d.4): a project's activities, each with the checklist and the
// test it needs, how often, who checks and whether it is a hold point; beside each, what the quality records show
// done so far. The project's lead sets the plan.
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';

const TESTS = {
  cube: 'Concrete cubes',
  slump: 'Slump',
  steel: 'Reinforcement steel',
  soil: 'Soil compaction',
  brick: 'Bricks',
} as const;
type TestKind = keyof typeof TESTS;

interface Line {
  id: string;
  position: number;
  activity: string;
  stage: 'before' | 'during' | 'after';
  frequency: string;
  holdPoint: boolean;
  responsible: string;
  checklistTemplateId: string | null;
  checklist: string | null;
  testKind: TestKind | null;
  checklistsDone: number;
  checklistsFailed: number;
  testsDone: number;
}
interface Plan {
  lines: Line[];
  templates: { id: string; name: string }[];
  mayEdit: boolean;
}

export function ItpScreen({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const plan = useQuery({
    queryKey: ['itp', projectId],
    queryFn: () => api.request<Plan>(`/api/tenant/projects/${projectId}/itp`),
  });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const remove = async (id: string, activity: string) => {
    if (
      !(await confirm({
        title: `Remove ${activity} from the plan?`,
        body: 'The line is deleted from the inspection and test plan. Checks already done stay on record.',
        confirmLabel: 'Remove the line',
        tone: 'danger',
      }))
    )
      return;
    setError(null);
    void api
      .request(`/api/tenant/itp-lines/${id}`, { method: 'DELETE' })
      .then(() => {
        toast.success(`${activity} removed from the plan`);
        void qc.invalidateQueries({ queryKey: ['itp', projectId] });
      })
      .catch((err: unknown) => setError(describeError(err)));
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Inspection and test plan"
        subtitle={project.data ? `${project.data.number} · ${project.data.name}` : undefined}
        actions={
          plan.data?.mayEdit && !adding ? (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> Add an activity
            </Button>
          ) : null
        }
      />
      {adding && plan.data ? (
        <AddLine
          projectId={projectId}
          templates={plan.data.templates}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card>
        {plan.isPending ? (
          <Spinner />
        ) : plan.isError ? (
          <Alert tone="danger">{describeError(plan.error)}</Alert>
        ) : plan.data.lines.length === 0 ? (
          <EmptyState title="No activity in the plan yet.">
            List each activity with its test, how often, and who witnesses it.
          </EmptyState>
        ) : (
          <Table minWidth="60rem">
            <thead>
              <tr>
                <th>#</th>
                <th>Activity</th>
                <th>Checklist</th>
                <th>Test</th>
                <th>How often</th>
                <th>By</th>
                <th>Done so far</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="ITP">
              {plan.data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.position}</td>
                  <td>
                    {l.activity}
                    <div className="text-xs text-fg-muted">
                      {l.stage} the work
                      {l.holdPoint ? (
                        <span className="ml-1">
                          <Badge tone="warning">hold point</Badge>
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>{l.checklist ?? '—'}</td>
                  <td>{l.testKind ? TESTS[l.testKind] : '—'}</td>
                  <td>{l.frequency}</td>
                  <td>{l.responsible}</td>
                  <td className="text-sm">
                    {[
                      l.checklistTemplateId
                        ? `${l.checklistsDone} checklists${l.checklistsFailed ? ` (${l.checklistsFailed} failed)` : ''}`
                        : null,
                      l.testKind ? `${l.testsDone} tests` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td className="text-right">
                    {plan.data.mayEdit ? (
                      <Button
                        variant="ghost"
                        aria-label={`Remove ${l.activity}`}
                        onClick={() => void remove(l.id, l.activity)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function AddLine({
  projectId,
  templates,
  onClose,
}: {
  projectId: string;
  templates: Plan['templates'];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    activity: '',
    stage: 'during',
    checklistTemplateId: '',
    testKind: '',
    frequency: '',
    holdPoint: false,
    responsible: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  return (
    <Card title="Add an activity">
      <form
        aria-label="ITP line"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api
            .request(`/api/tenant/projects/${projectId}/itp`, {
              method: 'POST',
              body: {
                ...f,
                checklistTemplateId: f.checklistTemplateId || null,
                testKind: f.testKind || null,
              },
            })
            .then(() => {
              toast.success(`${f.activity.trim()} added to the plan`);
              void qc.invalidateQueries({ queryKey: ['itp', projectId] });
              onClose();
            })
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Activity">
            <Input value={f.activity} onChange={set('activity')} required minLength={2} />
          </Field>
          <Field label="When">
            <Select value={f.stage} onChange={set('stage')}>
              <option value="before">Before the work</option>
              <option value="during">During the work</option>
              <option value="after">After the work</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Checklist">
            <Select value={f.checklistTemplateId} onChange={set('checklistTemplateId')}>
              <option value="">None</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Test">
            <Select value={f.testKind} onChange={set('testKind')}>
              <option value="">None</option>
              {Object.entries(TESTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How often">
            <Input value={f.frequency} onChange={set('frequency')} />
          </Field>
          <Field label="Checked by">
            <Input value={f.responsible} onChange={set('responsible')} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.holdPoint}
            onChange={(e) => setF({ ...f, holdPoint: e.target.checked })}
          />
          Hold point: the work stops until this is passed
        </label>
        <div className="flex gap-2">
          <Button type="submit">Add to the plan</Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}
