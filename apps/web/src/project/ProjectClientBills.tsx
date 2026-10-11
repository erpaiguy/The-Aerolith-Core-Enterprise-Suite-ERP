// A project's client RA bills on its page (docs/wave3-plan.md step 2): the bills, a new one made up to a date from the
// measurement book, and the contract terms every bill copies (GST, retention, the advance, escalation).
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, Settings2, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import {
  BILL_STATUS,
  BILL_TONE,
  type BillTerms,
  type ClientBill,
  type ProjectBills,
} from '../accounts/bills';
import { today } from '../accounts/model';
import { describeError } from '../lib/format';
import { rupees } from '../procurement/OrderLines';
import { shortDate } from '../schedule/model';

export function ProjectClientBills({ project: p }: { project: ProjectDetail }) {
  const key = ['client-bills', p.id];
  const qc = useQueryClient();
  const navigate = useNavigate();
  const data = useQuery({
    queryKey: key,
    queryFn: () => api.request<ProjectBills>(`/api/tenant/projects/${p.id}/client-bills`),
  });
  const [making, setMaking] = useState(false);
  const [editingTerms, setEditingTerms] = useState(false);
  const [upto, setUpto] = useState(today());
  const sites = p.sites.filter((s) => s.active);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (data.isPending) return <Spinner />;
  if (data.isError) return <Alert tone="danger">{describeError(data.error)}</Alert>;
  const d = data.data;
  const make = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const b = await api.request<ClientBill>(`/api/tenant/projects/${p.id}/client-bills`, {
        method: 'POST',
        body: { upto, siteId: sites.length > 1 ? siteId : null },
      });
      void qc.invalidateQueries({ queryKey: key });
      await navigate({ to: '/client-bills/$billId', params: { billId: b.id } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const t = d.terms;
  return (
    <Card
      title="Client bills"
      actions={
        d.mayBill && (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setEditingTerms(!editingTerms)}>
              <Settings2 className="size-4" aria-hidden /> Contract terms
            </Button>
            {!making && (
              <Button variant="secondary" onClick={() => setMaking(true)}>
                <Plus className="size-4" aria-hidden /> New RA bill
              </Button>
            )}
          </div>
        )
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          GST {Number(t.gstPct)}% on top
          {Number(t.retentionPct) > 0 &&
            `; retention ${Number(t.retentionPct)}%${t.retentionCap ? ` up to ${rupees(t.retentionCap)}` : ''}`}
          {Number(t.advanceAmount) > 0 &&
            `; advance ${rupees(t.advanceAmount)} recovered at ${Number(t.advanceRecoveryPct)}% a bill`}
          {t.escalation &&
            `; escalation on ${t.escalation.components.map((c) => c.name.toLowerCase()).join(', ')}`}
          .{!d.client && ' The project has no client yet.'}
          {!d.gstin && ` ${d.company} has no GSTIN yet.`}
        </p>
        {editingTerms && (
          <TermsForm
            projectId={p.id}
            terms={t}
            onDone={(next) => {
              qc.setQueryData(key, next);
              setEditingTerms(false);
            }}
            onCancel={() => setEditingTerms(false)}
          />
        )}
        {making && (
          <form
            onSubmit={(e) => void make(e)}
            className="flex flex-wrap items-end gap-3 rounded-md border border-line p-3"
            aria-label="New RA bill"
          >
            <Field label="Measured up to">
              <Input
                type="date"
                value={upto}
                max={today()}
                onChange={(e) => setUpto(e.target.value)}
                required
                className="w-40"
              />
            </Field>
            {sites.length > 1 && (
              <Field label="Site (decides the GST)">
                <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} className="w-48">
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Button type="submit" busy={busy}>
              Make the bill
            </Button>
            <Button variant="ghost" onClick={() => setMaking(false)}>
              Cancel
            </Button>
          </form>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        {d.bills.length === 0 ? (
          <p className="text-sm text-fg-muted">No bills yet.</p>
        ) : (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Up to</th>
                <th>Status</th>
                <th className="text-right">Work done</th>
                <th className="text-right">Invoice</th>
                <th className="text-right">Net payable</th>
              </tr>
            </thead>
            <tbody aria-label="Client bills">
              {d.bills.map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap">
                    <Link
                      to="/client-bills/$billId"
                      params={{ billId: b.id }}
                      className="text-accent hover:underline"
                    >
                      RA {b.raNo}
                    </Link>
                    {b.invoiceNo && (
                      <div className="font-mono text-xs text-fg-muted">{b.invoiceNo}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{shortDate(b.upto)}</td>
                  <td>
                    <Badge tone={BILL_TONE[b.status]}>{BILL_STATUS[b.status]}</Badge>
                  </td>
                  <td className="text-right tabular-nums">{rupees(b.gross)}</td>
                  <td className="text-right tabular-nums">{rupees(b.invoiceTotal)}</td>
                  <td className="text-right tabular-nums">{rupees(b.net)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}

function TermsForm({
  projectId,
  terms,
  onDone,
  onCancel,
}: {
  projectId: string;
  terms: BillTerms;
  onDone: (next: ProjectBills) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    gstPct: terms.gstPct,
    retentionPct: terms.retentionPct,
    retentionCap: terms.retentionCap ?? '',
    advanceAmount: terms.advanceAmount,
    advanceRecoveryPct: terms.advanceRecoveryPct,
  });
  const [escalation, setEscalation] = useState(
    terms.escalation ?? {
      factor: '0.85',
      components: [] as NonNullable<BillTerms['escalation']>['components'],
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (k: keyof typeof f) => ({
    value: f[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }),
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(
        await api.request<ProjectBills>(`/api/tenant/projects/${projectId}/bill-terms`, {
          method: 'POST',
          body: {
            ...f,
            retentionCap: f.retentionCap || null,
            rowVersion: terms.rowVersion ?? null,
            escalation: escalation.components.length ? escalation : null,
          },
        }),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const setComponent = (i: number, patch: Partial<(typeof escalation.components)[number]>) =>
    setEscalation({
      ...escalation,
      components: escalation.components.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    });
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded-md border border-line p-3"
      aria-label="Contract terms"
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="GST %">
          <Input {...field('gstPct')} inputMode="decimal" required />
        </Field>
        <Field label="Retention %">
          <Input {...field('retentionPct')} inputMode="decimal" required />
        </Field>
        <Field label="Retention cap ₹" hint="Blank: no cap">
          <Input {...field('retentionCap')} inputMode="decimal" />
        </Field>
        <Field label="Advance ₹">
          <Input {...field('advanceAmount')} inputMode="decimal" />
        </Field>
        <Field label="Recovered % a bill">
          <Input {...field('advanceRecoveryPct')} inputMode="decimal" />
        </Field>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <span className="font-medium">Escalation</span>
          <label className="flex items-center gap-2">
            on
            <Input
              aria-label="Escalation factor"
              className="w-20"
              value={escalation.factor}
              onChange={(e) => setEscalation({ ...escalation, factor: e.target.value })}
            />
            of the value
          </label>
        </div>
        {escalation.components.map((c, i) => (
          <fieldset
            key={i}
            aria-label={`Component ${i + 1}`}
            className="grid gap-2 sm:grid-cols-[1fr_7rem_8rem_auto]"
          >
            <Input
              aria-label="Component"
              placeholder="Materials"
              value={c.name}
              onChange={(e) =>
                setComponent(i, {
                  name: e.target.value,
                  key:
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '_')
                      .replace(/^_|_$/g, '')
                      .replace(/^(\d)/, 'c$1') || `c${i + 1}`,
                })
              }
            />
            <Input
              aria-label="Share %"
              placeholder="Share %"
              value={c.sharePct}
              onChange={(e) => setComponent(i, { sharePct: e.target.value })}
            />
            <Input
              aria-label="Base index"
              placeholder="Base index"
              value={c.baseIndex}
              onChange={(e) => setComponent(i, { baseIndex: e.target.value })}
            />
            <Button
              variant="ghost"
              aria-label={`Remove component ${i + 1}`}
              onClick={() =>
                setEscalation({
                  ...escalation,
                  components: escalation.components.filter((_, j) => j !== i),
                })
              }
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </fieldset>
        ))}
        <Button
          variant="secondary"
          onClick={() =>
            setEscalation({
              ...escalation,
              components: [
                ...escalation.components,
                { key: '', name: '', sharePct: '', baseIndex: '' },
              ],
            })
          }
        >
          <Plus className="size-4" aria-hidden /> Add a component
        </Button>
      </div>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Save the terms
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
