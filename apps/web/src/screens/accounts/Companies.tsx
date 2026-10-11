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
} from '@aerolith/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { useCompanies, type Company } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { shortDate } from '../../schedule/model';

export function CompaniesScreen() {
  const companies = useCompanies();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
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
            <Button onClick={() => setEditing('new')}>
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
                      <Button
                        variant="ghost"
                        onClick={() => setEditing(c.id)}
                        aria-label={`Edit ${c.name}`}
                      >
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </Table>
      </Card>
    </div>
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
    booksFrom: company?.booksFrom ?? '',
  });
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
        <div className="flex gap-2">
          <Button type="submit" busy={busy}>
            {company ? 'Save' : 'Add company'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
