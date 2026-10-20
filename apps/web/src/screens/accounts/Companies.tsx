// Companies (docs/wave3-plan.md step 1): each legal entity keeps its own books, GSTIN and numbering. The admin adds
// and edits them; the GSTIN gives the state and the PAN.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Spinner,
  Table,
  Textarea,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { useCompanies, type Company } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { type Letterhead, useLetterhead } from '../../print/Letterhead';
import { Link } from '@tanstack/react-router';
import { shortDate } from '../../schedule/model';

export function CompaniesScreen() {
  const companies = useCompanies();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [heading, setHeading] = useState<string | null>(null);
  if (companies.isPending) return <Spinner />;
  if (companies.isError) return <Alert tone="danger">{describeError(companies.error)}</Alert>;
  const { companies: list, mayEdit } = companies.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Companies"
        subtitle="Each company keeps its own books, GST registration and document numbers."
        actions={
          mayEdit &&
          editing !== 'new' && (
            <Button type="button" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden /> Add a company
            </Button>
          )
        }
      />
      {editing === 'new' && <CompanyForm onClose={() => setEditing(null)} />}
      <Card>
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Company</th>
              <th>GSTIN</th>
              <th>PAN / TAN</th>
              <th>Books from</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="Companies">
            {list.map((c) =>
              editing === c.id ? (
                <tr key={c.id}>
                  <td colSpan={5}>
                    <CompanyForm company={c} onClose={() => setEditing(null)} />
                  </td>
                </tr>
              ) : (
                <tr key={c.id}>
                  <td>
                    {c.name} {c.isDefault && <Badge>Default</Badge>}
                    {c.legalName && <div className="text-xs text-fg-muted">{c.legalName}</div>}
                  </td>
                  <td className="font-mono text-xs">{c.gstin ?? '-'}</td>
                  <td className="font-mono text-xs">
                    {c.pan ?? '-'}
                    {c.tan && <div>{c.tan}</div>}
                  </td>
                  <td className="whitespace-nowrap">
                    {c.booksFrom ? shortDate(c.booksFrom) : '-'}
                  </td>
                  <td className="text-right">
                    {mayEdit && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setHeading(c.id)}
                          aria-label={`Letterhead of ${c.name}`}
                        >
                          Letterhead
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setEditing(c.id)}
                          aria-label={`Edit ${c.name}`}
                        >
                          Edit
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </Table>
      </Card>
      {heading ? (
        <LetterheadForm key={heading} entityId={heading} onClose={() => setHeading(null)} />
      ) : null}
    </div>
  );
}

/** The company's letterhead for printed documents (docs/wave7-plan.md step 7b.1). */
function LetterheadForm({ entityId, onClose }: { entityId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const head = useLetterhead(entityId);
  const [v, setV] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const confirm = useConfirm();
  if (head.isPending) return <Spinner />;
  if (head.isError) return <Alert tone="danger">{describeError(head.error)}</Alert>;
  const l = head.data;
  const f = v ?? {
    phone: l.phone,
    email: l.email,
    website: l.website,
    footer: l.footer,
    signatoryName: l.signatoryName,
    signatoryTitle: l.signatoryTitle,
  };
  const set = (k: string) => (e: { target: { value: string } }) => {
    setSaved(false);
    setV({ ...f, [k]: e.target.value });
  };
  const send = async (path: string, init: { method: string; body?: object }) => {
    setError(null);
    try {
      const out = await api.request<Letterhead>(`/api/tenant/companies/${entityId}/${path}`, init);
      qc.setQueryData(['letterhead', entityId], out);
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const logo = (file: File | undefined) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () =>
      void send('logo', { method: 'POST', body: { dataUrl: String(r.result) } }).then(
        (ok) => ok && toast.success('Logo uploaded'),
      );
    r.readAsDataURL(file);
  };
  return (
    <Card
      title={`Letterhead of ${l.name}`}
      actions={
        <Link
          to="/print/letterhead/$entityId"
          params={{ entityId }}
          className="text-sm text-accent hover:underline"
        >
          See a sample page
        </Link>
      }
    >
      <form
        aria-label="Letterhead"
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send('letterhead', { method: 'POST', body: f }).then((ok) => {
            setSaved(ok);
            if (ok) toast.success('Letterhead saved');
          });
        }}
      >
        <div className="flex flex-wrap items-center gap-4">
          {l.logo ? (
            <img src={l.logo} alt="Logo" className="h-16 w-auto rounded border border-line p-1" />
          ) : (
            <span className="text-sm text-fg-muted">No logo yet.</span>
          )}
          <Field label="Logo (PNG or JPEG, up to 300 KB)">
            <Input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => logo(e.target.files?.[0])}
            />
          </Field>
          {l.logo ? (
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                if (
                  !(await confirm({
                    title: 'Remove the logo?',
                    body: 'Printed documents no longer carry it until a new one is uploaded.',
                    confirmLabel: 'Remove the logo',
                    tone: 'danger',
                  }))
                )
                  return;
                if (await send('logo', { method: 'DELETE' })) toast.success('Logo removed');
              }}
            >
              Remove the logo
            </Button>
          ) : null}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Phone">
            <Input value={f.phone} onChange={set('phone')} maxLength={60} />
          </Field>
          <Field label="Email">
            <Input type="email" value={f.email} onChange={set('email')} maxLength={120} />
          </Field>
          <Field label="Website">
            <Input value={f.website} onChange={set('website')} maxLength={120} />
          </Field>
          <Field label="Signs for the company">
            <Input value={f.signatoryName} onChange={set('signatoryName')} maxLength={120} />
          </Field>
          <Field label="Signatory's title">
            <Input value={f.signatoryTitle} onChange={set('signatoryTitle')} maxLength={120} />
          </Field>
        </div>
        <Field label="Footer">
          <Textarea value={f.footer} onChange={set('footer')} maxLength={500} rows={2} />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {saved ? <Alert tone="success">Letterhead saved.</Alert> : null}
        <div className="flex gap-2">
          <Button type="submit">Save letterhead</Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CompanyForm({ company, onClose }: { company?: Company; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: company?.name ?? '',
    legalName: company?.legalName ?? '',
    gstin: company?.gstin ?? '',
    pan: company?.pan ?? '',
    tan: company?.tan ?? '',
    address: company?.address ?? '',
    city: company?.city ?? '',
    pincode: company?.pincode ?? '',
    booksFrom: company?.booksFrom ?? '',
  });
  const [eInvoicing, setEInvoicing] = useState(company?.eInvoicing ?? false);
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
      const body = {
        ...f,
        gstin: f.gstin || null,
        pan: f.pan || null,
        tan: f.tan || null,
        pincode: f.pincode || null,
        eInvoicing,
        booksFrom: f.booksFrom || null,
        ...(company ? { rowVersion: company.rowVersion } : {}),
      };
      const out = await api.request(
        company ? `/api/tenant/companies/${company.id}` : '/api/tenant/companies',
        {
          method: 'POST',
          body,
        },
      );
      qc.setQueryData(['companies'], out);
      toast.success(company ? `${f.name} saved` : `Company ${f.name} added`);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={company ? `Edit ${company.name}` : 'New company'}>
      <form
        onSubmit={(e) => void submit(e)}
        className="space-y-3"
        aria-label={company ? 'Edit company' : 'New company'}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input {...field('name')} required maxLength={200} />
          </Field>
          <Field label="Legal name" hint="As registered, for invoices">
            <Input {...field('legalName')} maxLength={200} />
          </Field>
          <Field label="GSTIN">
            <Input {...field('gstin')} maxLength={15} className="font-mono uppercase" />
          </Field>
          <Field label="Books start on" hint="Opening balances are dated the day before">
            <Input type="date" {...field('booksFrom')} />
          </Field>
          <Field label="PAN" hint="Taken from the GSTIN when left blank">
            <Input {...field('pan')} maxLength={10} className="font-mono uppercase" />
          </Field>
          <Field label="TAN" hint="For TDS">
            <Input {...field('tan')} maxLength={10} className="font-mono uppercase" />
          </Field>
        </div>
        <Field label="Address">
          <Textarea {...field('address')} rows={2} maxLength={1000} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="City">
            <Input {...field('city')} maxLength={100} />
          </Field>
          <Field label="PIN code">
            <Input {...field('pincode')} maxLength={6} inputMode="numeric" />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={eInvoicing}
              onChange={(e) => setEInvoicing(e.target.checked)}
            />
            Issues e-invoices
          </label>
        </div>
        <div className="flex gap-2">
          <Button type="submit" busy={busy}>
            {company ? 'Save' : 'Add company'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
