// Quality (docs/wave3-plan.md step 14), for a project: inspection requests (and the hold on uninspected work),
// checklists, tests against their criteria, NCRs, snags and material approvals; the company's checklist templates.
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
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';

interface Register {
  holdUninspected: boolean;
  waiting: { lineKey: string; code: string; description: string; unit: string; qty: string }[];
  inspections: {
    id: string;
    number: string;
    item: string;
    description: string;
    location: string;
    requestedFor: string;
    status: string;
    inspector: string | null;
    comments: string;
    qty: string;
  }[];
  checklists: {
    id: string;
    template: string;
    doneOn: string;
    location: string;
    result: string;
    photos: number;
  }[];
  tests: {
    id: string;
    number: string;
    kind: string;
    sampleRef: string;
    testedOn: string;
    outcome: string;
    findings: string[];
  }[];
  ncrs: {
    id: string;
    number: string;
    source: string;
    description: string;
    status: string;
    rootCause: string;
    correctiveAction: string;
  }[];
  snags: { id: string; area: string; description: string; status: string; rowVersion: number }[];
  materialApprovals: { id: string; code: string; item: string; make: string; status: string }[];
  makeRequired: { id: string; code: string; name: string }[];
  mayManage: boolean;
}
interface Template {
  id: string;
  name: string;
  items: {
    text: string;
    kind: 'yes_no' | 'number' | 'note';
    required: boolean;
    min?: number;
    max?: number;
  }[];
  active: boolean;
}
const TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'accent'> = {
  approved: 'success',
  approved_with_comments: 'success',
  passed: 'success',
  closed: 'success',
  rejected: 'danger',
  failed: 'danger',
  open: 'warning',
  requested: 'warning',
  submitted: 'warning',
  action_taken: 'accent',
  fixed: 'accent',
  indicative: 'neutral',
};
const label = (s: string) => s.replace(/_/g, ' ');

export function QualityScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useState('');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Quality"
        subtitle="Inspections, checklists, tests, NCRs, snags and material approvals."
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
      {projectId ? <ProjectQuality key={projectId} projectId={projectId} /> : <Templates />}
    </div>
  );
}

