// Joining and exit checklists (docs/wave7-plan.md step 7d.8), on the employee's page: each step done or not, the ones
// the records answer (PAN, bank, UAN, sign-in, deployment; sign-in closed, settlement posted) marked as such, with a
// link to where they are put right; HR ticks the rest.
import { Alert, Badge, Button, Card, Input } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Circle } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { describeError } from '../../lib/format';
import { shortDate } from '../../schedule/model';

type Kind = 'joining' | 'exit';
interface Step {
  id: string;
  key: string;
  label: string;
  auto: boolean;
  done: boolean;
  doneOn: string | null;
  doneBy: string | null;
  note: string;
}
interface Lists {
  joining: { steps: Step[]; done: number; complete: boolean } | null;
  exit: { steps: Step[]; done: number; complete: boolean } | null;
  leftOn: string | null;
  mayEdit: boolean;
}
/** Where a step the records answer is put right. */
const WHERE: Record<string, { to: string; label: string }> = {
  sign_in: { to: '/users', label: 'Users' },
  sign_in_closed: { to: '/users', label: 'Users' },
};

export function ChecklistsCard({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const key = ['people-checklists', employeeId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Lists>(`/api/tenant/hr/employees/${employeeId}/checklists`),
  });
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (!q.data) return null;
  const x = q.data;
  const send = async (url: string, body: object) => {
    setError(null);
    try {
      qc.setQueryData(key, await api.request<Lists>(url, { method: 'POST', body }));
    } catch (err) {
      setError(describeError(err));
    }
  };
  const list = (kind: Kind, title: string) => {
    const l = x[kind];
    if (!l)
      return x.mayEdit && (kind === 'joining' || x.leftOn) ? (
        <Button
          variant="secondary"
          onClick={() => void send(`/api/tenant/hr/employees/${employeeId}/checklists`, { kind })}
        >
          Start the {kind} checklist
        </Button>
      ) : null;
    return (
      <section>
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          {title}
          <Badge tone={l.complete ? 'success' : 'warning'}>
            {l.done} of {l.steps.length}
          </Badge>
        </h3>
        <ul className="divide-y divide-line text-sm" aria-label={`${title} steps`}>
          {l.steps.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5">
              {s.done ? (
                <CheckCircle2 className="size-4 text-success" aria-label="done" />
              ) : (
                <Circle className="size-4 text-fg-muted" aria-label="to do" />
              )}
              <span className="flex-1">
                {s.label}
                {s.auto ? (
                  <span className="ml-1 text-xs text-fg-muted">
                    (from the records
                    {WHERE[s.key] ? (
                      <>
                        {': '}
                        <Link to={WHERE[s.key]!.to} className="hover:underline">
                          {WHERE[s.key]!.label}
                        </Link>
                      </>
                    ) : null}
                    )
                  </span>
                ) : null}
                {!s.auto && s.doneOn ? (
                  <span className="ml-1 text-xs text-fg-muted">
                    {shortDate(s.doneOn)}
                    {s.doneBy ? ` · ${s.doneBy}` : ''}
                    {s.note ? ` · ${s.note}` : ''}
                  </span>
                ) : null}
              </span>
              {x.mayEdit && !s.auto ? (
                s.done ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void send(`/api/tenant/hr/checklist-steps/${s.id}`, { done: false })
                    }
                  >
                    Undo
                  </Button>
                ) : (
                  <span className="flex gap-1">
                    <Input
                      aria-label={`Note for ${s.label}`}
                      placeholder="Note"
                      value={notes[s.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })}
                    />
                    <Button
                      variant="secondary"
                      aria-label={`Done: ${s.label}`}
                      onClick={() =>
                        void send(`/api/tenant/hr/checklist-steps/${s.id}`, {
                          done: true,
                          note: notes[s.id] ?? '',
                        })
                      }
                    >
                      Done
                    </Button>
                  </span>
                )
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    );
  };
  return (
    <Card title="Joining and leaving">
      <div className="space-y-4">
        {list('joining', 'Joining')}
        {list('exit', 'Leaving')}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Card>
  );
}
