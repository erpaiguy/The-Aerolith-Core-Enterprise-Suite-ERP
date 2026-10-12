// Revision control for a project (docs/wave5-plan.md step 4): the revision series the drawings register enforces, and
// the distribution matrix: who gets which disciplines' new revisions (people inside acknowledge receipt; parties
// outside get a draft transmittal ready to issue).
import { Alert, Button, Card, Field, Input, Select, Spinner } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ProjectDetail } from '../../api/types';
import { describeError } from '../../lib/format';

const DISCIPLINES = [
  'architectural',
  'structural',
  'electrical',
  'plumbing',
  'hvac',
  'fire',
  'landscape',
  'interiors',
  'other',
];
interface Settings {
  rule: { enabled: boolean; construction: 'numbers' | 'letters' | 'r_numbers' };
  matrix: {
    id: string;
    discipline: string | null;
    userId: string | null;
    user: string | null;
    name: string | null;
    email: string | null;
    everyPurpose: boolean;
  }[];
}

export function RevisionControl({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['revision-control', projectId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Settings>(`/api/tenant/projects/${projectId}/revision-control`),
  });
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const [error, setError] = useState<string | null>(null);
  const blank = { discipline: '', who: '', name: '', email: '', everyPurpose: false };
  const [row, setRow] = useState(blank);
  const post = async (path: string, body: object) => {
    setError(null);
    try {
      qc.setQueryData(key, await api.request<Settings>(path, { method: 'POST', body }));
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const { rule, matrix } = q.data;
  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Revision series">
        <p className="mb-2 text-sm text-fg-muted">
          P1, P2… for information and approval, then the construction series. Each new revision must
          be the next label; once construction starts there is no going back to P.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Series">
            <Select
              value={rule.enabled ? rule.construction : 'off'}
              onChange={(e) =>
                void post(`/api/tenant/projects/${projectId}/revision-rule`, {
                  enabled: e.target.value !== 'off',
                  construction: e.target.value === 'off' ? rule.construction : e.target.value,
                })
              }
            >
              <option value="off">Off (labels are free)</option>
              <option value="numbers">P1, P2… then 0, 1, 2…</option>
              <option value="letters">P1, P2… then A, B, C…</option>
              <option value="r_numbers">P1, P2… then R0, R1…</option>
            </Select>
          </Field>
        </div>
      </Card>
      <Card title="Distribution matrix">
        <ul className="space-y-1 text-sm" aria-label="Distribution">
          {matrix.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{m.user ?? m.name}</span>
              <span className="text-fg-muted">
                {m.user
                  ? 'inside, acknowledges receipt'
                  : `outside${m.email ? `, ${m.email}` : ''}`}{' '}
                · {m.discipline ?? 'every discipline'} ·{' '}
                {m.everyPurpose ? 'every revision' : 'construction revisions'}
              </span>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void post(`/api/tenant/distribution/${m.id}/delete`, {})}
              >
                Remove
              </Button>
            </li>
          ))}
          {matrix.length === 0 && <li className="text-fg-muted">Nobody yet.</li>}
        </ul>
        <form
          aria-label="Add to the matrix"
          className="mt-3 grid gap-3 sm:grid-cols-5"
          onSubmit={async (e) => {
            e.preventDefault();
            const inside = row.who !== 'outside';
            if (
              await post(`/api/tenant/projects/${projectId}/distribution`, {
                discipline: row.discipline || null,
                userId: inside ? row.who : null,
                name: inside ? null : row.name,
                email: inside ? null : row.email || null,
                everyPurpose: row.everyPurpose,
              })
            )
              setRow(blank);
          }}
        >
          <Field label="Who">
            <Select
              value={row.who}
              onChange={(e) => setRow({ ...row, who: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {(project.data?.team ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
              <option value="outside">Someone outside…</option>
            </Select>
          </Field>
          {row.who === 'outside' && (
            <>
              <Field label="Name">
                <Input
                  value={row.name}
                  onChange={(e) => setRow({ ...row, name: e.target.value })}
                  required
                  minLength={2}
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={row.email}
                  onChange={(e) => setRow({ ...row, email: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="Discipline">
            <Select
              value={row.discipline}
              onChange={(e) => setRow({ ...row, discipline: e.target.value })}
            >
              <option value="">Every discipline</option>
              {DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Which revisions">
            <Select
              value={row.everyPurpose ? 'all' : 'construction'}
              onChange={(e) => setRow({ ...row, everyPurpose: e.target.value === 'all' })}
            >
              <option value="construction">For construction</option>
              <option value="all">Every revision</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit">Add</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
