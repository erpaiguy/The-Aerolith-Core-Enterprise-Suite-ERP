// The vendor master (docs/wave8-plan.md step 8e.1): every supplier and subcontractor with its trade categories, its
// vetting status and why, and its KYC documents with their expiry; the company's rule to buy only from approved
// vendors. A blacklisted or held vendor is refused enquiries and orders by the server.
import {
  Alert,
  Badge,
  Button,
  Card,
  DataGrid,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  toast,
  useConfirm,
  type GridColumn,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { useGridStorage } from '../lib/grid';
import { usePermission } from '../session/permissions';

export type VendorStatus = 'unvetted' | 'approved' | 'on_hold' | 'blacklisted';
export interface TradeCategory {
  key: string;
  name: string;
  kind: 'material' | 'work' | 'service';
  active: boolean;
}
interface VendorRow {
  id: string;
  name: string;
  isVendor: boolean;
  isSubcontractor: boolean;
  gstin: string | null;
  udyamNo: string | null;
  msmeType: string | null;
  city: string;
  status: VendorStatus;
  statusReason: string;
  categories: string[];
  documents: number;
  expired: number;
  expiring: number;
}
interface Vendor {
  id: string;
  name: string;
  gstin: string | null;
  pan: string | null;
  udyamNo: string | null;
  msmeType: string | null;
  status: VendorStatus;
  statusReason: string;
  statusOn: string | null;
  statusBy: string | null;
  categories: string[];
  documents: {
    id: string;
    kind: string;
    number: string;
    validUntil: string | null;
    note: string;
    mime: string | null;
    fileName: string | null;
    expired: boolean | null;
  }[];
  mayEdit: boolean;
}
export const STATUS_TONE: Record<VendorStatus, 'success' | 'danger' | 'warning' | 'neutral'> = {
  approved: 'success',
  unvetted: 'neutral',
  on_hold: 'warning',
  blacklisted: 'danger',
};
const label = (s: string) => s.replace(/_/g, ' ');
const KYC_KINDS = [
  'gst_certificate',
  'pan',
  'udyam',
  'cancelled_cheque',
  'trade_licence',
  'labour_licence',
  'pf_registration',
  'esi_registration',
  'insurance',
  'iso',
  'other',
];

export const useTradeCategories = () =>
  useQuery({
    queryKey: ['trade-categories'],
    queryFn: () => api.request<TradeCategory[]>('/api/tenant/trade-categories'),
  });

export function VendorsScreen() {
  const qc = useQueryClient();
  const mayEdit = usePermission('purchase.edit');
  const [filter, setFilter] = useState<{ category: string; status: string }>({
    category: '',
    status: '',
  });
  const cats = useTradeCategories();
  const list = useQuery({
    queryKey: ['vendors', filter],
    queryFn: () => {
      const q = new URLSearchParams();
      if (filter.category) q.set('category', filter.category);
      if (filter.status) q.set('status', filter.status);
      return api.request<VendorRow[]>(`/api/tenant/vendors?${q.toString()}`);
    },
  });
  const policy = useQuery({
    queryKey: ['vendor-policy'],
    queryFn: () => api.request<{ approvedOnly: boolean }>('/api/tenant/vendor-policy'),
  });
  const [error, setError] = useState<string | null>(null);
  const name = (k: string) => cats.data?.find((c) => c.key === k)?.name ?? k;
  const storage = useGridStorage('vendors');
  const columns: GridColumn<VendorRow>[] = [
    {
      id: 'name',
      header: 'Name',
      width: 240,
      hideable: false,
      value: (v) => v.name,
      cell: (v) => (
        <>
          <Link to="/vendors/$partyId" params={{ partyId: v.id }} className="underline">
            {v.name}
          </Link>
          {v.city && <span className="text-xs text-fg-muted"> {v.city}</span>}
        </>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 180,
      value: (v) => label(v.status),
      cell: (v) => (
        <>
          <Badge tone={STATUS_TONE[v.status]}>{label(v.status)}</Badge>
          {v.statusReason && <div className="text-xs text-fg-muted">{v.statusReason}</div>}
        </>
      ),
    },
    {
      id: 'categories',
      header: 'Categories',
      width: 220,
      value: (v) => v.categories.map(name).join(', '),
      cell: (v) => <span className="text-sm">{v.categories.map(name).join(', ')}</span>,
    },
    {
      id: 'msme',
      header: 'MSME',
      width: 110,
      value: (v) => (v.msmeType ? label(v.msmeType) : null),
      cell: (v) => <span className="text-sm">{v.msmeType ? label(v.msmeType) : ''}</span>,
    },
    {
      id: 'documents',
      header: 'Documents',
      width: 180,
      value: (v) => v.documents,
      cell: (v) => (
        <span className="text-sm">
          {v.documents}
          {v.expired > 0 && <Badge tone="danger">{v.expired} expired</Badge>}
          {v.expiring > 0 && <Badge tone="warning">{v.expiring} expiring</Badge>}
        </span>
      ),
    },
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Vendor master"
        subtitle="Trade categories, approval or blacklisting with the reason, and KYC documents with their expiry."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card
        title="Vendors and subcontractors"
        actions={
          mayEdit &&
          policy.data && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={policy.data.approvedOnly}
                onChange={async (e) => {
                  setError(null);
                  try {
                    qc.setQueryData(
                      ['vendor-policy'],
                      await api.request('/api/tenant/vendor-policy', {
                        method: 'POST',
                        body: { approvedOnly: e.target.checked },
                      }),
                    );
                    toast.success(
                      e.target.checked
                        ? 'Enquiries and orders now go to approved vendors only'
                        : 'Enquiries and orders may go to any vendor',
                    );
                  } catch (err) {
                    setError(describeError(err));
                  }
                }}
              />
              Enquiries and orders to approved vendors only
            </label>
          )
        }
      >
        <div className="mb-3 flex flex-wrap gap-3">
          <Field label="Trade category">
            <Select
              value={filter.category}
              onChange={(e) => setFilter({ ...filter, category: e.target.value })}
            >
              <option value="">All</option>
              {(cats.data ?? []).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={filter.status}
              onChange={(e) => setFilter({ ...filter, status: e.target.value })}
            >
              <option value="">All</option>
              {(['approved', 'unvetted', 'on_hold', 'blacklisted'] as const).map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {list.isPending ? (
          <Spinner />
        ) : (
          <DataGrid
            id="vendors"
            label="Vendors"
            columns={columns}
            rows={list.data ?? []}
            rowKey={(v) => v.id}
            storage={storage}
            exportName="Vendors"
            empty={
              <EmptyState title="No vendors here.">
                Vendors and subcontractors are added as parties, or when an enquiry asks them to
                quote.
              </EmptyState>
            }
          />
        )}
      </Card>
    </div>
  );
}

export function VendorScreen({ partyId }: { partyId: string }) {
  const qc = useQueryClient();
  const key = ['vendor', partyId];
  const v = useQuery({
    queryKey: key,
    queryFn: () => api.request<Vendor>(`/api/tenant/vendors/${partyId}`),
  });
  const cats = useTradeCategories();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ status: VendorStatus | ''; reason: string }>({
    status: '',
    reason: '',
  });
  const [doc, setDoc] = useState({ kind: 'gst_certificate', number: '', validUntil: '', note: '' });
  const file = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const run = async (fn: () => Promise<Vendor>, done?: string) => {
    setError(null);
    try {
      qc.setQueryData(key, await fn());
      void qc.invalidateQueries({ queryKey: ['vendors'] });
      if (done) toast.success(done);
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  if (v.isPending) return <Spinner />;
  if (v.isError) return <Alert tone="danger">{describeError(v.error)}</Alert>;
  const d = v.data;
  const post = (path: string, body: object) => () =>
    api.request<Vendor>(path, { method: 'POST', body });
  return (
    <div className="space-y-5">
      <PageHeader
        title={d.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[d.status]}>{label(d.status)}</Badge>
            {d.statusReason && <span>{d.statusReason}</span>}
            {d.statusOn && (
              <span className="text-fg-muted">
                {d.statusOn}
                {d.statusBy ? `, ${d.statusBy}` : ''}
              </span>
            )}
          </span>
        }
        actions={
          <Link to="/vendors" className="text-sm underline">
            All vendors
          </Link>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Details">
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <dt className="text-fg-muted">GSTIN</dt>
          <dd>{d.gstin ?? '—'}</dd>
          <dt className="text-fg-muted">PAN</dt>
          <dd>{d.pan ?? '—'}</dd>
          <dt className="text-fg-muted">Udyam</dt>
          <dd>{d.udyamNo ?? '—'}</dd>
          <dt className="text-fg-muted">MSME</dt>
          <dd>{d.msmeType ? label(d.msmeType) : '—'}</dd>
        </dl>
      </Card>
      {d.mayEdit && (
        <Card title="Status">
          <form
            aria-label="Vendor status"
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!status.status) return;
              if (
                status.status === 'blacklisted' &&
                !(await confirm({
                  title: `Blacklist ${d.name}?`,
                  body: 'No enquiry or order can go to them while they are blacklisted.',
                  confirmLabel: 'Blacklist the vendor',
                  tone: 'danger',
                }))
              )
                return;
              void run(
                post(`/api/tenant/vendors/${partyId}/status`, {
                  status: status.status,
                  reason: status.reason,
                }),
                `${d.name}: ${label(status.status).toLowerCase()}`,
              ).then((ok) => ok && setStatus({ status: '', reason: '' }));
            }}
          >
            <Field label="New status">
              <Select
                value={status.status}
                onChange={(e) => setStatus({ ...status, status: e.target.value as VendorStatus })}
                required
              >
                <option value="">Choose…</option>
                {(['approved', 'on_hold', 'blacklisted', 'unvetted'] as const).map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="min-w-64 flex-1">
              <Field label="Reason">
                <Input
                  value={status.reason}
                  onChange={(e) => setStatus({ ...status, reason: e.target.value })}
                  required={status.status === 'on_hold' || status.status === 'blacklisted'}
                  minLength={status.status === 'on_hold' || status.status === 'blacklisted' ? 3 : 0}
                />
              </Field>
            </div>
            <Button type="submit" variant="secondary">
              Set status
            </Button>
          </form>
        </Card>
      )}
      <Card title="Trade categories">
        <div className="flex flex-wrap gap-3 text-sm" aria-label="Trade categories">
          {(cats.data ?? [])
            .filter((c) => c.active || d.categories.includes(c.key))
            .map((c) => (
              <label key={c.key} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  disabled={!d.mayEdit}
                  checked={d.categories.includes(c.key)}
                  onChange={(e) =>
                    void run(
                      post(`/api/tenant/vendors/${partyId}/categories`, {
                        categories: e.target.checked
                          ? [...d.categories, c.key]
                          : d.categories.filter((x) => x !== c.key),
                      }),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
        </div>
      </Card>
      <Card title="KYC documents">
        {d.documents.length > 0 && (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Document</th>
                <th>Number</th>
                <th>Valid until</th>
                <th>Scan</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="KYC documents">
              {d.documents.map((x) => (
                <tr key={x.id}>
                  <td>
                    {label(x.kind)}
                    {x.note && <div className="text-xs text-fg-muted">{x.note}</div>}
                  </td>
                  <td>{x.number}</td>
                  <td>
                    {x.validUntil ?? ''}
                    {x.expired && <Badge tone="danger">expired</Badge>}
                  </td>
                  <td>
                    {x.mime && (
                      <button
                        type="button"
                        className="underline"
                        onClick={() =>
                          void api
                            .download(`/api/tenant/vendor-documents/${x.id}/file`)
                            .then(({ blob }) => window.open(URL.createObjectURL(blob), '_blank'))
                        }
                      >
                        {x.fileName ?? 'Open'}
                      </button>
                    )}
                  </td>
                  <td>
                    {d.mayEdit && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={async () => {
                          if (
                            !(await confirm({
                              title: `Remove ${label(x.kind)} ${x.number}?`,
                              body: `The document and its scan are taken off ${d.name}'s KYC.`,
                              confirmLabel: 'Remove the document',
                              tone: 'danger',
                            }))
                          )
                            return;
                          await run(
                            post(`/api/tenant/vendor-documents/${x.id}/remove`, {}),
                            `${label(x.kind)} removed`,
                          );
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {d.mayEdit && (
          <form
            aria-label="Add a KYC document"
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const scan = file.current?.files?.[0];
              const meta = {
                kind: doc.kind,
                number: doc.number,
                validUntil: doc.validUntil || null,
                note: doc.note,
              };
              void run(
                () => {
                  if (!scan)
                    return api.request<Vendor>(`/api/tenant/vendors/${partyId}/documents`, {
                      method: 'POST',
                      body: meta,
                    });
                  const q = new URLSearchParams({
                    kind: meta.kind,
                    number: meta.number,
                    note: meta.note,
                  });
                  if (meta.validUntil) q.set('validUntil', meta.validUntil);
                  return api.upload<Vendor>(
                    `/api/tenant/vendors/${partyId}/documents?${q.toString()}`,
                    scan,
                  );
                },
                `${label(meta.kind)} added`,
              ).then((ok) => {
                if (!ok) return;
                setDoc({ ...doc, number: '', validUntil: '', note: '' });
                if (file.current) file.current.value = '';
              });
            }}
          >
            <Field label="Document">
              <Select value={doc.kind} onChange={(e) => setDoc({ ...doc, kind: e.target.value })}>
                {KYC_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Number">
              <Input
                value={doc.number}
                onChange={(e) => setDoc({ ...doc, number: e.target.value })}
              />
            </Field>
            <Field label="Valid until">
              <Input
                type="date"
                value={doc.validUntil}
                onChange={(e) => setDoc({ ...doc, validUntil: e.target.value })}
              />
            </Field>
            <Field label="Scan (PDF or picture)">
              <input ref={file} type="file" accept="application/pdf,image/*" className="text-sm" />
            </Field>
            <Button type="submit" variant="secondary">
              Add document
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
