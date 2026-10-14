// Printable purchase documents (docs/wave7-plan.md step 7b.2): the purchase or work order for the supplier, the goods
// receipt note for the store's file, and the store issue slip signed by whoever took the material. Each on the
// project's company letterhead.
import { Alert, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { formatInr } from './money';
import type { Issue } from '../procurement/inventory';
import { ORDER_KIND, type Order, type Receipt } from '../procurement/orders';
import { shortDate } from '../schedule/model';
import { Particulars, PrintSheet, PrintTable } from './Letterhead';
import { rupeesInWords } from './words';

/** The company a project's documents go out under. */
export const useProjectEntity = (projectId: string | undefined) =>
  useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
    enabled: !!projectId,
    select: (p) => p.entity.id,
  });

/** Loading and errors for a print page, before the sheet. */
export function Loading({ q }: { q: { isPending: boolean; isError: boolean; error: unknown } }) {
  return q.isError ? (
    <Alert tone="danger">{describeError(q.error)}</Alert>
  ) : (
    <div className="p-6">
      <Spinner />
    </div>
  );
}

const num = (v: string) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 4 });
const right = 'text-right';

export function OrderPrint({ orderId }: { orderId: string }) {
  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.request<Order>(`/api/tenant/orders/${orderId}`),
  });
  const entity = useProjectEntity(order.data?.project.id);
  if (!order.data) return <Loading q={order} />;
  const o = order.data;
  const r = o.inForce ?? o.open;
  const draft = o.status === 'draft' || !o.inForce;
  return (
    <PrintSheet
      entityId={entity.data}
      title={`${ORDER_KIND[o.kind]}${draft ? ' (draft)' : ''}`}
      meta={
        <>
          <div className="font-mono font-semibold">{o.number}</div>
          {r ? <div>Revision {r.revision}</div> : null}
          <div>{shortDate((r?.approvedAt ?? o.createdAt).slice(0, 10))}</div>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="text-xs font-semibold uppercase">To</div>
          <div className="font-semibold">{o.vendor.name}</div>
          {o.vendor.address ? (
            <div className="whitespace-pre-wrap text-sm">{o.vendor.address}</div>
          ) : null}
          <div className="text-sm">
            {[o.vendor.gstin && `GSTIN ${o.vendor.gstin}`, o.vendor.phone, o.vendor.email]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <Particulars
          rows={[
            ['Project', `${o.project.number} ${o.project.name}`],
            ['Deliver to', r?.site ? [r.site.name, r.site.address].filter(Boolean).join(', ') : ''],
            ['Deliver by', r?.deliverBy ? shortDate(r.deliverBy) : ''],
            ['Against enquiry', o.rfq?.number ?? ''],
          ]}
        />
      </div>
      {r ? (
        <>
          <p className="text-sm">
            {o.kind === 'work'
              ? 'Please carry out the following work at the rates and on the terms below.'
              : 'Please supply the following at the rates and on the terms below.'}
          </p>
          <PrintTable>
            <thead>
              <tr>
                <th>#</th>
                <th>Description</th>
                <th>HSN/SAC</th>
                <th>Unit</th>
                <th className={right}>Qty</th>
                <th className={right}>Rate</th>
                <th className={right}>GST %</th>
                <th className={right}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.position}>
                  <td>{l.position}</td>
                  <td>{l.description}</td>
                  <td>{l.hsn ?? ''}</td>
                  <td>{l.unit}</td>
                  <td className={right}>{num(l.qty)}</td>
                  <td className={right}>{formatInr(l.rate)}</td>
                  <td className={right}>{num(l.gstPct)}</td>
                  <td className={right}>{formatInr(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <Total label="Value of supply" value={r.subtotal} />
              {Number(r.cgst) ? <Total label="CGST" value={r.cgst} /> : null}
              {Number(r.sgst) ? <Total label="SGST" value={r.sgst} /> : null}
              {Number(r.igst) ? <Total label="IGST" value={r.igst} /> : null}
              <Total label="Total" value={r.total} strong />
            </tfoot>
          </PrintTable>
          <p className="text-sm italic">{rupeesInWords(r.total)}</p>
          <Terms
            rows={[
              ['Payment', r.paymentTerms],
              ['Delivery', r.deliveryTerms],
              ['Other terms', r.otherTerms],
            ]}
          />
          <p className="text-sm">
            Please quote the order number on your challan and invoice, and acknowledge this order.
          </p>
        </>
      ) : null}
    </PrintSheet>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className={strong ? 'font-bold' : undefined}>
      <td colSpan={7} className="text-right">
        {label}
      </td>
      <td className="text-right">{formatInr(value)}</td>
    </tr>
  );
}

function Terms({ rows }: { rows: [string, string][] }) {
  const some = rows.filter(([, v]) => v.trim());
  if (some.length === 0) return null;
  return (
    <section className="break-inside-avoid">
      <h2 className="mb-1 text-sm font-bold uppercase">Terms</h2>
      <Particulars rows={some} />
    </section>
  );
}

const INSPECTION: Record<string, string> = {
  gate: 'At the gate',
  hold: 'On hold',
  inspected: 'Inspected',
};

export function ReceiptPrint({ receiptId }: { receiptId: string }) {
  const receipt = useQuery({
    queryKey: ['receipt', receiptId],
    queryFn: () => api.request<Receipt>(`/api/tenant/receipts/${receiptId}`),
  });
  const entity = useProjectEntity(receipt.data?.project.id);
  if (!receipt.data) return <Loading q={receipt} />;
  const g = receipt.data;
  return (
    <PrintSheet
      entityId={entity.data}
      title={`Goods receipt note${g.status === 'cancelled' ? ' (cancelled)' : ''}`}
      meta={
        <>
          <div className="font-mono font-semibold">{g.number}</div>
          <div>{shortDate(g.receivedOn)}</div>
        </>
      }
      signature={false}
      receiver={`Received by${g.receivedBy ? `: ${g.receivedBy}` : ''}`}
    >
      <Particulars
        rows={[
          [
            'Supplier',
            [g.vendor.name, g.vendor.gstin && `GSTIN ${g.vendor.gstin}`]
              .filter(Boolean)
              .join(' · '),
          ],
          ['Order', g.order.number],
          ['Project', `${g.project.number} ${g.project.name}`],
          ['Site / store', [g.site?.name, g.store?.name].filter(Boolean).join(' / ')],
          [
            'Challan',
            [g.challanNo, g.challanDate && shortDate(g.challanDate)].filter(Boolean).join(' of '),
          ],
          ['Invoice', g.invoiceNo ?? ''],
          ['Vehicle', g.vehicleNo ?? ''],
          ['Notes', g.notes],
        ]}
      />
      <PrintTable>
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th>Unit</th>
            <th className={right}>Received</th>
            <th className={right}>Accepted</th>
            <th className={right}>Rejected</th>
            <th>Inspection</th>
          </tr>
        </thead>
        <tbody>
          {g.lines.map((l) => (
            <tr key={l.position}>
              <td>{l.position}</td>
              <td>
                {l.description}
                {l.rejectionReason ? (
                  <div className="text-[8.5pt] italic">Rejected: {l.rejectionReason}</div>
                ) : null}
              </td>
              <td>{l.unit}</td>
              <td className={right}>{num(l.qty)}</td>
              <td className={right}>{num(l.accepted)}</td>
              <td className={right}>{Number(l.rejected) ? num(l.rejected) : ''}</td>
              <td>{INSPECTION[l.inspection] ?? l.inspection}</td>
            </tr>
          ))}
        </tbody>
      </PrintTable>
      <Signatures names={['Checked by (quality)', 'Store keeper']} />
    </PrintSheet>
  );
}

export function IssuePrint({ issueId }: { issueId: string }) {
  const issue = useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => api.request<Issue>(`/api/tenant/issues/${issueId}`),
  });
  const entity = useProjectEntity(issue.data?.project.id);
  if (!issue.data) return <Loading q={issue} />;
  const i = issue.data;
  const value = i.lines.reduce((n, l) => n + Number(l.value), 0);
  return (
    <PrintSheet
      entityId={entity.data}
      title="Store issue slip"
      meta={
        <>
          <div className="font-mono font-semibold">{i.number}</div>
          <div>{shortDate(i.issuedOn)}</div>
        </>
      }
      signature={false}
      receiver={`Received by: ${i.issuedTo}`}
    >
      <Particulars
        rows={[
          ['Store', i.store.name],
          ['Project', `${i.project.number} ${i.project.name}`],
          ['For work', `${i.wbs.code} ${i.wbs.name}`],
          ['Issued to', i.issuedTo],
          ['Purpose', i.purpose],
          ['Issued by', i.issuedBy ?? ''],
        ]}
      />
      <PrintTable>
        <thead>
          <tr>
            <th>#</th>
            <th>Code</th>
            <th>Material</th>
            <th>BOQ item</th>
            <th>Unit</th>
            <th className={right}>Qty</th>
            <th className={right}>Value</th>
          </tr>
        </thead>
        <tbody>
          {i.lines.map((l) => (
            <tr key={l.position}>
              <td>{l.position}</td>
              <td className="font-mono">{l.code}</td>
              <td>{l.name}</td>
              <td>{l.boqCode ?? ''}</td>
              <td>{l.unit}</td>
              <td className={right}>{num(l.qty)}</td>
              <td className={right}>{formatInr(l.value)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <td colSpan={6} className="text-right">
              Total
            </td>
            <td className="text-right">{formatInr(String(value))}</td>
          </tr>
        </tfoot>
      </PrintTable>
      <Signatures names={['Store keeper', 'Site engineer']} />
    </PrintSheet>
  );
}

/** Boxes for the people who sign a document by hand. */
export function Signatures({ names }: { names: ReactNode[] }) {
  return (
    <div className="mt-10 flex justify-between gap-6 break-inside-avoid text-sm">
      {names.map((n, k) => (
        <div key={k} className="w-48 border-t border-black pt-1 text-center">
          {n}
        </div>
      ))}
    </div>
  );
}
