// The printed page (docs/wave7-plan.md step 7b.1): every document the business prints (orders, receipts, bills,
// letters, reports) on A4 under its company's letterhead, signed for the company, with its footer. Printed or saved
// as PDF from the browser: no PDF library, nothing paid.
import { Alert, Button, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';

export interface Letterhead {
  id: string;
  name: string;
  legalName: string;
  address: string;
  city: string;
  pincode: string | null;
  gstin: string | null;
  pan: string | null;
  phone: string;
  email: string;
  website: string;
  footer: string;
  signatoryName: string;
  signatoryTitle: string;
  logo: string | null;
  mayEdit: boolean;
}

export const useLetterhead = (entityId: string | null | undefined) =>
  useQuery({
    queryKey: ['letterhead', entityId],
    queryFn: () => api.request<Letterhead>(`/api/tenant/companies/${entityId}/letterhead`),
    enabled: !!entityId,
  });

/** The company block at the top of the page. */
export function LetterheadBlock({ l }: { l: Letterhead }) {
  const place = [l.address, [l.city, l.pincode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const contact = [l.phone, l.email, l.website].filter(Boolean).join(' · ');
  const tax = [l.gstin && `GSTIN ${l.gstin}`, l.pan && `PAN ${l.pan}`].filter(Boolean).join(' · ');
  return (
    <header className="flex items-start gap-4 border-b-2 border-black pb-3" aria-label="Letterhead">
      {l.logo ? (
        <img src={l.logo} alt="" className="h-16 w-auto max-w-[35%] object-contain" />
      ) : null}
      <div className="min-w-0 flex-1 text-right">
        <div className="text-xl font-bold leading-tight">{l.legalName || l.name}</div>
        {place ? <div className="text-xs">{place}</div> : null}
        {contact ? <div className="text-xs">{contact}</div> : null}
        {tax ? <div className="text-xs">{tax}</div> : null}
      </div>
    </header>
  );
}

/**
 * One printed document: letterhead, a title with its number and date, the body, the company's signature block and
 * footer. On screen it sits on a grey desk with Print and Back; on paper only the page prints.
 */
export function PrintSheet({
  entityId,
  title,
  meta,
  children,
  signature = true,
  receiver,
  bare = false,
}: {
  entityId: string | null | undefined;
  title: string;
  /** Number, date and the like, shown right of the title. */
  meta?: ReactNode;
  children: ReactNode;
  /** The company's signatory at the foot (off for a document someone else signs). */
  signature?: boolean;
  /** A second signature box, for the receiver (a receipt, a slip). */
  receiver?: string;
  /** One of several sheets on a desk (a payment run's advices): no desk of its own. */
  bare?: boolean;
}) {
  const head = useLetterhead(entityId);
  const sheet = (
    <article
      aria-label={title}
      className="mx-auto mb-6 max-w-[210mm] break-after-page bg-white p-[14mm] text-[11pt] text-black shadow last:mb-0 print:mb-0 print:max-w-none print:p-0 print:shadow-none"
    >
      {head.isPending && entityId ? (
        <Spinner />
      ) : head.isError ? (
        <Alert tone="danger">{describeError(head.error)}</Alert>
      ) : head.data ? (
        <LetterheadBlock l={head.data} />
      ) : null}
      <div className="mb-4 mt-4 flex items-end justify-between gap-4">
        <h1 className="text-lg font-bold uppercase tracking-wide">{title}</h1>
        {meta ? <div className="text-right text-sm">{meta}</div> : null}
      </div>
      <div className="space-y-4">{children}</div>
      {signature || receiver ? (
        <div className="mt-12 flex justify-between gap-8 break-inside-avoid text-sm">
          {receiver ? <div className="w-56 border-t border-black pt-1">{receiver}</div> : <span />}
          {signature && head.data ? (
            <div className="w-64 text-right">
              <div>For {head.data.legalName || head.data.name}</div>
              <div className="mt-12 border-t border-black pt-1">
                {head.data.signatoryName || 'Authorised signatory'}
                {head.data.signatoryTitle ? (
                  <div className="text-xs">{head.data.signatoryTitle}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {head.data?.footer ? (
        <footer className="mt-8 border-t border-black pt-2 text-center text-[8pt]">
          {head.data.footer}
        </footer>
      ) : null}
    </article>
  );
  return bare ? sheet : <PrintDesk>{sheet}</PrintDesk>;
}

/** The grey desk the sheets lie on, with Back and Print; on paper only the sheets print. */
export function PrintDesk({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface-2 py-6 print:bg-white print:py-0">
      <style>{'@page { size: A4; margin: 14mm; }'}</style>
      <div className="mx-auto mb-4 flex max-w-[210mm] gap-2 px-4 print:hidden">
        <Button type="button" variant="secondary" onClick={() => history.back()}>
          <ArrowLeft className="size-4" aria-hidden /> Back
        </Button>
        <Button type="button" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print or save as PDF
        </Button>
      </div>
      {children}
    </div>
  );
}

/** The company a document names only by name (a receipt, a payment run): names are unique in a tenant. */
export function useEntityByName(name: string | undefined) {
  return useQuery({
    queryKey: ['companies'],
    queryFn: () =>
      api.request<{ companies: { id: string; name: string }[] }>('/api/tenant/companies'),
    enabled: !!name,
    select: (r) => r.companies.find((c) => c.name === name)?.id ?? null,
  });
}

/** Rows of label and value for a document's particulars (to, ref, dates…). */
export function Particulars({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-0.5 text-sm">
      {rows
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-medium">{k}</dt>
            <dd className="whitespace-pre-wrap">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** A printed table: ruled, header repeated on each page. */
export function PrintTable({ children }: { children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-[9.5pt] [&_td]:border [&_td]:border-black [&_td]:px-1.5 [&_td]:py-1 [&_th]:border [&_th]:border-black [&_th]:bg-neutral-100 [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_thead]:table-header-group">
      {children}
    </table>
  );
}

/** A "Print" link that opens a document's print page: looks like the app's secondary button. */
export const printLink =
  'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2';

/** The sample page for the letterhead setup. */
export function LetterheadSample({ entityId }: { entityId: string }) {
  return (
    <PrintSheet entityId={entityId} title="Sample" meta="Ref: SAMPLE/001">
      <p>
        This is how the company's documents will print: letterhead, title, body, signature and
        footer.
      </p>
    </PrintSheet>
  );
}
