// Master document list (docs/wave7-plan.md step 7d.3): the drawings, approvals and certificates a project expects,
// from whom and by when; each marked received with its date and, if it is in the project's documents, the file.
// Still to come after its planned date: late.
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
  Textarea,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { DocVault, ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { shortDate } from '../schedule/model';

const CATEGORIES = {
  drawing: 'Drawing',
  specification: 'Specification',
  approval: 'Approval',
  method_statement: 'Method statement',
  test_certificate: 'Test certificate',
  report: 'Report',
  other: 'Other',
} as const;
type Category = keyof typeof CATEGORIES;

interface Row {
  id: string;
  code: string;
  title: string;
  category: Category;
  fromParty: string;
  plannedOn: string;
  receivedOn: string | null;
  documentId: string | null;
  document: string | null;
  note: string;
  daysLate: number;
  late: boolean;
}
interface List {
  rows: Row[];
  totals: { expected: number; received: number; late: number; receivedLate: number };
  mayWrite: boolean;
}
const today = () => new Date().toISOString().slice(0, 10);

export function DocumentListScreen({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const list = useQuery({
    queryKey: ['expected-documents', projectId],
    queryFn: () => api.request<List>(`/api/tenant/projects/${projectId}/expected-documents`),
  });
  const [show, setShow] = useState<'all' | 'late' | 'awaited' | 'received'>('all');
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState<Row | null>(null);
  const rows = (list.data?.rows ?? []).filter((r) =>
    show === 'late'
      ? r.late
      : show === 'awaited'
        ? !r.receivedOn
        : show === 'received'
          ? !!r.receivedOn
          : true,
  );
  const t = list.data?.totals;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Document list"
        subtitle={project.data ? `${project.data.number} · ${project.data.name}` : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Show"
              value={show}
              onChange={(e) => setShow(e.target.value as typeof show)}
            >
              <option value="all">All</option>
              <option value="awaited">Still to come</option>
              <option value="late">Late</option>
              <option value="received">Received</option>
            </Select>
            {list.data?.mayWrite && !adding ? (
              <Button onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden /> Expect documents
              </Button>
            ) : null}
          </div>
        }
      />
      {t ? (
        <p className="text-sm text-fg-muted" aria-label="Totals">
          {t.expected} expected · {t.received} received · {t.late} late
          {t.receivedLate ? ` · ${t.receivedLate} came late` : ''}
        </p>
      ) : null}
      {adding ? <AddExpected projectId={projectId} onClose={() => setAdding(false)} /> : null}
      {receiving ? (
        <Receive projectId={projectId} row={receiving} onClose={() => setReceiving(null)} />
      ) : null}
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing to show.</p>
        ) : (
          <Table minWidth="56rem">
            <thead>
              <tr>
                <th>Code</th>
                <th>Document</th>
                <th>From</th>
                <th>Planned</th>
                <th>Received</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="Expected documents">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.code}</td>
                  <td>
                    {r.title}
                    <div className="text-xs text-fg-muted">
                      {CATEGORIES[r.category]}
                      {r.document ? ` · File: ${r.document}` : ''}
                      {r.note ? ` · ${r.note}` : ''}
                    </div>
                  </td>
                  <td>{r.fromParty}</td>
                  <td>{shortDate(r.plannedOn)}</td>
                  <td className="text-sm">
                    {r.receivedOn ? (
                      <>
                        {shortDate(r.receivedOn)}
                        {r.daysLate > 0 ? (
                          <span className="ml-1 text-xs text-fg-muted">
                            ({r.daysLate} days late)
                          </span>
                        ) : null}
                      </>
                    ) : r.late ? (
                      <Badge tone="danger">late by {r.daysLate} days</Badge>
                    ) : (
                      <Badge tone="warning">awaited</Badge>
                    )}
                  </td>
                  <td className="text-right">
                    {list.data.mayWrite && !r.receivedOn ? (
                      <Button variant="ghost" onClick={() => setReceiving(r)}>
                        Received
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

/** One document, or many pasted as lines: code, title, from, planned date (tab- or comma-separated). */
function AddExpected({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    code: '',
    title: '',
    category: 'drawing' as Category,
    fromParty: '',
    plannedOn: today(),
  });
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const save = (items: (typeof f)[]) => {
    setError(null);
    void api
      .request(`/api/tenant/projects/${projectId}/expected-documents`, {
        method: 'POST',
        body: { items },
      })
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['expected-documents', projectId] });
        onClose();
      })
      .catch((err: unknown) => setError(describeError(err)));
  };
  const pasted = () =>
    paste
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [code = '', title = '', fromParty = '', plannedOn = ''] = l
          .split(l.includes('\t') ? '\t' : ',')
          .map((x) => x.trim());
        return { code, title, category: f.category, fromParty, plannedOn };
      });
  return (
    <Card title="Expect documents">
      <form
        aria-label="Expected document"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save(paste.trim() ? pasted() : [f]);
        }}
      >
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Code">
            <Input value={f.code} onChange={set('code')} required={!paste.trim()} />
          </Field>
          <Field label="Title">
            <Input value={f.title} onChange={set('title')} required={!paste.trim()} />
          </Field>
          <Field label="Kind">
            <Select value={f.category} onChange={set('category')}>
              {Object.entries(CATEGORIES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due by">
            <Input type="date" value={f.plannedOn} onChange={set('plannedOn')} />
          </Field>
        </div>
        <Field label="From">
          <Input value={f.fromParty} onChange={set('fromParty')} />
        </Field>
        <Field label="Or paste many (code, title, from, due date — one a line)">
          <Textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit">Add to the list</Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}

function Receive({
  projectId,
  row,
  onClose,
}: {
  projectId: string;
  row: Row;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const vault = useQuery({
    queryKey: ['dms', projectId, 'vault'],
    queryFn: () => api.request<DocVault>(`/api/tenant/projects/${projectId}/documents`),
  });
  const [f, setF] = useState({ receivedOn: today(), documentId: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title={`${row.code} received`}>
      <form
        aria-label="Received"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api
            .request(`/api/tenant/expected-documents/${row.id}/received`, {
              method: 'POST',
              body: { ...f, documentId: f.documentId || null },
            })
            .then(() => {
              void qc.invalidateQueries({ queryKey: ['expected-documents', projectId] });
              onClose();
            })
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Received on">
            <Input
              type="date"
              value={f.receivedOn}
              onChange={(e) => setF({ ...f, receivedOn: e.target.value })}
              required
            />
          </Field>
          <Field label="The file">
            <Select
              value={f.documentId}
              onChange={(e) => setF({ ...f, documentId: e.target.value })}
            >
              <option value="">Not in the documents</option>
              {(vault.data?.documents ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Note">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit">Mark received</Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}
