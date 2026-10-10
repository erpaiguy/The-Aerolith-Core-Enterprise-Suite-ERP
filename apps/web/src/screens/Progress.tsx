// A project's progress (docs/wave2a-plan.md step 6): the work done to a day and in a period, measured in the contract
// BOQ's measurement books: value at contract rates, physical progress within the BOQ quantities, the budget value
// of the same work; by contract BOQ and its sections, and by WBS element.
import { Alert, Card, Field, Input, PageHeader, Spinner, Table, cx } from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError, formatInr } from '../lib/format';
import { shortDate } from '../schedule/model';

export interface Done {
  value: string;
  done: string;
  period: string;
  budgetDone: string;
  pct: number | null;
  items: number;
  itemsStarted: number;
  itemsOver: number;
}

export interface ProgressReport {
  from: string;
  to: string;
  total: Done;
  boqs: (Done & {
    id: string;
    name: string;
    sections: (Done & { code: string | null; description: string })[];
  })[];
  wbs: (Done & { id: string; code: string; name: string; depth: number })[];
  unmapped: Done | null;
}

const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const pct = (n: number | null) => (n === null ? '-' : `${n.toLocaleString('en-IN')}%`);

export function ProgressScreen({ projectId }: { projectId: string }) {
  const [to, setTo] = useState(indiaToday());
  const [from, setFrom] = useState(`${indiaToday().slice(0, 8)}01`);
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const report = useQuery({
    queryKey: ['project-progress', projectId, from, to],
    queryFn: () =>
      api.request<ProgressReport>(
        `/api/tenant/projects/${projectId}/progress?from=${from}&to=${to}`,
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(from && to && from <= to),
  });
  if (project.isPending) return <Spinner />;
  if (project.isError) return <Alert tone="danger">{describeError(project.error)}</Alert>;
  const p = project.data;
  const r = report.data;
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
        title="Progress"
        subtitle="Work done as measured in the contract BOQ, at contract rates."
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Period from">
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {report.isError && <Alert tone="danger">{describeError(report.error)}</Alert>}
      {!r ? (
        <Spinner />
      ) : r.boqs.length === 0 ? (
        <Alert tone="info">The project has no contract BOQ to measure against yet.</Alert>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Progress totals">
            <Tile label="Physical progress" testId="physical">
              {pct(r.total.pct)}
            </Tile>
            <Tile label={`Value done to ${shortDate(r.to)}`} testId="value-done">
              {formatInr(r.total.done)}
              <span className="block text-xs font-normal text-fg-muted">
                of {formatInr(r.total.value)} contract
              </span>
            </Tile>
            <Tile label={`This period, ${shortDate(r.from)} – ${shortDate(r.to)}`} testId="period">
              {formatInr(r.total.period)}
            </Tile>
            <Tile label="Same work at budget rates" testId="budget-done">
              {formatInr(r.total.budgetDone)}
              <span className="block text-xs font-normal text-fg-muted">
                {r.total.itemsStarted} of {r.total.items} items started
                {r.total.itemsOver > 0 && `, ${r.total.itemsOver} beyond their BOQ quantity`}
              </span>
            </Tile>
          </div>
          {r.boqs.map((b) => (
            <Card key={b.id} title={b.name}>
              <DoneTable
                label={`Progress of ${b.name}`}
                first="Section"
                rows={b.sections.map((s, i) => ({
                  key: `${s.code ?? ''}-${i}`,
                  title: (
                    <>
                      {s.code && <span className="mr-2 font-mono text-xs">{s.code}</span>}
                      {s.description}
                    </>
                  ),
                  bold: false,
                  done: s,
                }))}
                total={b}
              />
            </Card>
          ))}
          {r.wbs.length > 0 && (
            <Card title="By WBS">
              <DoneTable
                label="Progress by WBS"
                first="WBS element"
                rows={[
                  ...r.wbs.map((w) => ({
                    key: w.id,
                    title: (
                      <span style={{ paddingLeft: `${w.depth * 1.25}rem` }}>
                        <span className="mr-2 font-mono text-xs">{w.code}</span>
                        {w.name}
                      </span>
                    ),
                    bold: w.depth === 0,
                    done: w,
                  })),
                  ...(r.unmapped
                    ? [
                        {
                          key: 'none',
                          title: <span className="italic text-fg-muted">No WBS element</span>,
                          bold: false,
                          done: r.unmapped,
                        },
                      ]
                    : []),
                ]}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums" data-testid={testId}>
        {children}
      </div>
    </div>
  );
}

function DoneTable({
  label,
  first,
  rows,
  total,
}: {
  label: string;
  first: string;
  rows: { key: string; title: ReactNode; bold: boolean; done: Done }[];
  total?: Done;
}) {
  return (
    <Table minWidth="46rem">
      <thead>
        <tr>
          <th>{first}</th>
          <th className="text-right">Contract</th>
          <th className="text-right">Done</th>
          <th className="w-[18%]">Physical</th>
          <th className="text-right">This period</th>
          <th className="text-right">Items</th>
        </tr>
      </thead>
      <tbody aria-label={label}>
        {[
          ...rows,
          ...(total ? [{ key: 'total', title: 'Total', bold: true, done: total }] : []),
        ].map(({ key, title, bold, done: d }) => (
          <tr key={key} className={cx(bold && 'font-semibold')}>
            <td>{title}</td>
            <td className="text-right tabular-nums">{formatInr(d.value)}</td>
            <td className="text-right tabular-nums">{formatInr(d.done)}</td>
            <td>
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 rounded-full bg-surface-3" aria-hidden>
                  <div
                    className="h-2 rounded-full bg-success"
                    style={{ width: `${Math.min(100, d.pct ?? 0)}%` }}
                  />
                </div>
                <span className="w-12 text-right text-xs tabular-nums">{pct(d.pct)}</span>
              </div>
            </td>
            <td className="text-right tabular-nums">{formatInr(d.period)}</td>
            <td className="whitespace-nowrap text-right tabular-nums">
              {d.itemsStarted}/{d.items}
              {d.itemsOver > 0 && (
                <span className="ml-1 text-xs text-warning" title="Beyond their BOQ quantity">
                  ({d.itemsOver} over)
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
