// The company's approval rules (docs/wave2b-plan.md step 1), set by the admin: for each kind of document, the levels
// it goes through, each from an amount upwards. With no levels a document is approved when it is submitted. Requests
// already submitted keep the rules they were submitted under.
import { Alert, Button, Card, Field, Input, PageHeader, Select, Spinner } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { Person } from '../api/types';
import { useRun, type Approver } from '../approvals/model';
import { describeError, formatInr } from '../lib/format';

interface Rule {
  level: number;
  minAmount: string;
  approver: Approver;
  userId: string | null;
  userName: string | null;
  designationId: string | null;
  designationName: string | null;
  label: string;
}
interface RuleSet {
  types: { docType: string; label: string; projectScoped: boolean; rules: Rule[] }[];
}

const APPROVERS: { value: Approver; label: string; project?: boolean }[] = [
  { value: 'project_lead', label: "The project's lead", project: true },
  { value: 'manager', label: 'Any manager (or admin)' },
  { value: 'admin', label: 'Any admin' },
  { value: 'user', label: 'A named person' },
  { value: 'designation', label: 'Whoever holds a designation' },
  { value: 'reporting_manager', label: "The submitter's reporting manager" },
];
interface Designation {
  id: string;
  name: string;
}

export function ApprovalRulesScreen() {
  const rules = useQuery({
    queryKey: ['approval-rules'],
    queryFn: () => api.request<RuleSet>('/api/tenant/approval-rules'),
  });
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api.request<Person[]>('/api/tenant/people'),
  });
  const designations = useQuery({
    queryKey: ['designations'],
    queryFn: () => api.request<Designation[]>('/api/tenant/hr/designations'),
  });
  if (rules.isPending) return <Spinner />;
  if (rules.isError) return <Alert tone="danger">{describeError(rules.error)}</Alert>;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Approval rules"
        subtitle="Who approves what, by amount. Nobody approves their own request, nor two levels of the same one."
      />
      {rules.data.types.map((t) => (
        <TypeRules
          key={`${t.docType}-${t.rules.map((r) => `${r.level}${r.minAmount}${r.approver}${r.userId}${r.designationId}`).join()}`}
          type={t}
          people={people.data ?? []}
          designations={designations.data ?? []}
        />
      ))}
    </div>
  );
}

function TypeRules({
  type,
  people,
  designations,
}: {
  type: RuleSet['types'][number];
  people: Person[];
  designations: Designation[];
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState(
    type.rules.map((r) => ({
      minAmount: r.minAmount.replace(/\.00$/, ''),
      approver: r.approver,
      userId: r.userId ?? '',
      designationId: r.designationId ?? '',
      label: r.label,
    })),
  );
  const { run, busy, error } = useRun(
    () => void qc.invalidateQueries({ queryKey: ['approval-rules'] }),
  );
  const set = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <Card title={`${type.label}s`}>
      {rows.length === 0 && (
        <p className="mb-3 text-sm text-fg-muted">
          No levels: a {type.label.toLowerCase()} is approved as soon as it is submitted.
        </p>
      )}
      <form
        className="space-y-3"
        aria-label={`Rules for ${type.label.toLowerCase()}s`}
        onSubmit={(e) => {
          e.preventDefault();
          void run('save', () =>
            api.request(`/api/tenant/approval-rules/${type.docType}`, {
              method: 'POST',
              body: {
                rules: rows.map((r) => ({
                  minAmount: r.minAmount || '0',
                  approver: r.approver,
                  userId: r.approver === 'user' ? r.userId || null : null,
                  designationId: r.approver === 'designation' ? r.designationId || null : null,
                  label: r.label,
                })),
              },
            }),
          );
        }}
      >
        {rows.map((r, i) => (
          <div
            key={i}
            className="flex flex-wrap items-end gap-3"
            aria-label={`Level ${i + 1}`}
            role="group"
          >
            <span className="pb-2 text-sm font-medium">Level {i + 1}</span>
            <Field label="From ₹">
              <Input
                inputMode="decimal"
                value={r.minAmount}
                className="w-32"
                onChange={(e) => set(i, { minAmount: e.target.value })}
              />
            </Field>
            <div className="w-56">
              <Field label="Approved by">
                <Select
                  value={r.approver}
                  onChange={(e) => set(i, { approver: e.target.value as Approver })}
                >
                  {APPROVERS.filter((a) => type.projectScoped || !a.project).map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {r.approver === 'user' && (
              <div className="w-48">
                <Field label="Person">
                  <Select
                    value={r.userId}
                    onChange={(e) => set(i, { userId: e.target.value })}
                    required
                  >
                    <option value="">Choose…</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            {r.approver === 'designation' && (
              <div className="w-48">
                <Field label="Designation">
                  <Select
                    value={r.designationId}
                    onChange={(e) => set(i, { designationId: e.target.value })}
                    required
                  >
                    <option value="">Choose…</option>
                    {designations.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <Field label="Name of the level">
              <Input
                value={r.label}
                maxLength={100}
                placeholder="e.g. Purchase head"
                onChange={(e) => set(i, { label: e.target.value })}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              aria-label={`Remove level ${i + 1}`}
              onClick={() => setRows(rows.filter((_, k) => k !== i))}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {rows.length < 6 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setRows([
                  ...rows,
                  {
                    minAmount: rows.length ? rows[rows.length - 1]!.minAmount : '0',
                    approver: type.projectScoped && !rows.length ? 'project_lead' : 'manager',
                    userId: '',
                    designationId: '',
                    label: '',
                  },
                ])
              }
            >
              <Plus className="size-4" aria-hidden /> Level
            </Button>
          )}
          <Button type="submit" busy={busy === 'save'}>
            Save rules
          </Button>
        </div>
        {rows.length > 0 && (
          <p className="text-xs text-fg-muted" data-testid={`rules-summary-${type.docType}`}>
            {rows
              .map(
                (r, i) =>
                  `Level ${i + 1} from ${formatInr(r.minAmount || '0')}: ${
                    r.approver === 'user'
                      ? (people.find((p) => p.id === r.userId)?.displayName ?? 'a named person')
                      : r.approver === 'designation'
                        ? `any ${designations.find((d) => d.id === r.designationId)?.name ?? 'holder of a designation'}`
                        : APPROVERS.find((a) => a.value === r.approver)!.label.toLowerCase()
                  }`,
              )
              .join('; ')}
            .
          </p>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Card>
  );
}
