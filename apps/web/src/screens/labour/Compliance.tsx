// Contract labour compliance as principal employer (docs/wave8-plan.md step 8c.1): each month's PF and ESI on the
// contractor's wage sheets against the challans they showed, and what holds their bills.
import { Alert, Badge, Button, Card, Field, Input, Select, Table, toast } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';

interface Compliance {
  dues: { month: string; kind: 'pf' | 'esi'; due: string; paid: string }[];
  challans: {
    id: string;
    month: string;
    kind: string;
    reference: string;
    amount: string;
    paidOn: string;
  }[];
  holds: string[];
}

export function ComplianceCard({ partyId }: { partyId: string }) {
  const qc = useQueryClient();
  const on = today();
  const key = ['labour-compliance', partyId, on];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Compliance>(`/api/tenant/labour/contractors/${partyId}/compliance?on=${on}`),
  });
  const [form, setForm] = useState({
    month: '',
    kind: 'pf',
    reference: '',
    amount: '',
    paidOn: on,
  });
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request(`/api/tenant/labour/contractors/${partyId}/challans`, {
        method: 'POST',
        body: form,
      });
      toast.success(`${form.kind.toUpperCase()} challan ${form.reference} recorded`);
      setForm({ ...form, reference: '', amount: '' });
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (!q.data) return null;
  const c = q.data;
  return (
    <Card title="PF and ESI as principal employer">
      {c.holds.length ? (
        <Alert tone="warning">Their bills are held: {c.holds.join(' ')}</Alert>
      ) : (
        <p className="text-sm text-fg-muted">Nothing holds this contractor's bills.</p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {c.dues.length ? (
        <Table minWidth="30rem">
          <thead>
            <tr>
              <th>Month</th>
              <th>Due</th>
              <th className="text-right">On the wage sheets</th>
              <th className="text-right">Challans</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="PF and ESI">
            {c.dues.map((d) => (
              <tr key={`${d.month}-${d.kind}`}>
                <td>{d.month}</td>
                <td>{d.kind.toUpperCase()}</td>
                <td className="text-right tabular-nums">{rupees(d.due)}</td>
                <td className="text-right tabular-nums">{rupees(d.paid)}</td>
                <td>
                  <Badge tone={Number(d.paid) + 0.5 >= Number(d.due) ? 'success' : 'danger'}>
                    {Number(d.paid) + 0.5 >= Number(d.due) ? 'Paid' : 'Short'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
      <form
        onSubmit={(e) => void add(e)}
        className="mt-3 grid gap-3 md:grid-cols-6"
        aria-label="Contractor's challan"
      >
        <Field label="Month">
          <Input
            type="month"
            value={form.month}
            onChange={(e) => setForm({ ...form, month: e.target.value })}
            required
          />
        </Field>
        <Field label="Kind">
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="pf">PF</option>
            <option value="esi">ESI</option>
          </Select>
        </Field>
        <Field label="TRRN or challan no.">
          <Input
            value={form.reference}
            onChange={(e) => setForm({ ...form, reference: e.target.value })}
            required
          />
        </Field>
        <Field label="Amount ₹">
          <Input
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            inputMode="decimal"
            required
          />
        </Field>
        <Field label="Paid on">
          <Input
            type="date"
            value={form.paidOn}
            onChange={(e) => setForm({ ...form, paidOn: e.target.value })}
            required
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Record the challan</Button>
        </div>
      </form>
    </Card>
  );
}
