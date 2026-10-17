// Index series for price escalation (docs/wave8-plan.md step 8d.1): each series' monthly values as published, from
// which a bill's escalation takes the average over its period.
import {
  Alert,
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
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { usePermission } from '../../session/permissions';

interface Series {
  key: string;
  name: string;
  source: string;
  values: { month: string; value: string }[];
}

export function PriceIndicesScreen() {
  const qc = useQueryClient();
  const mayPost = usePermission('accounts.post');
  const q = useQuery({
    queryKey: ['price-indices'],
    queryFn: () => api.request<Series[]>('/api/tenant/accounts/price-indices'),
  });
  const lastMonth = (() => {
    const d = new Date(`${today().slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();
  const [v, setV] = useState({ key: '', month: lastMonth, value: '' });
  const [n, setN] = useState({ key: '', name: '', source: '' });
  const [error, setError] = useState<string | null>(null);
  const run = async (path: string, body: object) => {
    setError(null);
    try {
      qc.setQueryData(
        ['price-indices'],
        await api.request<Series[]>(path, { method: 'POST', body }),
      );
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const addValue = async (e: FormEvent) => {
    e.preventDefault();
    const key = v.key || q.data?.[0]?.key;
    if (!key) return;
    if (
      await run(`/api/tenant/accounts/price-indices/${key}/values`, {
        values: [{ month: v.month, value: v.value }],
      })
    )
      setV({ ...v, value: '' });
  };
  const addSeries = async (e: FormEvent) => {
    e.preventDefault();
    if (await run('/api/tenant/accounts/price-indices', n)) setN({ key: '', name: '', source: '' });
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Price indices"
        subtitle="Monthly index values for price escalation; a bill takes their average over its period."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {mayPost && (
        <Card title="Enter a month's value">
          <form
            onSubmit={(e) => void addValue(e)}
            className="grid gap-3 md:grid-cols-4"
            aria-label="Index value"
          >
            <Field label="Series">
              <Select
                value={v.key || q.data?.[0]?.key || ''}
                onChange={(e) => setV({ ...v, key: e.target.value })}
              >
                {(q.data ?? []).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Month">
              <Input
                type="month"
                value={v.month}
                onChange={(e) => setV({ ...v, month: e.target.value })}
              />
            </Field>
            <Field label="Index">
              <Input
                inputMode="decimal"
                value={v.value}
                onChange={(e) => setV({ ...v, value: e.target.value })}
                required
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Card>
      )}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <Card title="Series">
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Series</th>
                <th>Latest values</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody aria-label="Index series">
              {q.data.map((s) => (
                <tr key={s.key}>
                  <td>
                    {s.name} <span className="text-xs text-fg-muted">{s.key}</span>
                  </td>
                  <td className="text-sm">
                    {s.values.length
                      ? s.values
                          .slice(0, 4)
                          .map((x) => `${x.month}: ${Number(x.value)}`)
                          .join(' · ')
                      : '—'}
                  </td>
                  <td className="text-xs text-fg-muted">{s.source}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {mayPost && (
            <form
              onSubmit={(e) => void addSeries(e)}
              className="mt-4 grid gap-3 md:grid-cols-4"
              aria-label="New series"
            >
              <Field label="Key">
                <Input
                  value={n.key}
                  onChange={(e) => setN({ ...n, key: e.target.value })}
                  placeholder="wpi_sand"
                  required
                />
              </Field>
              <Field label="Name">
                <Input
                  value={n.name}
                  onChange={(e) => setN({ ...n, name: e.target.value })}
                  required
                />
              </Field>
              <Field label="Source">
                <Input value={n.source} onChange={(e) => setN({ ...n, source: e.target.value })} />
              </Field>
              <div className="flex items-end">
                <Button type="submit" variant="secondary">
                  Add a series
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
