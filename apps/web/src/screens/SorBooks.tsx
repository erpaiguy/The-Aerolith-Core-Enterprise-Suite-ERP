// The company's schedules of rates (docs/wave8-plan.md step 8f.2): its own copies of CPWD DSR or a state PWD's SOR,
// imported from a spreadsheet (Code, Description, Unit, Rate; Chapter if any). None is shipped with the app.
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  Table,
  toast,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../api/client';
import { describeError, formatInr } from '../lib/format';
import { usePermission } from '../session/permissions';

interface Book {
  id: string;
  name: string;
  issuer: string;
  stateCode: string | null;
  edition: string;
  items: number;
}
interface Item {
  id: string;
  code: string;
  chapter: string;
  description: string;
  unit: string;
  rate: string;
  book: string;
}

export function SorBooksScreen() {
  const qc = useQueryClient();
  const mayEdit = usePermission('boq.edit');
  const books = useQuery({
    queryKey: ['sor-books'],
    queryFn: () => api.request<Book[]>('/api/tenant/sor-books'),
  });
  const [form, setForm] = useState({ name: '', issuer: 'CPWD', edition: '' });
  const [q, setQ] = useState('');
  const items = useQuery({
    queryKey: ['sor-items', q],
    queryFn: () => api.request<Item[]>(`/api/tenant/sor-items?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
  });
  const [msg, setMsg] = useState<{ tone: 'danger' | 'info'; text: string } | null>(null);
  const file = useRef<Record<string, HTMLInputElement | null>>({});
  const refresh = () => void qc.invalidateQueries({ queryKey: ['sor-books'] });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedules of rates"
        subtitle="Your copies of CPWD DSR or a state SOR, for estimates priced from the schedule and percentage-rate tenders."
      />
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card title="Schedules">
        {books.isPending ? (
          <Spinner />
        ) : (books.data ?? []).length === 0 ? (
          <EmptyState title="None yet.">
            {mayEdit ? 'Add one below, then import its spreadsheet.' : undefined}
          </EmptyState>
        ) : (
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Issued by</th>
                <th className="text-right">Items</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="Schedules">
              {books.data!.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.name} {b.edition && <span className="text-fg-muted">({b.edition})</span>}
                  </td>
                  <td>{b.issuer}</td>
                  <td className="text-right tabular-nums">{b.items}</td>
                  <td className="text-right">
                    {mayEdit && (
                      <>
                        <input
                          ref={(el) => {
                            file.current[b.id] = el;
                          }}
                          type="file"
                          accept=".xlsx"
                          className="hidden"
                          aria-label={`Spreadsheet for ${b.name}`}
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            setMsg(null);
                            try {
                              const r = await api.upload<{ imported: number; problems: string[] }>(
                                `/api/tenant/sor-books/${b.id}/import`,
                                f,
                              );
                              setMsg({
                                tone: 'info',
                                text: `${r.imported} items imported.${r.problems.length ? ` Skipped: ${r.problems.slice(0, 5).join(' ')}` : ''}`,
                              });
                              toast.success(`${r.imported} items imported into ${b.name}`);
                              refresh();
                            } catch (err) {
                              setMsg({ tone: 'danger', text: describeError(err) });
                            } finally {
                              e.target.value = '';
                            }
                          }}
                        />
                        <Button variant="secondary" onClick={() => file.current[b.id]?.click()}>
                          Import spreadsheet
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {mayEdit && (
          <form
            aria-label="New schedule"
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setMsg(null);
              try {
                await api.request('/api/tenant/sor-books', {
                  method: 'POST',
                  body: { name: form.name, issuer: form.issuer, edition: form.edition },
                });
                toast.success(`Schedule ${form.name.trim()} added`);
                setForm({ ...form, name: '', edition: '' });
                refresh();
              } catch (err) {
                setMsg({ tone: 'danger', text: describeError(err) });
              }
            }}
          >
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                minLength={2}
              />
            </Field>
            <Field label="Issued by">
              <Input
                value={form.issuer}
                onChange={(e) => setForm({ ...form, issuer: e.target.value })}
                required
              />
            </Field>
            <Field label="Edition">
              <Input
                value={form.edition}
                className="w-24"
                onChange={(e) => setForm({ ...form, edition: e.target.value })}
              />
            </Field>
            <Button type="submit" variant="secondary">
              Add schedule
            </Button>
          </form>
        )}
      </Card>
      <Card title="Find an item">
        <Field label="Code or words">
          <Input value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        {(items.data ?? []).length > 0 && (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Code</th>
                <th>Item</th>
                <th>Unit</th>
                <th className="text-right">Rate</th>
              </tr>
            </thead>
            <tbody aria-label="Schedule items">
              {items.data!.map((i) => (
                <tr key={i.id}>
                  <td className="font-mono text-xs">{i.code}</td>
                  <td>
                    {i.description}
                    <div className="text-xs text-fg-muted">
                      {i.book}
                      {i.chapter && ` · ${i.chapter}`}
                    </div>
                  </td>
                  <td>{i.unit}</td>
                  <td className="text-right tabular-nums">{formatInr(i.rate)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
