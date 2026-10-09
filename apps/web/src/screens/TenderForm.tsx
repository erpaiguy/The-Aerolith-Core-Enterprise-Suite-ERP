// Create/edit form for a tender. Used by "New tender" and by "Edit" on the tender page.
import { Alert, Button, Field, Input, Select, Textarea } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { Party, Person, TenderDetail } from '../api/types';
import { describeError, fromLocalInput, toLocalInput } from '../lib/format';

export const SOURCES: Record<string, string> = {
  public_portal: 'Public e-procurement portal',
  gem: 'GeM',
  private_invitation: 'Private invitation',
  repeat_client: 'Repeat client',
  referral: 'Referral',
  other: 'Other',
};

export const VERTICALS: Record<string, string> = {
  buildings: 'Buildings',
  interiors: 'Interiors',
  joinery: 'Joinery',
  mep: 'MEP',
  other: 'Other',
};

interface Values {
  title: string;
  clientId: string;
  clientRef: string;
  source: string;
  portalUrl: string;
  vertical: string;
  location: string;
  estimatedValue: string;
  emdAmount: string;
  tenderFee: string;
  publishedOn: string;
  prebidAt: string;
  submissionDueAt: string;
  openingAt: string;
  queriesDueAt: string;
  bidValidityDays: string;
  ownerId: string;
  description: string;
}

const fromTender = (t: TenderDetail | undefined): Values => ({
  title: t?.title ?? '',
  clientId: t?.client?.id ?? '',
  clientRef: t?.clientRef ?? '',
  source: t?.source ?? 'public_portal',
  portalUrl: t?.portalUrl ?? '',
  vertical: t?.vertical ?? 'buildings',
  location: t?.location ?? '',
  estimatedValue: t?.estimatedValue ?? '',
  emdAmount: t?.emdAmount ?? '',
  tenderFee: t?.tenderFee ?? '',
  publishedOn: t?.publishedOn ?? '',
  prebidAt: toLocalInput(t?.prebidAt ?? null),
  submissionDueAt: toLocalInput(t?.submissionDueAt ?? null),
  openingAt: toLocalInput(t?.openingAt ?? null),
  queriesDueAt: toLocalInput(t?.queriesDueAt ?? null),
  bidValidityDays: t?.bidValidityDays ? String(t.bidValidityDays) : '',
  ownerId: t?.owner?.id ?? '',
  description: t?.description ?? '',
});

const toBody = (v: Values) => ({
  title: v.title.trim(),
  clientId: v.clientId || null,
  clientRef: v.clientRef,
  source: v.source,
  portalUrl: v.portalUrl.trim(),
  vertical: v.vertical,
  location: v.location,
  estimatedValue: v.estimatedValue.replace(/,/g, '').trim() || null,
  emdAmount: v.emdAmount.replace(/,/g, '').trim() || null,
  tenderFee: v.tenderFee.replace(/,/g, '').trim() || null,
  publishedOn: v.publishedOn || null,
  prebidAt: fromLocalInput(v.prebidAt),
  submissionDueAt: fromLocalInput(v.submissionDueAt),
  openingAt: fromLocalInput(v.openingAt),
  queriesDueAt: fromLocalInput(v.queriesDueAt),
  bidValidityDays: v.bidValidityDays ? Number(v.bidValidityDays) : null,
  ownerId: v.ownerId || null,
  description: v.description,
});

