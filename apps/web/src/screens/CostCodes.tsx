// The company's cost codes (docs/wave2a-plan.md step 3): groups and codes, each of a kind of cost. Projects map their
// BOQ lines to them. A standard list to start from; codes are retired, never deleted.
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
import { Pencil } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { CostCode, CostKind } from '../api/types';
import { describeError } from '../lib/format';
import { usePermission } from '../session/permissions';

export const COST_KIND_LABEL: Record<CostKind, string> = {
  material: 'Material',
  labour: 'Labour',
  equipment: 'Plant and equipment',
  subcontract: 'Subcontract',
  overhead: 'Overhead',
  other: 'Other',
};

const post = <T,>(url: string, body: object = {}) =>
  api.request<T>(`/api/tenant/${url}`, { method: 'POST', body });

export function CostCodesScreen() {
  const qc = useQueryClient();
  const canEdit = usePermission('costcodes.edit');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codes = useQuery({
    queryKey: ['cost-codes'],
    queryFn: () => api.request<CostCode[]>('/api/tenant/cost-codes'),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['cost-codes'] });
  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      refresh();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  if (codes.isPending) return <Spinner />;
  if (codes.isError) return <Alert tone="danger">{describeError(codes.error)}</Alert>;
  const list = codes.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Cost codes"
        subtitle="The company's codes for costs. Projects map their BOQ lines to them; purchases and accounts will book to them."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {list.length === 0 && canEdit && (
        <Card title="Start from the standard list">
          <p className="mb-3 text-sm text-fg-muted">
            Materials, labour, plant and equipment, subcontracts and site overheads, with the usual
            codes under each (23 in all). Edit, add or retire any of them afterwards.
          </p>
          <Button onClick={() => void run(() => post('cost-codes/standard'))}>
            Load the standard list
          </Button>
        </Card>
      )}
      <Card title={`Codes (${list.length})`}>
        {list.length === 0 ? (
          <p className="text-sm text-fg-muted">No cost codes yet.</p>
        ) : (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Kind</th>
                <th className="text-right">Lines</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="Cost codes">
              {list.map((c) =>
                editing === c.id ? (
                  <tr key={c.id}>
                    <td colSpan={5}>
                      <CostCodeForm
                        codes={list}
                        code={c}
                        onCancel={() => setEditing(null)}
                        onSubmit={async (v) => {
                          if (
                            await run(() =>
                              post(`cost-codes/${c.id}`, { ...v, rowVersion: c.rowVersion }),
                            )
                          )
                            setEditing(null);
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id} className={c.active ? '' : 'text-fg-subtle'}>
                    <td>
                      <span
                        className="font-mono text-xs"
                        style={{ paddingLeft: `${c.depth * 1.25}rem` }}
                      >
                        {c.code}
                      </span>
                    </td>
                    <td>
                      {c.name} {!c.active && <Badge tone="neutral">Retired</Badge>}
                    </td>
                    <td className="whitespace-nowrap">{COST_KIND_LABEL[c.kind]}</td>
                    <td className="text-right tabular-nums">{c.lines.toLocaleString('en-IN')}</td>
                    <td className="whitespace-nowrap text-right">
                      {canEdit && (
                        <>
                          <Button
                            variant="ghost"
                            aria-label={`Edit ${c.code}`}
                            onClick={() => setEditing(c.id)}
                          >
                            <Pencil className="size-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void run(() =>
                                post(`cost-codes/${c.id}`, {
                                  rowVersion: c.rowVersion,
                                  active: !c.active,
                                }),
                              )
                            }
                          >
                            {c.active ? 'Retire' : 'Restore'}
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </Table>
        )}
      </Card>
      {canEdit && (
        <Card title="Add a cost code">
          <CostCodeForm
            codes={list}
            onSubmit={async (v) => void (await run(() => post('cost-codes', v)))}
          />
        </Card>
      )}
    </div>
  );
}

function CostCodeForm({
  codes,
  code,
  onSubmit,
  onCancel,
}: {
  codes: CostCode[];
  code?: CostCode;
  onSubmit: (v: {
    parentId: string | null;
    code: string;
    name: string;
    kind: CostKind;
  }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState({
    parentId: code?.parentId ?? '',
    code: code?.code ?? '',
    name: code?.name ?? '',
    kind: code?.kind ?? ('material' as CostKind),
  });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onSubmit({ ...v, parentId: v.parentId || null });
    setBusy(false);
    if (!code) setV({ ...v, code: '', name: '' });
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
      <Field label="Under">
        <Select
          value={v.parentId}
          onChange={(e) => {
            const parent = codes.find((c) => c.id === e.target.value);
            setV({ ...v, parentId: e.target.value, kind: parent?.kind ?? v.kind });
          }}
        >
          <option value="">(top level)</option>
          {codes
            .filter((c) => c.active && c.id !== code?.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {'\u00a0\u00a0'.repeat(c.depth)}
                {c.code} · {c.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Code">
        <Input
          value={v.code}
          onChange={(e) => setV({ ...v, code: e.target.value })}
          required
          maxLength={40}
          className="w-32"
        />
      </Field>
      <Field label="Name">
        <Input
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
          required
          maxLength={200}
        />
      </Field>
      <Field label="Kind">
        <Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as CostKind })}>
          {(Object.keys(COST_KIND_LABEL) as CostKind[]).map((k) => (
            <option key={k} value={k}>
              {COST_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" busy={busy}>
        {code ? 'Save' : 'Add code'}
      </Button>
      {onCancel && (
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </form>
  );
}