function ProjectQuality({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['quality', projectId];
  const r = useQuery({
    queryKey: key,
    queryFn: () => api.request<Register>(`/api/tenant/projects/${projectId}/quality`),
  });
  const templates = useQuery({
    queryKey: ['qa-templates'],
    queryFn: () => api.request<Template[]>('/api/tenant/quality/checklist-templates'),
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const call = async (
    path: string,
    method: 'POST' | 'PUT',
    body: object,
    done?: (x: unknown) => void,
  ) => {
    setError(null);
    setNotice(null);
    try {
      const x = await api.request(path, { method, body });
      done?.(x);
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const [ir, setIr] = useState({ lineKey: '', location: '', activity: '', requestedFor: today() });
  const [decision, setDecision] = useState<
    Record<string, { status: string; inspector: string; comments: string }>
  >({});
  const [ck, setCk] = useState<{ templateId: string; location: string; answers: string[] }>({
    templateId: '',
    location: '',
    answers: [],
  });
  const [test, setTest] = useState({
    kind: 'cube',
    sampleRef: '',
    location: '',
    grade: 'M25',
    age: '28',
    cubes: '',
    slump: '',
    measured: '',
  });
  const [snag, setSnag] = useState({ area: '', description: '' });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  const tpl = (templates.data ?? []).find((t) => t.id === ck.templateId);
  const recordTest = (e: FormEvent) => {
    e.preventDefault();
    const spec: Record<string, unknown> = {};
    const results: Record<string, unknown> = {};
    if (test.kind === 'cube') {
      spec.grade = test.grade;
      results.age = Number(test.age);
      results.cubes = test.cubes
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number);
    } else {
      spec.slump = Number(test.slump);
      results.slump = Number(test.measured);
    }
    void call(
      `/api/tenant/projects/${projectId}/tests`,
      'POST',
      {
        kind: test.kind,
        sampleRef: test.sampleRef,
        location: test.location,
        sampledOn: today(),
        testedOn: today(),
        spec,
        results,
      },
      (x) => {
        const t = x as { number: string; outcome: string; ncr: string | null };
        setNotice(`${t.number}: ${t.outcome}${t.ncr ? `; ${t.ncr} raised` : ''}.`);
      },
    );
  };
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}
      <Card
        title="Inspection requests"
        actions={
          d.mayManage && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={d.holdUninspected}
                onChange={(e) =>
                  void call(`/api/tenant/projects/${projectId}/quality/hold`, 'PUT', {
                    hold: e.target.checked,
                  })
                }
              />
              Bill only inspected work
            </label>
          )
        }
      >
        {d.inspections.length > 0 && (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>No.</th>
                <th>Item</th>
                <th>Where</th>
                <th className="text-right">Qty</th>
                <th>For</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.inspections.map((i) => {
                const dec = decision[i.id] ?? { status: 'approved', inspector: '', comments: '' };
                return (
                  <tr key={i.id} aria-label={i.number}>
                    <td>{i.number}</td>
                    <td>
                      {i.item} {i.description}
                    </td>
                    <td>{i.location}</td>
                    <td className="text-right">{Number(i.qty)}</td>
                    <td>{i.requestedFor}</td>
                    <td>
                      <Badge tone={TONE[i.status] ?? 'neutral'}>{label(i.status)}</Badge>
                      {i.comments && <div className="text-xs text-fg-muted">{i.comments}</div>}
                      {i.status === 'requested' && d.mayManage && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Select
                            aria-label="Decision"
                            value={dec.status}
                            onChange={(e) =>
                              setDecision({
                                ...decision,
                                [i.id]: { ...dec, status: e.target.value },
                              })
                            }
                          >
                            <option value="approved">Approved</option>
                            <option value="approved_with_comments">With comments</option>
                            <option value="rejected">Rejected</option>
                          </Select>
                          <Input
                            aria-label="Inspector"
                            placeholder="Inspector"
                            value={dec.inspector}
                            onChange={(e) =>
                              setDecision({
                                ...decision,
                                [i.id]: { ...dec, inspector: e.target.value },
                              })
                            }
                          />
                          <Input
                            aria-label="Comments"
                            placeholder="Comments"
                            value={dec.comments}
                            onChange={(e) =>
                              setDecision({
                                ...decision,
                                [i.id]: { ...dec, comments: e.target.value },
                              })
                            }
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() =>
                              void call(`/api/tenant/inspections/${i.id}/decide`, 'POST', {
                                ...dec,
                                decidedOn: today(),
                              })
                            }
                          >
                            Record
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <form
          aria-label="Request an inspection"
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void call(`/api/tenant/projects/${projectId}/inspections`, 'POST', ir);
          }}
        >
          <Field label="Measured work">
            <Select
              value={ir.lineKey}
              onChange={(e) => setIr({ ...ir, lineKey: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {d.waiting.map((w) => (
                <option key={w.lineKey} value={w.lineKey}>
                  {w.code} {w.description} ({Number(w.qty)} {w.unit})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Location">
            <Input
              value={ir.location}
              onChange={(e) => setIr({ ...ir, location: e.target.value })}
            />
          </Field>
          <Field label="Activity">
            <Input
              value={ir.activity}
              onChange={(e) => setIr({ ...ir, activity: e.target.value })}
            />
          </Field>
          <Field label="For">
            <Input
              type="date"
              value={ir.requestedFor}
              onChange={(e) => setIr({ ...ir, requestedFor: e.target.value })}
            />
          </Field>
          <Button type="submit">Request</Button>
        </form>
      </Card>

      <Card title="Checklists">
        {d.checklists.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {d.checklists.map((c) => (
              <li key={c.id}>
                {c.doneOn} · {c.template} · {c.location}{' '}
                <Badge tone={TONE[c.result] ?? 'neutral'}>{c.result}</Badge>
              </li>
            ))}
          </ul>
        )}
        <form
          aria-label="Fill a checklist"
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call(
              `/api/tenant/projects/${projectId}/checklists`,
              'POST',
              {
                templateId: ck.templateId,
                doneOn: today(),
                location: ck.location,
                answers: (tpl?.items ?? []).map((it, i) => {
                  const a = ck.answers[i] ?? '';
                  return { answer: it.kind === 'number' && a !== '' ? Number(a) : a };
                }),
              },
              (x) => {
                const res = x as { result: string; findings: string[] };
                setNotice(
                  `Checklist ${res.result}${res.findings.length ? `: ${res.findings.join(' ')}` : '.'}`,
                );
              },
            );
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Checklist">
              <Select
                value={ck.templateId}
                onChange={(e) => setCk({ ...ck, templateId: e.target.value, answers: [] })}
                required
              >
                <option value="">Choose…</option>
                {(templates.data ?? [])
                  .filter((t) => t.active)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Location">
              <Input
                value={ck.location}
                onChange={(e) => setCk({ ...ck, location: e.target.value })}
              />
            </Field>
          </div>
          {tpl?.items.map((it, i) => (
            <div key={i} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="w-64">
                {it.text}
                {it.kind === 'number' && ` (${it.min ?? '…'}–${it.max ?? '…'})`}
              </span>
              {it.kind === 'yes_no' ? (
                <Select
                  aria-label={it.text}
                  value={ck.answers[i] ?? ''}
                  onChange={(e) => {
                    const a = [...ck.answers];
                    a[i] = e.target.value;
                    setCk({ ...ck, answers: a });
                  }}
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                  <option value="na">N/A</option>
                </Select>
              ) : (
                <Input
                  aria-label={it.text}
                  inputMode={it.kind === 'number' ? 'decimal' : 'text'}
                  value={ck.answers[i] ?? ''}
                  onChange={(e) => {
                    const a = [...ck.answers];
                    a[i] = e.target.value;
                    setCk({ ...ck, answers: a });
                  }}
                />
              )}
            </div>
          ))}
          {tpl && <Button type="submit">Save the checklist</Button>}
        </form>
      </Card>

      <Card title="Tests">
        {d.tests.length > 0 && (
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>No.</th>
                <th>Test</th>
                <th>Sample</th>
                <th>Tested</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {d.tests.map((t) => (
                <tr key={t.id}>
                  <td>{t.number}</td>
                  <td>{t.kind}</td>
                  <td>{t.sampleRef}</td>
                  <td>{t.testedOn}</td>
                  <td>
                    <Badge tone={TONE[t.outcome] ?? 'neutral'}>{t.outcome}</Badge>
                    {t.findings.length > 0 && (
                      <div className="text-xs text-fg-muted">{t.findings.join(' ')}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <form
          aria-label="Record a test"
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={recordTest}
        >
          <Field label="Test">
            <Select value={test.kind} onChange={(e) => setTest({ ...test, kind: e.target.value })}>
              <option value="cube">Concrete cubes</option>
              <option value="slump">Slump</option>
            </Select>
          </Field>
          <Field label="Sample">
            <Input
              value={test.sampleRef}
              onChange={(e) => setTest({ ...test, sampleRef: e.target.value })}
            />
          </Field>
          {test.kind === 'cube' ? (
            <>
              <Field label="Grade">
                <Input
                  value={test.grade}
                  onChange={(e) => setTest({ ...test, grade: e.target.value })}
                  className="w-20"
                />
              </Field>
              <Field label="Age (days)">
                <Select
                  value={test.age}
                  onChange={(e) => setTest({ ...test, age: e.target.value })}
                >
                  <option value="7">7</option>
                  <option value="28">28</option>
                </Select>
              </Field>
              <Field label="Three cubes (N/mm²)">
                <Input
                  value={test.cubes}
                  placeholder="26.5, 24, 25"
                  onChange={(e) => setTest({ ...test, cubes: e.target.value })}
                  required
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Specified (mm)">
                <Input
                  inputMode="numeric"
                  value={test.slump}
                  onChange={(e) => setTest({ ...test, slump: e.target.value })}
                  required
                />
              </Field>
              <Field label="Measured (mm)">
                <Input
                  inputMode="numeric"
                  value={test.measured}
                  onChange={(e) => setTest({ ...test, measured: e.target.value })}
                  required
                />
              </Field>
            </>
          )}
          <Button type="submit">Record</Button>
        </form>
      </Card>

      <Card title="NCRs">
        {d.ncrs.length === 0 ? (
          <p className="text-sm text-fg-muted">None.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.ncrs.map((n) => (
              <li key={n.id} data-testid={`ncr-${n.number}`}>
                <strong>{n.number}</strong>{' '}
                <Badge tone={TONE[n.status] ?? 'neutral'}>{label(n.status)}</Badge> {n.description}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Snags">
        {d.snags.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {d.snags.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                {s.area}: {s.description}{' '}
                <Badge tone={TONE[s.status] ?? 'neutral'}>{s.status}</Badge>
                {s.status !== 'closed' && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void call(`/api/tenant/snags/${s.id}`, 'PUT', {
                        status: s.status === 'open' ? 'fixed' : 'closed',
                        rowVersion: s.rowVersion,
                      })
                    }
                  >
                    {s.status === 'open' ? 'Fixed' : 'Close'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          aria-label="New snag"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void call(`/api/tenant/projects/${projectId}/snags`, 'POST', snag, () =>
              setSnag({ area: snag.area, description: '' }),
            );
          }}
        >
          <Field label="Area">
            <Input
              value={snag.area}
              onChange={(e) => setSnag({ ...snag, area: e.target.value })}
              required
            />
          </Field>
          <Field label="Snag">
            <Input
              value={snag.description}
              onChange={(e) => setSnag({ ...snag, description: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <Button type="submit" variant="secondary">
            Add
          </Button>
        </form>
      </Card>

      <Card title="Material approvals">
        {d.makeRequired.length > 0 && (
          <p className="mb-2 text-sm text-fg-muted">
            Ordered only in an approved make:{' '}
            {d.makeRequired.map((m) => `${m.code} ${m.name}`).join(', ')}.
          </p>
        )}
        {d.materialApprovals.length === 0 ? (
          <p className="text-sm text-fg-muted">None submitted.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.materialApprovals.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                {a.code} {a.item}: {a.make}{' '}
                <Badge tone={TONE[a.status] ?? 'neutral'}>{a.status}</Badge>
                {a.status === 'submitted' && d.mayManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void call(`/api/tenant/material-approvals/${a.id}/decide`, 'POST', {
                        status: 'approved',
                      })
                    }
                  >
                    Approve
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Templates() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['qa-templates'],
    queryFn: () => api.request<Template[]>('/api/tenant/quality/checklist-templates'),
  });
  const [name, setName] = useState('');
  const [items, setItems] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      // One item a line: "text", "text ?" for yes/no, "text # min-max" for a number, "text (note)" for a note.
      const parsed = items
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const num = /^(.*)#\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(l);
          if (num)
            return {
              text: num[1]!.trim(),
              kind: 'number',
              min: Number(num[2]),
              max: Number(num[3]),
            };
          if (/\(note\)$/i.test(l))
            return { text: l.replace(/\(note\)$/i, '').trim(), kind: 'note', required: false };
          return { text: l.replace(/\?$/, '').trim(), kind: 'yes_no' };
        });
      qc.setQueryData(
        ['qa-templates'],
        await api.request('/api/tenant/quality/checklist-templates', {
          method: 'POST',
          body: { name, items: parsed },
        }),
      );
      setName('');
      setItems('');
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Checklist templates">
      <p className="mb-3 text-sm text-fg-muted">Choose a project above to record its quality.</p>
      {list.data && list.data.length > 0 && (
        <ul className="mb-3 space-y-1 text-sm">
          {list.data.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong>: {t.items.map((i) => i.text).join('; ')}
            </li>
          ))}
        </ul>
      )}
      <form aria-label="New checklist template" className="space-y-2" onSubmit={(e) => void add(e)}>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </Field>
        <Field label='Items, one a line ("Cover blocks placed?", "Cover # 40-50", "Remarks (note)")'>
          <textarea
            className="h-28 w-full rounded-md border border-line bg-surface p-2 text-sm"
            value={items}
            onChange={(e) => setItems(e.target.value)}
            required
          />
        </Field>
        <Button type="submit">Add the template</Button>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