/** Inline "add a client" so a new tender never needs a trip to another page. */
function NewClient({ onCreated }: { onCreated: (p: Party) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [gstin, setGstin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        className="text-sm text-accent hover:underline"
        onClick={() => setOpen(true)}
      >
        + New client
      </button>
    );
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.request<Party>('/api/tenant/parties', {
        method: 'POST',
        body: { name, gstin, isClient: true },
      });
      await qc.invalidateQueries({ queryKey: ['parties'] });
      onCreated(p);
      setOpen(false);
      setName('');
      setGstin('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client name">
          <Input name="newClientName" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="GSTIN (optional)">
          <Input name="newClientGstin" value={gstin} onChange={(e) => setGstin(e.target.value)} />
        </Field>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          busy={busy}
          disabled={name.trim().length < 2}
          onClick={() => void save()}
        >
          Add client
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function TenderForm({
  tender,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  tender?: TenderDetail;
  submitLabel: string;
  onSubmit: (body: ReturnType<typeof toBody>) => Promise<void>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<Values>(() => fromTender(tender));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clients = useQuery({
    queryKey: ['parties', 'client'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=client'),
  });
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api.request<Person[]>('/api/tenant/people'),
  });
  const set = (k: keyof Values) => (e: { target: { value: string } }) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(toBody(v));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-6">
      <section className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Tender title" hint="As written in the notice inviting tender (NIT).">
            <Input name="title" value={v.title} onChange={set('title')} required minLength={3} />
          </Field>
        </div>
        <div className="space-y-2">
          <Field label="Client">
            <Select name="clientId" value={v.clientId} onChange={set('clientId')}>
              <option value="">Not set</option>
              {clients.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <NewClient onCreated={(p) => setV((s) => ({ ...s, clientId: p.id }))} />
        </div>
        <Field label="Client's tender number" hint="NIT or reference number.">
          <Input name="clientRef" value={v.clientRef} onChange={set('clientRef')} />
        </Field>
        <Field label="Source">
          <Select name="source" value={v.source} onChange={set('source')}>
            {Object.entries(SOURCES).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Portal or notice link">
          <Input
            name="portalUrl"
            type="url"
            value={v.portalUrl}
            onChange={set('portalUrl')}
            placeholder="https://"
          />
        </Field>
        <Field label="Vertical">
          <Select name="vertical" value={v.vertical} onChange={set('vertical')}>
            {Object.entries(VERTICALS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Location">
          <Input name="location" value={v.location} onChange={set('location')} />
        </Field>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Field label="Estimated value (₹)">
          <Input
            name="estimatedValue"
            inputMode="decimal"
            value={v.estimatedValue}
            onChange={set('estimatedValue')}
          />
        </Field>
        <Field label="EMD (₹)">
          <Input
            name="emdAmount"
            inputMode="decimal"
            value={v.emdAmount}
            onChange={set('emdAmount')}
          />
        </Field>
        <Field label="Tender fee (₹)">
          <Input
            name="tenderFee"
            inputMode="decimal"
            value={v.tenderFee}
            onChange={set('tenderFee')}
          />
        </Field>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Field label="Submission due">
          <Input
            name="submissionDueAt"
            type="datetime-local"
            value={v.submissionDueAt}
            onChange={set('submissionDueAt')}
          />
        </Field>
        <Field label="Pre-bid meeting">
          <Input
            name="prebidAt"
            type="datetime-local"
            value={v.prebidAt}
            onChange={set('prebidAt')}
          />
        </Field>
        <Field label="Bid opening">
          <Input
            name="openingAt"
            type="datetime-local"
            value={v.openingAt}
            onChange={set('openingAt')}
          />
        </Field>
        <Field label="Last day for queries">
          <Input
            name="queriesDueAt"
            type="datetime-local"
            value={v.queriesDueAt}
            onChange={set('queriesDueAt')}
          />
        </Field>
        <Field label="Published on">
          <Input
            name="publishedOn"
            type="date"
            value={v.publishedOn}
            onChange={set('publishedOn')}
          />
        </Field>
        <Field label="Bid validity (days)">
          <Input
            name="bidValidityDays"
            type="number"
            min={1}
            max={730}
            value={v.bidValidityDays}
            onChange={set('bidValidityDays')}
          />
        </Field>
        <Field label="Owner (estimator)" hint="Gets the deadline reminders.">
          <Select name="ownerId" value={v.ownerId} onChange={set('ownerId')}>
            <option value="">{tender ? 'Not set' : 'Me'}</option>
            {people.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      <Field label="Notes">
        <Textarea name="description" value={v.description} onChange={set('description')} rows={4} />
      </Field>

      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
