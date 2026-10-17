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
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { useT } from '../../i18n/i18n';
import { describeError } from '../../lib/format';
import { sendOrKeep } from '../../offline';
import { useProjectParam } from '../../lib/project-param';
import { printLink } from '../../print/Letterhead';

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
  snags: {
    id: string;
    area: string;
    description: string;
    status: string;
    rowVersion: number;
    responsible: string | null;
    dueOn: string | null;
    backcharge: string | null;
    backcharged: boolean;
    overdue: boolean;
  }[];
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
  const t = useT();
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  // A register row opens this screen on its project (`?project=`).
  const [projectId, setProjectId] = useProjectParam();
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Quality')}
        subtitle={t('Inspections, checklists, tests, NCRs, snags and material approvals.')}
        actions={
          <Select
            aria-label={t('Project')}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t('Choose a project…')}</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} {p.name}
              </option>
            ))}
          </Select>
        }
      />
      {projectId ? (
        <ProjectQuality key={projectId} projectId={projectId} />
      ) : (
        <>
          <Templates />
          <TestCriteria />
        </>
      )}
    </div>
  );
}

function ProjectQuality({ projectId }: { projectId: string }) {
  const t = useT();
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
  const [snag, setSnag] = useState({
    area: '',
    description: '',
    responsiblePartyId: '',
    dueOn: '',
    backcharge: '',
  });
  const vendors = useQuery({
    queryKey: ['parties', 'vendor'],
    queryFn: () => api.request<{ id: string; name: string }[]>('/api/tenant/parties?kind=vendor'),
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  const tpl = (templates.data ?? []).find((x) => x.id === ck.templateId);
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
        const res = x as { number: string; outcome: string; ncr: string | null };
        setNotice(
          res.ncr
            ? t('{number}: {outcome}; {ncr} raised.', {
                number: res.number,
                outcome: t(res.outcome),
                ncr: res.ncr,
              })
            : t('{number}: {outcome}.', { number: res.number, outcome: t(res.outcome) }),
        );
      },
    );
  };
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}
      <Card
        title={t('Inspection requests')}
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
              {t('Bill only inspected work')}
            </label>
          )
        }
      >
        {d.inspections.length > 0 && (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>{t('No.')}</th>
                <th>{t('Item')}</th>
                <th>{t('Where')}</th>
                <th className="text-right">{t('Qty')}</th>
                <th>{t('For')}</th>
                <th>{t('Status')}</th>
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
                      <Badge tone={TONE[i.status] ?? 'neutral'}>{t(label(i.status))}</Badge>
                      {i.comments && <div className="text-xs text-fg-muted">{i.comments}</div>}
                      {i.status === 'requested' && d.mayManage && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Select
                            aria-label={t('Decision')}
                            value={dec.status}
                            onChange={(e) =>
                              setDecision({
                                ...decision,
                                [i.id]: { ...dec, status: e.target.value },
                              })
                            }
                          >
                            <option value="approved">{t('Approved')}</option>
                            <option value="approved_with_comments">{t('With comments')}</option>
                            <option value="rejected">{t('Rejected')}</option>
                          </Select>
                          <Input
                            aria-label={t('Inspector')}
                            placeholder={t('Inspector')}
                            value={dec.inspector}
                            onChange={(e) =>
                              setDecision({
                                ...decision,
                                [i.id]: { ...dec, inspector: e.target.value },
                              })
                            }
                          />
                          <Input
                            aria-label={t('Comments')}
                            placeholder={t('Comments')}
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
                            {t('Record')}
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
          aria-label={t('Request an inspection')}
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void call(`/api/tenant/projects/${projectId}/inspections`, 'POST', ir);
          }}
        >
          <Field label={t('Measured work')}>
            <Select
              value={ir.lineKey}
              onChange={(e) => setIr({ ...ir, lineKey: e.target.value })}
              required
            >
              <option value="">{t('Choose…')}</option>
              {d.waiting.map((w) => (
                <option key={w.lineKey} value={w.lineKey}>
                  {w.code} {w.description} ({Number(w.qty)} {w.unit})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('Location')}>
            <Input
              value={ir.location}
              onChange={(e) => setIr({ ...ir, location: e.target.value })}
            />
          </Field>
          <Field label={t('Activity')}>
            <Input
              value={ir.activity}
              onChange={(e) => setIr({ ...ir, activity: e.target.value })}
            />
          </Field>
          <Field label={t('For')}>
            <Input
              type="date"
              value={ir.requestedFor}
              onChange={(e) => setIr({ ...ir, requestedFor: e.target.value })}
            />
          </Field>
          <Button type="submit">{t('Request')}</Button>
        </form>
      </Card>

      <Card title={t('Checklists')}>
        {d.checklists.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {d.checklists.map((c) => (
              <li key={c.id}>
                {c.doneOn} · {c.template} · {c.location}{' '}
                <Badge tone={TONE[c.result] ?? 'neutral'}>{t(c.result)}</Badge>
              </li>
            ))}
          </ul>
        )}
        <form
          aria-label={t('Fill a checklist')}
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setNotice(null);
            void sendOrKeep<{ result: string; findings: string[] }>(
              `Checklist: ${tpl?.name ?? 'quality'}${ck.location ? ` at ${ck.location}` : ''}`,
              `/api/tenant/projects/${projectId}/checklists`,
              {
                templateId: ck.templateId,
                doneOn: today(),
                location: ck.location,
                answers: (tpl?.items ?? []).map((it, i) => {
                  const a = ck.answers[i] ?? '';
                  return { answer: it.kind === 'number' && a !== '' ? Number(a) : a };
                }),
              },
            ).then(
              (sent) => {
                if (sent.queued) {
                  setNotice(
                    t(
                      'Checklist saved on this phone; it will be sent when there is signal (see the Outbox).',
                    ),
                  );
                  return;
                }
                const res = sent.result;
                setNotice(
                  res.findings.length
                    ? t('Checklist {result}: {findings}', {
                        result: t(res.result),
                        findings: res.findings.join(' '),
                      })
                    : t('Checklist {result}.', { result: t(res.result) }),
                );
                void qc.invalidateQueries({ queryKey: key });
              },
              (err: unknown) => setError(describeError(err)),
            );
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('Checklist')}>
              <Select
                value={ck.templateId}
                onChange={(e) => setCk({ ...ck, templateId: e.target.value, answers: [] })}
                required
              >
                <option value="">{t('Choose…')}</option>
                {(templates.data ?? [])
                  .filter((x) => x.active)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('Location')}>
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
                  <option value="yes">{t('Yes')}</option>
                  <option value="no">{t('No')}</option>
                  <option value="na">{t('N/A')}</option>
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
          {tpl && <Button type="submit">{t('Save the checklist')}</Button>}
        </form>
      </Card>

      <Card title={t('Tests')}>
        {d.tests.length > 0 && (
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>{t('No.')}</th>
                <th>{t('Test')}</th>
                <th>{t('Sample')}</th>
                <th>{t('Tested')}</th>
                <th>{t('Result')}</th>
              </tr>
            </thead>
            <tbody>
              {d.tests.map((x) => (
                <tr key={x.id}>
                  <td>{x.number}</td>
                  <td>{t(x.kind)}</td>
                  <td>{x.sampleRef}</td>
                  <td>{x.testedOn}</td>
                  <td>
                    <Badge tone={TONE[x.outcome] ?? 'neutral'}>{t(x.outcome)}</Badge>
                    {x.findings.length > 0 && (
                      <div className="text-xs text-fg-muted">{x.findings.join(' ')}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <form
          aria-label={t('Record a test')}
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={recordTest}
        >
          <Field label={t('Test')}>
            <Select value={test.kind} onChange={(e) => setTest({ ...test, kind: e.target.value })}>
              <option value="cube">{t('Concrete cubes')}</option>
              <option value="slump">{t('Slump')}</option>
            </Select>
          </Field>
          <Field label={t('Sample')}>
            <Input
              value={test.sampleRef}
              onChange={(e) => setTest({ ...test, sampleRef: e.target.value })}
            />
          </Field>
          {test.kind === 'cube' ? (
            <>
              <Field label={t('Grade')}>
                <Input
                  value={test.grade}
                  onChange={(e) => setTest({ ...test, grade: e.target.value })}
                  className="w-20"
                />
              </Field>
              <Field label={t('Age (days)')}>
                <Select
                  value={test.age}
                  onChange={(e) => setTest({ ...test, age: e.target.value })}
                >
                  <option value="7">7</option>
                  <option value="28">28</option>
                </Select>
              </Field>
              <Field label={t('Three cubes (N/mm²)')}>
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
              <Field label={t('Specified (mm)')}>
                <Input
                  inputMode="numeric"
                  value={test.slump}
                  onChange={(e) => setTest({ ...test, slump: e.target.value })}
                  required
                />
              </Field>
              <Field label={t('Measured (mm)')}>
                <Input
                  inputMode="numeric"
                  value={test.measured}
                  onChange={(e) => setTest({ ...test, measured: e.target.value })}
                  required
                />
              </Field>
            </>
          )}
          <Button type="submit">{t('Record')}</Button>
        </form>
      </Card>

      <Card title={t('NCRs')}>
        {d.ncrs.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('None.')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.ncrs.map((n) => (
              <li key={n.id} data-testid={`ncr-${n.number}`}>
                <strong>{n.number}</strong>{' '}
                <Badge tone={TONE[n.status] ?? 'neutral'}>{t(label(n.status))}</Badge>{' '}
                {n.description}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('Snags')}>
        {d.snags.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {d.snags.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                {s.area}: {s.description}{' '}
                <Badge tone={TONE[s.status] ?? 'neutral'}>{t(s.status)}</Badge>
                {s.responsible && <span className="text-fg-muted">{s.responsible}</span>}
                {s.dueOn && (
                  <span className={s.overdue ? 'text-danger' : 'text-fg-muted'}>
                    {s.overdue
                      ? t('overdue since {date}', { date: s.dueOn })
                      : t('due {date}', { date: s.dueOn })}
                  </span>
                )}
                {s.backcharge && (
                  <Badge tone={s.backcharged ? 'success' : 'warning'}>
                    {s.backcharged
                      ? t('charged ₹{amount}', { amount: s.backcharge })
                      : t('to charge ₹{amount}', { amount: s.backcharge })}
                  </Badge>
                )}
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
                    {s.status === 'open' ? t('Fixed') : t('Close')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          aria-label={t('New snag')}
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void call(
              `/api/tenant/projects/${projectId}/snags`,
              'POST',
              {
                area: snag.area,
                description: snag.description,
                responsiblePartyId: snag.responsiblePartyId || null,
                dueOn: snag.dueOn || null,
                backcharge: snag.backcharge || null,
              },
              () => setSnag({ ...snag, description: '', backcharge: '' }),
            );
          }}
        >
          <Field label={t('Area')}>
            <Input
              value={snag.area}
              onChange={(e) => setSnag({ ...snag, area: e.target.value })}
              required
            />
          </Field>
          <Field label={t('Snag')}>
            <Input
              value={snag.description}
              onChange={(e) => setSnag({ ...snag, description: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <Field label={t('Whose to fix')}>
            <Select
              value={snag.responsiblePartyId}
              onChange={(e) => setSnag({ ...snag, responsiblePartyId: e.target.value })}
            >
              <option value="">{t('Our own team')}</option>
              {(vendors.data ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('Fix by')}>
            <Input
              type="date"
              value={snag.dueOn}
              onChange={(e) => setSnag({ ...snag, dueOn: e.target.value })}
            />
          </Field>
          {snag.responsiblePartyId && (
            <Field label={t('Back-charge ₹')}>
              <Input
                inputMode="decimal"
                value={snag.backcharge}
                onChange={(e) => setSnag({ ...snag, backcharge: e.target.value })}
                pattern="\d+(\.\d{1,2})?"
              />
            </Field>
          )}
          <Button type="submit" variant="secondary">
            {t('Add')}
          </Button>
        </form>
      </Card>

      <Handovers projectId={projectId} />
      <DefectLiability projectId={projectId} />

      <Card title={t('Material approvals')}>
        {d.makeRequired.length > 0 && (
          <p className="mb-2 text-sm text-fg-muted">
            {t('Ordered only in an approved make: {list}.', {
              list: d.makeRequired.map((m) => `${m.code} ${m.name}`).join(', '),
            })}
          </p>
        )}
        {d.materialApprovals.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('None submitted.')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.materialApprovals.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                {a.code} {a.item}: {a.make}{' '}
                <Badge tone={TONE[a.status] ?? 'neutral'}>{t(a.status)}</Badge>
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
                    {t('Approve')}
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

interface Handover {
  id: string;
  number: string;
  area: string;
  handedTo: string;
  checklist: { item: string; ok: boolean; note: string }[];
  status: string;
  handedOn: string | null;
  openSnags: number;
}

/** Handing an area over (docs/wave8-plan.md step 8d.3): its checklist, and no open snag in it. */
function Handovers({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const key = ['handovers', projectId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.request<Handover[]>(`/api/tenant/projects/${projectId}/handovers`),
  });
  const [form, setForm] = useState({ area: '', handedTo: '', items: '' });
  const [error, setError] = useState<string | null>(null);
  const run = async (path: string, body: object) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      void qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  return (
    <Card title={t('Handovers')}>
      {error && <Alert tone="danger">{error}</Alert>}
      {(list.data ?? []).length > 0 && (
        <ul className="mb-3 space-y-1 text-sm">
          {(list.data ?? []).map((h) => {
            const unticked = h.checklist.filter((c) => !c.ok).length;
            return (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                {h.number} {t('{area} to {person}', { area: h.area, person: h.handedTo })}{' '}
                <Badge tone={h.status === 'handed_over' ? 'success' : 'warning'}>
                  {h.status === 'handed_over'
                    ? t('handed over {date}', { date: String(h.handedOn) })
                    : t(label(h.status))}
                </Badge>
                {h.status !== 'handed_over' && (
                  <span className="text-fg-muted">
                    {t('{checks} checks open, {snags} snags open', {
                      checks: unticked,
                      snags: h.openSnags,
                    })}
                  </span>
                )}
                {h.status !== 'handed_over' && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void run(`/api/tenant/handovers/${h.id}/hand-over`, { on: today() })
                    }
                  >
                    {t('Hand over')}
                  </Button>
                )}
                {h.status !== 'handed_over' && (
                  <span className="flex w-full flex-wrap gap-3 pl-4">
                    {h.checklist.map((c, k) => (
                      <label key={k} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={c.ok}
                          onChange={(e) =>
                            void run(`/api/tenant/handovers/${h.id}/check`, {
                              index: k,
                              ok: e.target.checked,
                            })
                          }
                        />
                        {c.item}
                      </label>
                    ))}
                  </span>
                )}
                {h.status === 'handed_over' && (
                  <Link
                    to="/print/handovers/$handoverId"
                    params={{ handoverId: h.id }}
                    className={printLink}
                  >
                    {t('Certificate')}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form
        aria-label={t('New handover')}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(`/api/tenant/projects/${projectId}/handovers`, {
            area: form.area,
            handedTo: form.handedTo,
            checklist: form.items
              .split(/\n|;/)
              .map((x) => x.trim())
              .filter(Boolean)
              .map((item) => {
                const ok = item.startsWith('+');
                return { item: ok ? item.slice(1).trim() : item, ok, note: '' };
              }),
          }).then((ok) => ok && setForm({ area: '', handedTo: form.handedTo, items: '' }));
        }}
      >
        <Field label={t('Area')}>
          <Input
            value={form.area}
            onChange={(e) => setForm({ ...form, area: e.target.value })}
            required
          />
        </Field>
        <Field label={t('Handed to')}>
          <Input
            value={form.handedTo}
            onChange={(e) => setForm({ ...form, handedTo: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Field label={t('Checks, separated by ; (start with + when done)')}>
          <Input
            value={form.items}
            onChange={(e) => setForm({ ...form, items: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Button type="submit" variant="secondary">
          {t('Add handover')}
        </Button>
      </form>
    </Card>
  );
}

interface Dlp {
  retention: { held: string; released: string; due: string };
  contracts: {
    id: string;
    reference: string;
    completionOn: string | null;
    endsOn: string | null;
    dlpMonths: number;
    state: 'not_complete' | 'running' | 'ended';
    securities: { kind: string; number: string; amount: string; validUntil: string }[];
    openDefects: number;
  }[];
  defects: {
    id: string;
    contractId: string | null;
    area: string;
    description: string;
    reportedOn: string;
    reportedBy: string;
    responsible: string | null;
    status: string;
    fixedOn: string | null;
  }[];
}

/** The defect liability period: when each contract's ends, the retention and guarantees it releases, the defects. */
function DefectLiability({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const key = ['dlp', projectId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Dlp>(`/api/tenant/projects/${projectId}/dlp`),
  });
  const vendors = useQuery({
    queryKey: ['parties', 'vendor'],
    queryFn: () => api.request<{ id: string; name: string }[]>('/api/tenant/parties?kind=vendor'),
  });
  const [form, setForm] = useState({
    contractId: '',
    area: '',
    description: '',
    reportedBy: '',
    responsiblePartyId: '',
  });
  const [error, setError] = useState<string | null>(null);
  const run = async (path: string, body: object) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      void qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const d = q.data;
  return (
    <Card title={t('Defect liability')}>
      {error && <Alert tone="danger">{error}</Alert>}
      {d && (
        <>
          <p className="mb-2 text-sm">
            {t('Retention held ₹{held}, released ₹{released}, to recover ₹{due}.', {
              held: d.retention.held,
              released: d.retention.released,
              due: d.retention.due,
            })}
          </p>
          {d.contracts.length > 0 && (
            <ul className="mb-3 space-y-1 text-sm">
              {d.contracts.map((c) => (
                <li key={c.id}>
                  {c.reference}:{' '}
                  {c.state === 'not_complete'
                    ? t('not yet complete')
                    : t(
                        c.state === 'ended'
                          ? '{n} months ended {date}'
                          : '{n} months ending {date}',
                        {
                          n: c.dlpMonths,
                          date: String(c.endsOn),
                        },
                      )}
                  {c.openDefects > 0 && t(', {n} defects open', { n: c.openDefects })}
                  {c.securities.map((s) => (
                    <span key={s.number} className="text-fg-muted">
                      {' '}
                      · {t(label(s.kind))} {s.number}{' '}
                      {t('₹{amount} till {date}', { amount: s.amount, date: s.validUntil })}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {d.defects.length > 0 && (
            <ul className="mb-3 space-y-1 text-sm">
              {d.defects.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-2">
                  {x.reportedOn} {x.area}: {x.description}
                  {x.responsible && <span className="text-fg-muted">{x.responsible}</span>}
                  <Badge tone={x.status === 'fixed' ? 'success' : 'warning'}>
                    {x.status === 'fixed'
                      ? t('fixed {date}', { date: String(x.fixedOn) })
                      : t(x.status)}
                  </Badge>
                  {x.status === 'open' && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void run(`/api/tenant/defects/${x.id}/fixed`, { on: today() })}
                    >
                      {t('Fixed')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <form
        aria-label={t('Report a defect')}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(`/api/tenant/projects/${projectId}/defects`, {
            contractId: form.contractId || null,
            area: form.area,
            description: form.description,
            reportedOn: today(),
            reportedBy: form.reportedBy,
            responsiblePartyId: form.responsiblePartyId || null,
          }).then((ok) => ok && setForm({ ...form, description: '' }));
        }}
      >
        <Field label={t('Contract')}>
          <Select
            value={form.contractId}
            onChange={(e) => setForm({ ...form, contractId: e.target.value })}
          >
            <option value="">{t('The project')}</option>
            {(d?.contracts ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.reference}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Where')}>
          <Input
            value={form.area}
            onChange={(e) => setForm({ ...form, area: e.target.value })}
            required
          />
        </Field>
        <Field label={t('Defect')}>
          <Input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            required
            minLength={3}
          />
        </Field>
        <Field label={t('Reported by')}>
          <Input
            value={form.reportedBy}
            onChange={(e) => setForm({ ...form, reportedBy: e.target.value })}
          />
        </Field>
        <Field label={t('Whose to fix')}>
          <Select
            value={form.responsiblePartyId}
            onChange={(e) => setForm({ ...form, responsiblePartyId: e.target.value })}
          >
            <option value="">{t('Our own team')}</option>
            {(vendors.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary">
          {t('Report')}
        </Button>
      </form>
    </Card>
  );
}

function Templates() {
  const t = useT();
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
    <Card title={t('Checklist templates')}>
      <p className="mb-3 text-sm text-fg-muted">
        {t('Choose a project above to record its quality.')}
      </p>
      {list.data && list.data.length > 0 && (
        <ul className="mb-3 space-y-1 text-sm">
          {list.data.map((x) => (
            <li key={x.id}>
              <strong>{x.name}</strong>: {x.items.map((i) => i.text).join('; ')}
            </li>
          ))}
        </ul>
      )}
      <form
        aria-label={t('New checklist template')}
        className="space-y-2"
        onSubmit={(e) => void add(e)}
      >
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </Field>
        <Field
          label={t('Items, one a line ("Cover blocks placed?", "Cover # 40-50", "Remarks (note)")')}
        >
          <textarea
            className="h-28 w-full rounded-md border border-line bg-surface p-2 text-sm"
            value={items}
            onChange={(e) => setItems(e.target.value)}
            required
          />
        </Field>
        <Button type="submit">{t('Add the template')}</Button>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

interface Criteria {
  kind: string;
  effectiveFrom: string;
  data: Record<string, unknown>;
  note: string;
}
const KINDS = ['cube', 'slump', 'steel', 'soil', 'brick'] as const;
const KIND_NAME: Record<string, string> = {
  cube: 'Concrete cubes',
  slump: 'Slump',
  steel: 'Reinforcement steel',
  soil: 'Soil compaction',
  brick: 'Bricks',
};

/** Numbers in a criteria record as "a.b" paths, and back. */
function flatten(o: Record<string, unknown>, prefix = ''): [string, string][] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [[`${prefix}${k}`, String(v)] as [string, string]],
  );
}
function unflatten(rows: [string, string][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, v] of rows) {
    const keys = path.split('.');
    let at = out;
    for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>;
    const n = Number(v);
    at[keys[keys.length - 1]!] = v.trim() !== '' && Number.isFinite(n) ? n : v;
  }
  return out;
}

/** The acceptance values tests are judged against: one version per kind from a date (Quality, for managers). */
function TestCriteria() {
  const t = useT();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['test-criteria'],
    queryFn: () => api.request<Criteria[]>('/api/tenant/quality/test-criteria'),
  });
  const [kind, setKind] = useState<string>('cube');
  const [from, setFrom] = useState(today());
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<[string, string][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const latest = (k: string) => list.data?.find((c) => c.kind === k);
  const current = rows ?? flatten(latest(kind)?.data ?? {});
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api.request('/api/tenant/quality/test-criteria', {
        method: 'POST',
        body: { kind, effectiveFrom: from, data: unflatten(current), note },
      });
      setRows(null);
      setNote('');
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['test-criteria'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title={t('Test acceptance criteria')}>
      <p className="mb-3 text-sm text-fg-muted">
        {t(
          'Tests are judged against the criteria in force on the day they were tested. A change takes effect from its date; earlier tests keep the old values.',
        )}
      </p>
      {list.data && (
        <Table minWidth="36rem">
          <thead>
            <tr>
              <th>{t('Test')}</th>
              <th>{t('From')}</th>
              <th>{t('Values')}</th>
              <th>{t('Note')}</th>
            </tr>
          </thead>
          <tbody aria-label={t('Test criteria')}>
            {list.data.map((c) => (
              <tr key={`${c.kind}-${c.effectiveFrom}`}>
                <td>{t(KIND_NAME[c.kind] ?? c.kind)}</td>
                <td>{c.effectiveFrom}</td>
                <td className="text-xs">
                  {flatten(c.data)
                    .map(([k, v]) => `${k} ${v}`)
                    .join('; ')}
                </td>
                <td className="text-xs text-fg-muted">{c.note}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        aria-label={t('New criteria')}
        className="mt-4 space-y-3"
        onSubmit={(e) => void save(e)}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('Test')}>
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setRows(null);
              }}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(KIND_NAME[k]!)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('In force from')}>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </Field>
          <Field label={t('Note')}>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('e.g. IS 456')}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {current.map(([k, v], i) => (
            <Field key={k} label={k}>
              <Input
                inputMode="decimal"
                value={v}
                onChange={(e) => {
                  const next = [...current];
                  next[i] = [k, e.target.value];
                  setRows(next);
                }}
              />
            </Field>
          ))}
        </div>
        <Button type="submit" disabled={!current.length}>
          {t('Save criteria')}
        </Button>
        {saved && (
          <Alert tone="success">{t('Saved; tests from that date are judged against it.')}</Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Card>
  );
}
