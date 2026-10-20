// Party master (docs/04-features.md P10): clients, suppliers, subcontractors and competitors in one list, filtered by
// kind from the menu (docs/wave7-plan.md step 7a.2).
import { RCM_LABELS } from '../accounts/model';
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
  Textarea,
  toast,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Plus, Search } from 'lucide-react';
import { useDeferredValue, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { Party } from '../api/types';
import { describeError } from '../lib/format';
import { useCanEditTenders } from './Tenders';
import { useFocusForm, useNewParam } from '../lib/new-param';

type Values = Omit<Party, 'id' | 'rowVersion'>;

const blank: Values = {
  name: '',
  isClient: true,
  isVendor: false,
  isSubcontractor: false,
  isCompetitor: false,
  gstin: '',
  pan: '',
  contactName: '',
  email: '',
  phone: '',
  address: '',
  notes: '',
};

function PartyForm({ party, onDone }: { party: Party | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState<Values>(() =>
    party
      ? {
          ...party,
          gstin: party.gstin ?? '',
          pan: party.pan ?? '',
          contactName: party.contactName ?? '',
          email: party.email ?? '',
          phone: party.phone ?? '',
          address: party.address ?? '',
          tdsSection: party.tdsSection ?? '',
          rcmCategory: party.rcmCategory ?? '',
          udyamNo: party.udyamNo ?? '',
          msmeType: party.msmeType ?? '',
          bankAccountName: party.bankAccountName ?? '',
          bankAccountNo: party.bankAccountNo ?? '',
          bankIfsc: party.bankIfsc ?? '',
          legalName: party.legalName ?? '',
          city: party.city ?? '',
          pincode: party.pincode ?? '',
          stateCode: party.stateCode ?? '',
          tan: party.tan ?? '',
        }
      : blank,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Values) => (e: { target: { value: string } }) =>
    setV((s) => ({ ...s, [k]: e.target.value }));
  const flag = (k: 'isClient' | 'isVendor' | 'isSubcontractor' | 'isCompetitor') => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={v[k]}
        onChange={(e) => setV((s) => ({ ...s, [k]: e.target.checked }))}
      />
      {k === 'isClient'
        ? 'Client'
        : k === 'isVendor'
          ? 'Vendor'
          : k === 'isSubcontractor'
            ? 'Subcontractor'
            : 'Competitor'}
    </label>
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.request(party ? `/api/tenant/parties/${party.id}` : '/api/tenant/parties', {
        method: 'POST',
        body: party ? { ...v, rowVersion: party.rowVersion } : v,
      });
      await qc.invalidateQueries({ queryKey: ['parties'] });
      toast.success(party ? `${v.name} saved` : `${v.name} added`);
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={party ? `Edit ${party.name}` : 'New party'}>
      <form
        aria-label={party ? 'Edit party' : 'New party'}
        onSubmit={(e) => void submit(e)}
        className="space-y-4"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">
            <Input name="partyName" value={v.name} onChange={set('name')} required minLength={2} />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm font-medium">Type</legend>
            <div className="flex flex-wrap gap-4">
              {flag('isClient')}
              {flag('isVendor')}
              {flag('isSubcontractor')}
              {flag('isCompetitor')}
            </div>
          </fieldset>
          <Field label="GSTIN" hint="15 characters; leave empty if not registered.">
            <Input name="gstin" value={v.gstin ?? ''} onChange={set('gstin')} maxLength={15} />
          </Field>
          <Field label="PAN">
            <Input name="pan" value={v.pan ?? ''} onChange={set('pan')} maxLength={10} />
          </Field>
          <Field label="Contact person">
            <Input name="contactName" value={v.contactName ?? ''} onChange={set('contactName')} />
          </Field>
          <Field label="Phone">
            <Input name="phone" type="tel" value={v.phone ?? ''} onChange={set('phone')} />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" value={v.email ?? ''} onChange={set('email')} />
          </Field>
          <Field label="Address">
            <Input name="address" value={v.address ?? ''} onChange={set('address')} />
          </Field>
        </div>
        {v.isClient && (
          <div className="grid gap-4 md:grid-cols-5">
            <Field label="Legal name" hint="For e-invoices">
              <Input value={v.legalName ?? ''} onChange={set('legalName')} maxLength={200} />
            </Field>
            <Field label="City">
              <Input value={v.city ?? ''} onChange={set('city')} maxLength={100} />
            </Field>
            <Field label="PIN code">
              <Input
                value={v.pincode ?? ''}
                onChange={set('pincode')}
                maxLength={6}
                inputMode="numeric"
              />
            </Field>
            <Field label="State code" hint="From the GSTIN if blank">
              <Input value={v.stateCode ?? ''} onChange={set('stateCode')} maxLength={2} />
            </Field>
            <Field label="TAN" hint="Theirs, as deductor of TDS">
              <Input
                value={v.tan ?? ''}
                onChange={set('tan')}
                maxLength={10}
                className="uppercase"
              />
            </Field>
          </div>
        )}
        {(v.isVendor || v.isSubcontractor) && (
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="TDS section" hint="Deducted from their bills">
              <Select value={v.tdsSection ?? ''} onChange={set('tdsSection')}>
                <option value="">None</option>
                <option value="194C">194C contractors</option>
                <option value="194J">194J professional fees</option>
                <option value="194I">194I rent</option>
                <option value="194Q">194Q purchase of goods</option>
              </Select>
            </Field>
            <Field label="GST reverse charge" hint="The company pays the GST on their bills">
              <Select value={v.rcmCategory ?? ''} onChange={set('rcmCategory')}>
                <option value="">No</option>
                {Object.entries(RCM_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="MSME (Udyam)" hint="Micro and small: paid within 45 days">
              <Select value={v.msmeType ?? ''} onChange={set('msmeType')}>
                <option value="">Not registered</option>
                <option value="micro">Micro</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
              </Select>
            </Field>
            <Field label="Udyam number">
              <Input
                value={v.udyamNo ?? ''}
                onChange={set('udyamNo')}
                placeholder="UDYAM-MH-12-0012345"
                maxLength={19}
              />
            </Field>
            <Field label="Bank account name">
              <Input
                value={v.bankAccountName ?? ''}
                onChange={set('bankAccountName')}
                maxLength={200}
              />
            </Field>
            <Field label="Account number">
              <Input
                value={v.bankAccountNo ?? ''}
                onChange={set('bankAccountNo')}
                maxLength={20}
                inputMode="numeric"
              />
            </Field>
            <Field label="IFSC">
              <Input
                value={v.bankIfsc ?? ''}
                onChange={set('bankIfsc')}
                maxLength={11}
                className="uppercase"
              />
            </Field>
          </div>
        )}
        <Field label="Notes">
          <Textarea name="notes" rows={2} value={v.notes} onChange={set('notes')} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" busy={busy}>
            {party ? 'Save' : 'Add'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

const KINDS: [string, string][] = [
  ['', 'All'],
  ['client', 'Clients'],
  ['vendor', 'Suppliers'],
  ['subcontractor', 'Subcontractors'],
  ['competitor', 'Competitors'],
];

export function ClientsScreen() {
  const canEdit = useCanEditTenders();
  const navigate = useNavigate();
  const kind = useRouterState({
    select: (r) => (r.location.search as { kind?: string }).kind ?? '',
  });
  const [search, setSearch] = useState('');
  const asked = useNewParam('party');
  const [editing, setEditing] = useState<Party | 'new' | null>(asked ? 'new' : null);
  useEffect(() => {
    if (asked) setEditing('new');
  }, [asked]);
  useFocusForm('New party', editing === 'new' && asked);
  const q = useDeferredValue(search.trim());
  const parties = useQuery({
    queryKey: ['parties', kind || 'all', q],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (kind) qs.set('kind', kind);
      const s = qs.toString();
      return api.request<Party[]>(`/api/tenant/parties${s ? `?${s}` : ''}`);
    },
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Parties"
        subtitle="Clients, suppliers, subcontractors and competitors: one record each, used across tenders, projects and the books."
        actions={
          canEdit &&
          editing === null && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden /> New party
            </Button>
          )
        }
      />
      {editing !== null && (
        <PartyForm
          key={editing === 'new' ? 'new' : editing.id}
          party={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
      <Card>
        <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Kind of party">
          {KINDS.map(([k, label]) => (
            <Button
              key={k}
              type="button"
              variant={kind === k ? 'secondary' : 'ghost'}
              aria-pressed={kind === k}
              onClick={() => void navigate({ to: '/clients', search: k ? { kind: k } : {} })}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="relative mb-4 max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            aria-label="Search parties"
            placeholder="Name, GSTIN or contact"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {parties.isPending ? (
          <Spinner />
        ) : parties.isError ? (
          <Alert tone="danger">{describeError(parties.error)}</Alert>
        ) : parties.data.length === 0 ? (
          <EmptyState title={q ? 'Nothing matches.' : 'No parties of this kind yet.'}>
            {q
              ? 'Try another name, GSTIN or contact.'
              : 'Add each client, supplier, subcontractor or competitor once with New party.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>GSTIN</th>
                <th>Contact</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {parties.data.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.name}</td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {p.isClient && <Badge tone="accent">client</Badge>}
                      {p.isVendor && <Badge>vendor</Badge>}
                      {p.isSubcontractor && <Badge>subcontractor</Badge>}
                      {p.isCompetitor && <Badge tone="warning">competitor</Badge>}
                    </span>
                  </td>
                  <td className="font-mono text-xs">{p.gstin ?? '-'}</td>
                  <td className="text-fg-muted">
                    {[p.contactName, p.phone, p.email].filter(Boolean).join(' · ') || '-'}
                  </td>
                  <td className="text-right">
                    {canEdit && (
                      <Button variant="ghost" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
