// Rate contracts (docs/wave7-plan.md step 7c.5): rates agreed with suppliers for resources over a period, perhaps up to
// a quantity; orders from requisitions to the supplier take them; each line shows what has been ordered against it.
import {
  Alert,
  Badge,
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
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { Party, Resource } from '../api/types';
import { describeError, formatInr } from '../lib/format';
import { shortDate } from '../schedule/model';

interface Contract {
  id: string;
  reference: string;
  validFrom: string;
  validTo: string;
  status: 'active' | 'closed';
  party: { id: string; name: string };
  lines: {
    resourceId: string;
    code: string;
    name: string;
    unit: string;
    rate: string;
    gstPct: string;
    maxQty: string | null;
    ordered: string;
  }[];
}
interface List {
  contracts: Contract[];
  mayEdit: boolean;
}
const q = (v: string) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export function RateContractsScreen() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['rate-contracts'],
    queryFn: () => api.request<List>('/api/tenant/rate-contracts'),
  });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const close = async (c: Contract) => {
    if (
      !(await confirm({
        title: `Close the rate contract with ${c.party.name}?`,
        body: 'New orders stop taking its rates. Orders already placed keep them.',
        confirmLabel: 'Close the contract',
        tone: 'danger',
      }))
    )
      return;
    setError(null);
    try {
      qc.setQueryData(
        ['rate-contracts'],
        await api.request<List>(`/api/tenant/rate-contracts/${c.id}/close`, {
          method: 'POST',
          body: {},
        }),
      );
      toast.success(`Rate contract with ${c.party.name} closed`);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Rate contracts"
        subtitle="Rates agreed with suppliers for a period. Orders from requisitions to the supplier take them."
        actions={
          list.data?.mayEdit && !adding ? (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> New rate contract
            </Button>
          ) : null
        }
      />
      {adding ? <NewContract onClose={() => setAdding(false)} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{describeError(list.error)}</Alert>
      ) : list.data.contracts.length === 0 ? (
        <Card>
          <EmptyState title="No rate contract yet.">
            Agree rates with a supplier for a period; orders to the supplier then take them.
          </EmptyState>
        </Card>
      ) : (
        list.data.contracts.map((c) => (
          <Card
            key={c.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {c.party.name}
                {c.reference ? <span className="font-mono text-xs">{c.reference}</span> : null}
                <Badge tone={c.status === 'active' ? 'success' : 'neutral'}>{c.status}</Badge>
              </span>
            }
            actions={
              list.data.mayEdit && c.status === 'active' ? (
                <Button variant="ghost" onClick={() => void close(c)}>
                  Close
                </Button>
              ) : null
            }
          >
            <p className="mb-2 text-sm text-fg-muted">
              {shortDate(c.validFrom)} to {shortDate(c.validTo)}
            </p>
            <Table minWidth="40rem">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">GST</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Up to</th>
                </tr>
              </thead>
              <tbody aria-label={`Rates from ${c.party.name}`}>
                {c.lines.map((l) => (
                  <tr key={l.resourceId}>
                    <td>
                      <span className="font-mono text-xs">{l.code}</span> {l.name}
                    </td>
                    <td className="text-right">
                      {formatInr(l.rate)} / {l.unit}
                    </td>
                    <td className="text-right">{Number(l.gstPct)}%</td>
                    <td
                      className={`text-right ${l.maxQty && Number(l.ordered) > Number(l.maxQty) ? 'font-medium text-danger' : ''}`}
                    >
                      {q(l.ordered)}
                    </td>
                    <td className="text-right">{l.maxQty ? q(l.maxQty) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ))
      )}
    </div>
  );
}

function NewContract({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const vendors = useQuery({
    queryKey: ['parties', 'vendor'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=vendor'),
  });
  const resources = useQuery({
    queryKey: ['resources', 'materials'],
    queryFn: () =>
      api.request<{ items: Resource[] }>('/api/tenant/resources?kind=material&limit=200'),
    select: (r) => r.items,
  });
  const year = new Date().getFullYear();
  const [head, setHead] = useState({
    partyId: '',
    reference: '',
    validFrom: `${year}-04-01`,
    validTo: `${year + 1}-03-31`,
  });
  const [lines, setLines] = useState([{ resourceId: '', rate: '', gstPct: '18', maxQty: '' }]);
  const [error, setError] = useState<string | null>(null);
  const setLine = (i: number, k: string, v: string) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Card title="New rate contract">
      <form
        aria-label="New rate contract"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api
            .request<List>('/api/tenant/rate-contracts', {
              method: 'POST',
              body: {
                ...head,
                lines: lines
                  .filter((l) => l.resourceId && l.rate)
                  .map((l) => ({ ...l, maxQty: l.maxQty || null })),
              },
            })
            .then((out) => {
              qc.setQueryData(['rate-contracts'], out);
              toast.success('Rate contract saved');
              onClose();
            })
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Supplier">
            <Select
              value={head.partyId}
              onChange={(e) => setHead({ ...head, partyId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {(vendors.data ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reference">
            <Input
              value={head.reference}
              onChange={(e) => setHead({ ...head, reference: e.target.value })}
            />
          </Field>
          <Field label="From">
            <Input
              type="date"
              value={head.validFrom}
              onChange={(e) => setHead({ ...head, validFrom: e.target.value })}
              required
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={head.validTo}
              onChange={(e) => setHead({ ...head, validTo: e.target.value })}
              required
            />
          </Field>
        </div>
        {lines.map((l, i) => (
          <fieldset
            key={i}
            aria-label={`Rate ${i + 1}`}
            className="grid gap-3 md:grid-cols-[2fr_1fr_6rem_1fr]"
          >
            <Field label="Material">
              <Select
                value={l.resourceId}
                onChange={(e) => setLine(i, 'resourceId', e.target.value)}
              >
                <option value="">Choose…</option>
                {(resources.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} {r.name} ({r.unit})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Rate ₹ (before GST)">
              <Input
                inputMode="decimal"
                value={l.rate}
                onChange={(e) => setLine(i, 'rate', e.target.value)}
              />
            </Field>
            <Field label="GST %">
              <Select value={l.gstPct} onChange={(e) => setLine(i, 'gstPct', e.target.value)}>
                {['0', '5', '12', '18', '28'].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </Select>
            </Field>
            <Field label="Up to (quantity)">
              <Input
                inputMode="decimal"
                value={l.maxQty}
                onChange={(e) => setLine(i, 'maxQty', e.target.value)}
              />
            </Field>
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              setLines([...lines, { resourceId: '', rate: '', gstPct: '18', maxQty: '' }])
            }
          >
            Another material
          </Button>
          <Button type="submit">Save the contract</Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}
