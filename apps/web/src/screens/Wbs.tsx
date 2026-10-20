// A project's WBS and cost breakdown (docs/wave2a-plan.md step 3): the WBS tree with the contract and budget under
// each element, made from a BOQ's sections or by hand; the same by company cost code; and what is still unmapped.
// BOQ lines are mapped in the BOQ itself (select lines, then Map).
import {
  Alert,
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
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { ProjectBoq, ProjectBreakdown, ProjectDetail, WbsNode } from '../api/types';
import { describeError, formatInr } from '../lib/format';
import { COST_KIND_LABEL } from './CostCodes';
import { numberLocale } from '../lib/locale';

const post = <T,>(url: string, body: object = {}) =>
  api.request<T>(`/api/tenant/${url}`, { method: 'POST', body });
const nbsp = (depth: number) => '  '.repeat(depth);
const tone = (m: string) => (Number(m) < 0 ? 'text-danger' : '');

export function WbsScreen({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const confirm = useConfirm();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const data = useQuery({
    queryKey: ['project-breakdown', projectId],
    queryFn: () => api.request<ProjectBreakdown>(`/api/tenant/projects/${projectId}/breakdown`),
  });
  const boqs = useQuery({
    queryKey: ['project-boqs', projectId],
    queryFn: () => api.request<ProjectBoq[]>(`/api/tenant/projects/${projectId}/boqs`),
  });
  const run = async (f: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await f();
      if (done) toast.success(done);
      void qc.invalidateQueries({ queryKey: ['project-breakdown', projectId] });
      void qc.invalidateQueries({ queryKey: ['project-wbs', projectId] });
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  if (project.isPending || data.isPending) return <Spinner />;
  if (project.isError) return <Alert tone="danger">{describeError(project.error)}</Alert>;
  if (data.isError) return <Alert tone="danger">{describeError(data.error)}</Alert>;
  const p = project.data;
  const d = data.data;
  const canEdit = p.canEdit;
  const live = (boqs.data ?? []).filter((b) => !b.archivedAt);
  const contractItems = d.totals.contract.lines;
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {p.number} · {p.name}
      </Link>
      <PageHeader
        title="WBS and cost codes"
        subtitle="The contract and the budget broken down by WBS element and by cost code."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {contractItems > 0 && (
        <p className="text-sm text-fg-muted" data-testid="coverage">
          Of {contractItems.toLocaleString(numberLocale())} contract items,{' '}
          {d.unmapped.wbs.contract.lines.toLocaleString(numberLocale())} have no WBS element and{' '}
          {d.unmapped.costCode.contract.lines.toLocaleString(numberLocale())} no cost code. Map them
          in the BOQ: select lines (Shift+click), then <strong>Map</strong>.
        </p>
      )}
      {d.wbs.length === 0 && canEdit && live.length > 0 && (
        <FromBoq
          boqs={live}
          onMake={(boqId, depth) =>
            run(
              () => post(`projects/${projectId}/wbs/from-boq`, { boqId, depth }),
              'WBS made from the BOQ',
            )
          }
        />
      )}
      <Card title={`WBS (${d.wbs.length})`}>
        {d.wbs.length === 0 ? (
          <EmptyState title="No WBS yet.">
            {canEdit
              ? 'Make it from the contract BOQ above, or add elements by hand below.'
              : undefined}
          </EmptyState>
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Element</th>
                <th className="text-right">Contract</th>
                <th className="text-right">Budget</th>
                <th className="text-right">Margin</th>
                <th className="text-right">Items</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody aria-label="WBS">
              {d.wbs.map((n) =>
                editing === n.id ? (
                  <tr key={n.id}>
                    <td colSpan={6}>
                      <WbsForm
                        nodes={d.wbs}
                        node={n}
                        onCancel={() => setEditing(null)}
                        onSubmit={async (v) => {
                          if (
                            await run(
                              () => post(`wbs/${n.id}`, { ...v, rowVersion: n.rowVersion }),
                              `${n.code} saved`,
                            )
                          )
                            setEditing(null);
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={n.id}>
                    <td>
                      <span style={{ paddingLeft: `${n.depth * 1.25}rem` }}>
                        <span className="mr-2 font-mono text-xs">{n.code}</span>
                        {n.name}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{formatInr(n.contract)}</td>
                    <td className="text-right tabular-nums">{formatInr(n.budget)}</td>
                    <td className={`text-right tabular-nums ${tone(n.margin)}`}>
                      {formatInr(n.margin)}
                    </td>
                    <td className="text-right tabular-nums">
                      {n.contractLines.toLocaleString(numberLocale())}
                    </td>
                    {canEdit && (
                      <td className="whitespace-nowrap text-right">
                        <Button
                          variant="ghost"
                          aria-label={`Move ${n.code} up`}
                          onClick={() =>
                            void run(() => post(`wbs/${n.id}/move`, { direction: 'up' }))
                          }
                        >
                          <ArrowUp className="size-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`Move ${n.code} down`}
                          onClick={() =>
                            void run(() => post(`wbs/${n.id}/move`, { direction: 'down' }))
                          }
                        >
                          <ArrowDown className="size-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`Edit ${n.code}`}
                          onClick={() => setEditing(n.id)}
                        >
                          <Pencil className="size-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`Remove ${n.code}`}
                          onClick={async () => {
                            if (
                              !(await confirm({
                                title: `Remove WBS element ${n.code} ${n.name}?`,
                                body: 'It is deleted from the project’s WBS. Only an element with nothing under it can go.',
                                confirmLabel: 'Remove the element',
                                tone: 'danger',
                              }))
                            )
                              return;
                            await run(() => post(`wbs/${n.id}/delete`), `${n.code} removed`);
                          }}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </td>
                    )}
                  </tr>
                ),
              )}
              {d.unmapped.wbs.contract.lines + d.unmapped.wbs.budget.lines > 0 && (
                <Unmapped u={d.unmapped.wbs} cols={canEdit ? 6 : 5} />
              )}
            </tbody>
          </Table>
        )}
        {canEdit && (
          <div className="mt-4 border-t border-line pt-4">
            <WbsForm
              nodes={d.wbs}
              onSubmit={async (v) =>
                void (await run(() => post(`projects/${projectId}/wbs`, v), `${v.code} added`))
              }
            />
          </div>
        )}
      </Card>
      <Card title="By cost code">
        {d.costCodes.length === 0 ? (
          <p className="text-sm text-fg-muted">
            The company has no cost codes yet.{' '}
            <Link to="/cost-codes" className="text-accent hover:underline">
              Set them up
            </Link>
            .
          </p>
        ) : (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Cost code</th>
                <th>Kind</th>
                <th className="text-right">Contract</th>
                <th className="text-right">Budget</th>
                <th className="text-right">Margin</th>
              </tr>
            </thead>
            <tbody aria-label="Cost breakdown">
              {d.costCodes.map((c) => (
                <tr
                  key={c.id}
                  className={c.contractLines === 0 && c.budget === '0.00' ? 'text-fg-subtle' : ''}
                >
                  <td>
                    <span style={{ paddingLeft: `${c.depth * 1.25}rem` }}>
                      <span className="mr-2 font-mono text-xs">{c.code}</span>
                      {c.name}
                    </span>
                  </td>
                  <td className="whitespace-nowrap">{COST_KIND_LABEL[c.kind]}</td>
                  <td className="text-right tabular-nums">{formatInr(c.contract)}</td>
                  <td className="text-right tabular-nums">{formatInr(c.budget)}</td>
                  <td className={`text-right tabular-nums ${tone(c.margin)}`}>
                    {formatInr(c.margin)}
                  </td>
                </tr>
              ))}
              {d.unmapped.costCode.contract.lines + d.unmapped.costCode.budget.lines > 0 && (
                <Unmapped u={d.unmapped.costCode} cols={5} kindColumn />
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Unmapped({
  u,
  cols,
  kindColumn,
}: {
  u: ProjectBreakdown['unmapped']['wbs'];
  cols: number;
  kindColumn?: boolean;
}) {
  const margin = Number(u.contract.amount) - Number(u.budget.amount);
  return (
    <tr className="italic text-fg-muted">
      <td>Not mapped</td>
      {kindColumn && <td />}
      <td className="text-right tabular-nums">{formatInr(u.contract.amount)}</td>
      <td className="text-right tabular-nums">{formatInr(u.budget.amount)}</td>
      <td className="text-right tabular-nums">{formatInr(margin.toFixed(2))}</td>
      {!kindColumn && (
        <td className="text-right tabular-nums">
          {u.contract.lines.toLocaleString(numberLocale())}
        </td>
      )}
      {!kindColumn && cols > 5 && <td />}
    </tr>
  );
}

function FromBoq({
  boqs,
  onMake,
}: {
  boqs: ProjectBoq[];
  onMake: (boqId: string, depth: number) => Promise<boolean>;
}) {
  const [boqId, setBoqId] = useState(
    boqs.find((b) => b.kind === 'contract')?.id ?? boqs[0]?.id ?? '',
  );
  const [depth, setDepth] = useState(2);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Make the WBS from a BOQ">
      <p className="mb-3 text-sm text-fg-muted">
        Each section becomes a WBS element (numbered 1, 1.1, 1.2…), down to the levels you choose,
        and every item is mapped to the element of its section. Change the WBS by hand afterwards.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="BOQ">
          <Select value={boqId} onChange={(e) => setBoqId(e.target.value)}>
            {boqs.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Section levels">
          <Select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            await onMake(boqId, depth);
            setBusy(false);
          }}
        >
          Make the WBS
        </Button>
      </div>
    </Card>
  );
}

function WbsForm({
  nodes,
  node,
  onSubmit,
  onCancel,
}: {
  nodes: WbsNode[];
  node?: WbsNode;
  onSubmit: (v: { parentId: string | null; code: string; name: string }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState({
    parentId: node?.parentId ?? '',
    code: node?.code ?? '',
    name: node?.name ?? '',
  });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onSubmit({ ...v, parentId: v.parentId || null });
    setBusy(false);
    if (!node) setV({ ...v, code: '', name: '' });
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
      <Field label="Under">
        <Select value={v.parentId} onChange={(e) => setV({ ...v, parentId: e.target.value })}>
          <option value="">(top level)</option>
          {nodes
            .filter((n) => n.id !== node?.id)
            .map((n) => (
              <option key={n.id} value={n.id}>
                {nbsp(n.depth)}
                {n.code} · {n.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="WBS code">
        <Input
          value={v.code}
          onChange={(e) => setV({ ...v, code: e.target.value })}
          required
          maxLength={40}
          className="w-28"
        />
      </Field>
      <Field label="WBS name">
        <Input
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
          required
          maxLength={300}
        />
      </Field>
      <Button type="submit" busy={busy}>
        {node ? 'Save' : 'Add element'}
      </Button>
      {onCancel && (
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </form>
  );
}
