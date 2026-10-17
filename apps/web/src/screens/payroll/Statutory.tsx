// A run's statutory dues paid by challan (docs/wave8-plan.md step 8c.3): PF with its TRRN, ESI, professional tax and
// labour welfare fund, each posted from the bank; and the month's professional tax return.
import { Alert, Badge, Button, Card, Field, Input, Select, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';

interface Dues {
  heads: { kind: 'pf' | 'esi' | 'pt' | 'lwf'; due: string; paid: string; left: string }[];
  challans: {
    id: string;
    kind: string;
    reference: string;
    amount: string;
    paidOn: string;
    voucher: string;
  }[];
}
const LABEL = { pf: 'PF (TRRN)', esi: 'ESI', pt: 'Professional tax', lwf: 'Labour welfare fund' };

export function StatutoryDues({
  runId,
  banks,
}: {
  runId: string;
  banks: { id: string; code: string; name: string }[];
}) {
  const qc = useQueryClient();
  const key = ['pay-statutory', runId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Dues>(`/api/tenant/payroll/runs/${runId}/statutory`),
  });
  const pt = useQuery({
    queryKey: ['pay-pt-return', runId],
    queryFn: () =>
      api.request<{ slabs: { rate: string; employees: number; tax: string }[]; tax: string }>(
        `/api/tenant/payroll/runs/${runId}/pt-return`,
      ),
  });
  const [form, setForm] = useState<{
    kind: string;
    reference: string;
    amount: string;
    paidOn: string;
    bankAccountId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pay = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Dues>(`/api/tenant/payroll/runs/${runId}/statutory`, {
          method: 'POST',
          body: form,
        }),
      );
      setForm(null);
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (!q.data) return null;
  return (
    <Card title="Statutory dues">
      {error && <Alert tone="danger">{error}</Alert>}
      <Table minWidth="34rem">
        <thead>
          <tr>
            <th>Head</th>
            <th className="text-right">Due</th>
            <th className="text-right">Paid</th>
            <th />
          </tr>
        </thead>
        <tbody aria-label="Statutory dues">
          {q.data.heads
            .filter((h) => Number(h.due) > 0)
            .map((h) => (
              <tr key={h.kind}>
                <td>{LABEL[h.kind]}</td>
                <td className="text-right tabular-nums">{rupees(h.due)}</td>
                <td className="text-right tabular-nums">{rupees(h.paid)}</td>
                <td className="text-right">
                  {Number(h.left) > 0 ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        setForm({
                          kind: h.kind,
                          reference: '',
                          amount: h.left,
                          paidOn: today(),
                          bankAccountId: banks[0]?.id ?? '',
                        })
                      }
                    >
                      Enter the challan
                    </Button>
                  ) : (
                    <Badge tone="success">Paid</Badge>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </Table>
      {form && (
        <form
          onSubmit={(e) => void pay(e)}
          className="mt-3 grid gap-3 md:grid-cols-5"
          aria-label="Statutory challan"
        >
          <Field label={form.kind === 'pf' ? 'TRRN' : 'Challan no.'}>
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
          <Field label="From">
            <Select
              value={form.bankAccountId}
              onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}
            >
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Post</Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {q.data.challans.length ? (
        <ul className="mt-3 text-sm text-fg-muted">
          {q.data.challans.map((c) => (
            <li key={c.id}>
              {c.kind.toUpperCase()} {c.reference}: {rupees(c.amount)} on {c.paidOn} ({c.voucher})
            </li>
          ))}
        </ul>
      ) : null}
      {pt.data && pt.data.slabs.some((s) => Number(s.rate) > 0) ? (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-semibold">
            Professional tax return (Maharashtra, Form III)
          </h3>
          <Table minWidth="24rem">
            <thead>
              <tr>
                <th className="text-right">Tax a month</th>
                <th className="text-right">Employees</th>
                <th className="text-right">Tax</th>
              </tr>
            </thead>
            <tbody aria-label="PT return">
              {pt.data.slabs.map((s) => (
                <tr key={s.rate}>
                  <td className="text-right">{rupees(s.rate)}</td>
                  <td className="text-right">{s.employees}</td>
                  <td className="text-right">{rupees(s.tax)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
    </Card>
  );
}
