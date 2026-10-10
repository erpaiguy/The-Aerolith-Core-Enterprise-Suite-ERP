// The company's tender settings (docs/wave1-plan.md step 13): its bid/no-bid criteria and weights, and its standard
// document checklist. Admin only; until changed, the built-in lists apply.
import { Alert, Button, Card, Input, PageHeader, Select, Spinner } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';

interface Criterion {
  key?: string;
  label: string;
  weight: number;
}
interface Item {
  envelope: 'technical' | 'financial' | 'other';
  title: string;
  required: boolean;
}
interface Settings {
  criteria: Criterion[];
  checklist: Item[];
  criteriaCustomised: boolean;
  checklistCustomised: boolean;
}

const move = <T,>(list: T[], i: number, by: number) => {
  const next = [...list];
  const [x] = next.splice(i, 1);
  next.splice(i + by, 0, x!);
  return next;
};

export function TenderSettingsScreen() {
  // Saving replaces the settings, which re-creates the cards with the saved lists; their outcome lives here.
  const criteriaSave = useSave('bid-criteria');
  const checklistSave = useSave('checklist');
  const q = useQuery({
    queryKey: ['tender-settings'],
    queryFn: () => api.request<Settings>('/api/tenant/tender-settings'),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Tender settings"
        subtitle="Your company's bid/no-bid criteria and standard document checklist."
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <>
          <CriteriaCard
            key={JSON.stringify(q.data.criteria)}
            settings={q.data}
            saver={criteriaSave}
          />
          <ChecklistCard
            key={JSON.stringify(q.data.checklist)}
            settings={q.data}
            saver={checklistSave}
          />
        </>
      )}
    </div>
  );
}

function useSave(path: string) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (body: object) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      qc.setQueryData(
        ['tender-settings'],
        await api.request<Settings>(`/api/tenant/tender-settings/${path}`, {
          method: 'POST',
          body,
        }),
      );
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, saved, save };
}

type Saver = ReturnType<typeof useSave>;

function CriteriaCard({ settings, saver }: { settings: Settings; saver: Saver }) {
  const [list, setList] = useState<Criterion[]>(settings.criteria);
  const { busy, error, saved, save } = saver;
  const total = list.reduce((a, c) => a + c.weight, 0);
  return (
    <Card title="Bid/no-bid criteria">
      <p className="mb-3 text-sm text-fg-muted">
        Each is scored 1 to 5 when a tender is decided; the weights decide how much each counts in
        the 0-100 score. Decisions already made keep the criteria they were scored on.
        {!settings.criteriaCustomised && ' These are the built-in criteria.'}
      </p>
      <ol className="space-y-2" aria-label="Criteria">
        {list.map((c, i) => (
          <li key={i} className="flex items-center gap-2">
            <Input
              aria-label={`Criterion ${i + 1}`}
              value={c.label}
              onChange={(e) =>
                setList(list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
              }
              className="flex-1"
            />
            <Select
              aria-label={`Weight of criterion ${i + 1}`}
              value={c.weight}
              className="w-24"
              onChange={(e) =>
                setList(
                  list.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)),
                )
              }
            >
              {[0, 1, 2, 3, 4, 5].map((w) => (
                <option key={w} value={w}>
                  Weight {w}
                </option>
              ))}
            </Select>
            <span className="w-12 text-right text-xs tabular-nums text-fg-muted">
              {total ? `${Math.round((c.weight / total) * 100)} %` : ''}
            </span>
            <Button
              variant="ghost"
              disabled={i === 0}
              onClick={() => setList(move(list, i, -1))}
              aria-label={`Move criterion ${i + 1} up`}
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              disabled={i === list.length - 1}
              onClick={() => setList(move(list, i, 1))}
              aria-label={`Move criterion ${i + 1} down`}
            >
              <ArrowDown className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              disabled={list.length === 1}
              onClick={() => setList(list.filter((_, j) => j !== i))}
              aria-label={`Remove criterion ${i + 1}`}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={list.length >= 20}
          onClick={() => setList([...list, { label: '', weight: 1 }])}
        >
          <Plus className="size-4" aria-hidden /> Add criterion
        </Button>
        <div className="ml-auto flex gap-2">
          {settings.criteriaCustomised && (
            <Button variant="ghost" onClick={() => void save({ criteria: null })}>
              Back to the built-in list
            </Button>
          )}
          <Button
            busy={busy}
            disabled={list.some((c) => c.label.trim().length < 3)}
            onClick={() =>
              void save({ criteria: list.map((c) => ({ ...c, label: c.label.trim() })) })
            }
          >
            Save criteria
          </Button>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {saved && (
        <div className="mt-3">
          <Alert tone="success">Saved. New decisions use these criteria.</Alert>
        </div>
      )}
    </Card>
  );
}

function ChecklistCard({ settings, saver }: { settings: Settings; saver: Saver }) {
  const [list, setList] = useState<Item[]>(settings.checklist);
  const { busy, error, saved, save } = saver;
  return (
    <Card title="Standard document checklist">
      <p className="mb-3 text-sm text-fg-muted">
        Added to a tender with &ldquo;Add standard checklist&rdquo;, then edited there as needed.
        {!settings.checklistCustomised && ' This is the built-in list.'}
      </p>
      <ol className="space-y-2" aria-label="Checklist items">
        {list.map((c, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={`Envelope of item ${i + 1}`}
              value={c.envelope}
              className="w-36"
              onChange={(e) =>
                setList(
                  list.map((x, j) =>
                    j === i ? { ...x, envelope: e.target.value as Item['envelope'] } : x,
                  ),
                )
              }
            >
              <option value="technical">Technical</option>
              <option value="financial">Financial</option>
              <option value="other">Other</option>
            </Select>
            <Input
              aria-label={`Checklist item ${i + 1}`}
              value={c.title}
              onChange={(e) =>
                setList(list.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
              }
              className="min-w-[16rem] flex-1"
            />
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={c.required}
                onChange={(e) =>
                  setList(list.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))
                }
              />
              Required
            </label>
            <Button
              variant="ghost"
              onClick={() => setList(list.filter((_, j) => j !== i))}
              aria-label={`Remove checklist item ${i + 1}`}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={list.length >= 100}
          onClick={() => setList([...list, { envelope: 'technical', title: '', required: true }])}
        >
          <Plus className="size-4" aria-hidden /> Add item
        </Button>
        <div className="ml-auto flex gap-2">
          {settings.checklistCustomised && (
            <Button variant="ghost" onClick={() => void save({ items: null })}>
              Back to the built-in list
            </Button>
          )}
          <Button
            busy={busy}
            disabled={list.some((c) => c.title.trim().length < 3)}
            onClick={() => void save({ items: list.map((c) => ({ ...c, title: c.title.trim() })) })}
          >
            Save checklist
          </Button>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {saved && (
        <div className="mt-3">
          <Alert tone="success">Saved.</Alert>
        </div>
      )}
    </Card>
  );
}
