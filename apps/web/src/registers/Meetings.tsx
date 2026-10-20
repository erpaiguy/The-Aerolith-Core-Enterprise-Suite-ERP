// Meetings and actions (docs/wave7-plan.md step 7d.1): a project's minutes, decisions and the actions agreed, each
// with an owner from the team and a date; owners close their actions (they also wait in their work on Home).
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
  Textarea,
  toast,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { shortDate } from '../schedule/model';

interface List {
  meetings: {
    id: string;
    number: string;
    title: string;
    heldOn: string;
    place: string;
    actions: number;
    open: number;
  }[];
  mayWrite: boolean;
}
interface Meeting {
  id: string;
  number: string;
  title: string;
  heldOn: string;
  place: string;
  attendees: string;
  minutes: string;
  decisions: string;
  projectId: string;
  project: string;
  recordedBy: string | null;
  actions: {
    id: string;
    position: number;
    description: string;
    ownerId: string;
    owner: string;
    dueOn: string;
    status: 'open' | 'done';
    note: string;
    overdue: boolean;
  }[];
  mayLead: boolean;
  me: string;
}
const today = () => new Date().toISOString().slice(0, 10);

export function MeetingsScreen({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const list = useQuery({
    queryKey: ['meetings', projectId],
    queryFn: () => api.request<List>(`/api/tenant/projects/${projectId}/meetings`),
  });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Meetings"
        subtitle={project.data ? `${project.data.number} · ${project.data.name}` : undefined}
        actions={
          list.data?.mayWrite && !adding ? (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> Record a meeting
            </Button>
          ) : null
        }
      />
      {adding && project.data ? (
        <NewMeeting
          project={project.data}
          onDone={(id) => {
            setAdding(false);
            setOpen(id);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {open ? <MeetingCard id={open} /> : null}
      <Card title="Minutes">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : list.data.meetings.length === 0 ? (
          <EmptyState title="No meeting recorded yet.">
            Record each meeting with its decisions and actions; owners see their actions on My work.
          </EmptyState>
        ) : (
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>Meeting</th>
                <th>Held</th>
                <th>Place</th>
                <th className="text-right">Actions open</th>
              </tr>
            </thead>
            <tbody aria-label="Meetings">
              {list.data.meetings.map((m) => (
                <tr key={m.id}>
                  <td>
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setOpen(m.id)}
                    >
                      <span className="font-mono text-xs">{m.number}</span> {m.title}
                    </button>
                  </td>
                  <td>{shortDate(m.heldOn)}</td>
                  <td>{m.place}</td>
                  <td className="text-right">
                    {m.open} of {m.actions}
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

function NewMeeting({
  project,
  onDone,
  onCancel,
}: {
  project: ProjectDetail;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    title: '',
    heldOn: today(),
    place: '',
    attendees: '',
    minutes: '',
    decisions: '',
  });
  const [actions, setActions] = useState<{ description: string; ownerId: string; dueOn: string }[]>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  return (
    <Card title="Record a meeting">
      <form
        aria-label="Record a meeting"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api
            .request<Meeting>(`/api/tenant/projects/${project.id}/meetings`, {
              method: 'POST',
              body: { ...f, actions: actions.filter((a) => a.description.trim()) },
            })
            .then((m) => {
              toast.success('Meeting recorded');
              void qc.invalidateQueries({ queryKey: ['meetings', project.id] });
              void qc.invalidateQueries({ queryKey: ['my-work'] });
              onDone(m.id);
            })
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Title">
            <Input value={f.title} onChange={set('title')} required minLength={3} />
          </Field>
          <Field label="Held on">
            <Input type="date" value={f.heldOn} onChange={set('heldOn')} required />
          </Field>
          <Field label="Place">
            <Input value={f.place} onChange={set('place')} />
          </Field>
        </div>
        <Field label="Attendees">
          <Textarea rows={2} value={f.attendees} onChange={set('attendees')} />
        </Field>
        <Field label="Minutes">
          <Textarea rows={4} value={f.minutes} onChange={set('minutes')} />
        </Field>
        <Field label="Decisions">
          <Textarea rows={2} value={f.decisions} onChange={set('decisions')} />
        </Field>
        {actions.map((a, i) => (
          <fieldset
            key={i}
            aria-label={`Action ${i + 1}`}
            className="grid gap-3 md:grid-cols-[2fr_1fr_10rem]"
          >
            <Field label="Action">
              <Input
                value={a.description}
                onChange={(e) =>
                  setActions(
                    actions.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                  )
                }
              />
            </Field>
            <Field label="Owner">
              <Select
                value={a.ownerId}
                onChange={(e) =>
                  setActions(
                    actions.map((x, j) => (j === i ? { ...x, ownerId: e.target.value } : x)),
                  )
                }
              >
                {project.team.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="By">
              <Input
                type="date"
                value={a.dueOn}
                onChange={(e) =>
                  setActions(actions.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)))
                }
              />
            </Field>
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              setActions([
                ...actions,
                { description: '', ownerId: project.team[0]?.userId ?? '', dueOn: today() },
              ])
            }
          >
            Add an action
          </Button>
          <Button type="submit">Save the minutes</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}

export function MeetingCard({ id }: { id: string }) {
  const qc = useQueryClient();
  const key = ['meeting', id];
  const m = useQuery({
    queryKey: key,
    queryFn: () => api.request<Meeting>(`/api/tenant/meetings/${id}`),
  });
  const [error, setError] = useState<string | null>(null);
  if (m.isPending) return <Spinner />;
  if (m.isError) return <Alert tone="danger">{describeError(m.error)}</Alert>;
  const x = m.data;
  const done = async (actionId: string) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Meeting>(`/api/tenant/meeting-actions/${actionId}/done`, {
          method: 'POST',
          body: {},
        }),
      );
      toast.success('Action marked done');
      void qc.invalidateQueries({ queryKey: ['meetings', x.projectId] });
      void qc.invalidateQueries({ queryKey: ['my-work'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title={`${x.number} ${x.title}`}>
      <p className="mb-2 text-sm text-fg-muted">
        {shortDate(x.heldOn)}
        {x.place ? ` · ${x.place}` : ''}
        {x.recordedBy ? ` · recorded by ${x.recordedBy}` : ''}
      </p>
      {x.attendees ? (
        <p className="whitespace-pre-wrap text-sm">
          <strong>Present:</strong> {x.attendees}
        </p>
      ) : null}
      {x.minutes ? <p className="mt-2 whitespace-pre-wrap text-sm">{x.minutes}</p> : null}
      {x.decisions ? (
        <p className="mt-2 whitespace-pre-wrap text-sm">
          <strong>Decided:</strong> {x.decisions}
        </p>
      ) : null}
      {x.actions.length ? (
        <ul className="mt-3 divide-y divide-line text-sm" aria-label="Actions">
          {x.actions.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="flex-1">{a.description}</span>
              <span className={a.overdue ? 'font-medium text-danger' : 'text-fg-muted'}>
                {a.owner} · by {shortDate(a.dueOn)}
              </span>
              {a.status === 'done' ? (
                <Badge tone="success">done</Badge>
              ) : a.ownerId === x.me || x.mayLead ? (
                <Button variant="secondary" onClick={() => void done(a.id)}>
                  Done
                </Button>
              ) : (
                <Badge tone="warning">open</Badge>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p className="mt-3 text-xs">
        <Link
          to="/projects/$projectId"
          params={{ projectId: x.projectId }}
          className="hover:underline"
        >
          {x.project}
        </Link>
      </p>
    </Card>
  );
}
