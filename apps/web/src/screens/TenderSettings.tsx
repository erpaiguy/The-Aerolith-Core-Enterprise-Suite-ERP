// The company's tender settings (docs/wave1-plan.md step 13): its bid/no-bid criteria and weights, its standard
// document checklist, the standard folders of a tender's documents and how long their trash keeps documents. Admin
// only; until changed, the built-in lists apply and the trash keeps everything.
import {
  Alert,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  Spinner,
  toast,
  useConfirm,
} from '@aerolith/ui';
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
      <DocumentSettings />
    </div>
  );
}

interface DocSettings {
  folders: { path: string; restricted: boolean }[];
  foldersCustomised: boolean;
  trashDays: number | null;
}

function DocumentSettings() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['document-settings'],
    queryFn: () => api.request<DocSettings>('/api/tenant/document-settings'),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ what: string; message: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const confirm = useConfirm();
  const save = async (what: 'folders' | 'trash', body: object) => {
    if (
      what === 'folders' &&
      Object.values(body).every((v) => v === null) &&
      !(await confirm({
        title: 'Go back to the built-in folders?',
        body: 'Your own folder list is deleted; new tenders get the built-in folders. Tenders made already keep theirs.',
        confirmLabel: 'Use the built-in folders',
        tone: 'danger',
      }))
    )
      return;
    setBusy(what);
    setError(null);
    setSaved(null);
    try {
      qc.setQueryData(
        ['document-settings'],
        await api.request<DocSettings>(`/api/tenant/document-settings/${what}`, {
          method: 'POST',
          body,
        }),
      );
      setSaved(what);
      toast.success(what === 'folders' ? 'Document folders saved' : 'Bin period saved');
    } catch (err) {
      setError({ what, message: describeError(err) });
    } finally {
      setBusy(null);
    }
  };
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  return (
    <>
      <FoldersCard
        key={JSON.stringify(q.data.folders)}
        settings={q.data}
        busy={busy === 'folders'}
        saved={saved === 'folders'}
        error={error?.what === 'folders' ? error.message : null}
        save={(body) => void save('folders', body)}
      />
      <Card title="Trash">
        <p className="mb-3 text-sm text-fg-muted">
          Documents moved to a tender&rsquo;s trash can be restored until they are deleted for good:
          by you, from the trash, or by this rule.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Keep documents in the trash"
            className="w-64"
            value={q.data.trashDays ?? ''}
            disabled={busy === 'trash'}
            onChange={(e) =>
              void save('trash', { days: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">Keep them until deleted by hand</option>
            {[30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                Delete for good after {d} days
              </option>
            ))}
          </Select>
          {saved === 'trash' && <span className="text-sm text-success">Saved.</span>}
        </div>
        {error?.what === 'trash' && (
          <div className="mt-3">
            <Alert tone="danger">{error.message}</Alert>
          </div>
        )}
      </Card>
    </>
  );
}

function FoldersCard({
  settings,
  busy,
  saved,
  error,
  save,
}: {
  settings: DocSettings;
  busy: boolean;
  saved: boolean;
  error: string | null;
  save: (body: object) => void;
}) {
  const [list, setList] = useState(settings.folders);
  return (
    <Card title="Standard folders for tender documents">
      <p className="mb-3 text-sm text-fg-muted">
        &ldquo;Add the standard folders&rdquo; on a tender&rsquo;s Documents tab makes these. Write
        a folder inside another as <span className="font-mono">Drawings/Structural</span>; a
        restricted folder, and everything in it, is seen only by roles that see bid pricing.
        {!settings.foldersCustomised && ' These are the built-in folders.'}
      </p>
      <ol className="space-y-2" aria-label="Standard folders">
        {list.map((f, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Folder ${i + 1}`}
              value={f.path}
              onChange={(e) =>
                setList(list.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))
              }
              className="min-w-[16rem] flex-1"
            />
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={f.restricted}
                onChange={(e) =>
                  setList(
                    list.map((x, j) => (j === i ? { ...x, restricted: e.target.checked } : x)),
                  )
                }
              />
              Restricted
            </label>
            <Button
              variant="ghost"
              onClick={() => setList(list.filter((_, j) => j !== i))}
              aria-label={`Remove folder ${i + 1}`}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={list.length >= 200}
          onClick={() => setList([...list, { path: '', restricted: false }])}
        >
          <Plus className="size-4" aria-hidden /> Add folder
        </Button>
        <div className="ml-auto flex gap-2">
          {settings.foldersCustomised && (
            <Button variant="ghost" onClick={() => save({ folders: null })}>
              Back to the built-in folders
            </Button>
          )}
          <Button
            busy={busy}
            disabled={list.length === 0 || list.some((f) => !f.path.trim())}
            onClick={() => save({ folders: list })}
          >
            Save folders
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
          <Alert tone="success">Saved. Tenders get these folders from now on.</Alert>
        </div>
      )}
    </Card>
  );
}

function useSave(path: string) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const confirm = useConfirm();
  const what = path === 'checklist' ? 'submission checklist' : 'bid criteria';
  const save = async (body: object) => {
    if (
      Object.values(body).every((v) => v === null) &&
      !(await confirm({
        title: `Go back to the built-in ${what}?`,
        body: `Your own list is deleted; the built-in ${what} apply from now on.`,
        confirmLabel: 'Use the built-in list',
        tone: 'danger',
      }))
    )
      return;
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
      toast.success(path === 'checklist' ? 'Submission checklist saved' : 'Bid criteria saved');
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
