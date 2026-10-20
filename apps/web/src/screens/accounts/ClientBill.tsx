// A client RA bill (docs/wave3-plan.md step 2): its items with previous, this-bill and cumulative quantities, the
// escalation indices and other deductions while it is a draft; submitted; certified by the client (often for less),
// when it becomes a tax invoice and posts to the books. Printable, and as Excel.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  cx,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, FileSpreadsheet, Plus, Printer, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, saveFile } from '../../api/client';
import { BILL_STATUS, BILL_TONE, type ClientBill, type Figures } from '../../accounts/bills';
import { ledgerOptions, today, useChart } from '../../accounts/model';
import { formatQty } from '../../boq/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { ClientBillGst } from './Gst';
import { printLink } from '../../print/Letterhead';

const n = (v: string | null | undefined) => Number(v ?? 0);
const q = (v: number) => formatQty(String(Math.round(v * 10000) / 10000));

export function ClientBillScreen({ billId }: { billId: string }) {
  const qc = useQueryClient();
  const key = ['client-bill', billId];
  const b = useQuery({
    queryKey: key,
    queryFn: () => api.request<ClientBill>(`/api/tenant/client-bills/${billId}`),
  });
  if (b.isPending) return <Spinner />;
  if (b.isError) return <Alert tone="danger">{describeError(b.error)}</Alert>;
  return (
    <BillView
      key={b.data.rowVersion}
      b={b.data}
      onChanged={(next) => {
        qc.setQueryData(key, next);
        void qc.invalidateQueries({ queryKey: ['client-bills', next.project.id] });
      }}
    />
  );
}

function BillView({ b, onChanged }: { b: ClientBill; onChanged: (next: ClientBill) => void }) {
  const [cum, setCum] = useState<Record<string, string>>(() =>
    Object.fromEntries(b.lines.map((l) => [l.lineKey, l.cumQty])),
  );
  const [cert, setCert] = useState<Record<string, string>>(() =>
    Object.fromEntries(b.lines.map((l) => [l.lineKey, l.cumQty])),
  );
  const [indices, setIndices] = useState<Record<string, string>>(b.indices);
  const [deductions, setDeductions] = useState(
    b.deductions.map((d) => ({
      description: d.description,
      amount: d.amount,
      accountId: d.account.id,
    })),
  );
  const [certifiedOn, setCertifiedOn] = useState(today());
  const [clientRef, setClientRef] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chart = useChart({ ifAllowed: true });
  const confirm = useConfirm();
  const run = async (k: string, path: string, body: object, said: string) => {
    setBusy(k);
    setError(null);
    try {
      onChanged(
        await api.request<ClientBill>(`/api/tenant/client-bills/${b.id}${path}`, {
          method: 'POST',
          body,
        }),
      );
      toast.success(said);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run(
      'save',
      '',
      {
        rowVersion: b.rowVersion,
        indices: Object.fromEntries(Object.entries(indices).filter(([, v]) => v !== '')),
        lines: b.lines
          .filter((l) => cum[l.lineKey] !== l.cumQty)
          .map((l) => ({ lineKey: l.lineKey, cumQty: cum[l.lineKey] })),
        deductions,
      },
      `RA bill ${b.raNo} saved`,
    );
  const dirty =
    b.mayEdit &&
    (b.lines.some((l) => cum[l.lineKey] !== l.cumQty) ||
      JSON.stringify(indices) !== JSON.stringify(b.indices) ||
      JSON.stringify(deductions) !==
        JSON.stringify(
          b.deductions.map((d) => ({
            description: d.description,
            amount: d.amount,
            accountId: d.account.id,
          })),
        ));
  const shown = b.certified ?? b.submitted ?? b.figures;
  const certified = b.status === 'certified';
  const excel = () =>
    void api
      .download(`/api/tenant/client-bills/${b.id}/xlsx`)
      .then(({ blob, fileName }) => saveFile(blob, fileName))
      .catch((err: unknown) => setError(describeError(err)));

  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId: b.project.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> {b.project.number} · {b.project.name}
      </Link>
      <PageHeader
        title={`RA bill ${b.raNo}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={BILL_TONE[b.status]}>{BILL_STATUS[b.status]}</Badge>
            <span>Measured up to {shortDate(b.upto)}</span>
            {b.invoiceNo && (
              <span className="font-mono text-xs">
                Tax invoice {b.invoiceNo} of {shortDate(b.invoiceDate!)}
              </span>
            )}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button type="button" variant="secondary" onClick={excel}>
              <FileSpreadsheet className="size-4" aria-hidden /> Excel
            </Button>
            <Link to="/print/client-bills/$billId" params={{ billId: b.id }} className={printLink}>
              <Printer className="size-4" aria-hidden /> Print
            </Link>
            {b.mayCancel && (
              <Button
                type="button"
                variant="ghost"
                busy={busy === 'cancel'}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Cancel RA bill ${b.raNo}?`,
                      body: 'The bill is cancelled for good and can no longer be submitted or certified. You will be asked why.',
                      confirmLabel: 'Cancel the bill',
                      tone: 'danger',
                    }))
                  )
                    return;
                  const reason = window.prompt('Why is the bill cancelled?');
                  if (reason && reason.trim().length >= 3)
                    void run(
                      'cancel',
                      '/cancel',
                      { reason: reason.trim() },
                      `RA bill ${b.raNo} cancelled`,
                    );
                }}
              >
                Cancel bill
              </Button>
            )}
          </div>
        }
      />
      {b.statusReason && (
        <Alert tone={b.status === 'cancelled' ? 'info' : 'warning'}>
          {b.status === 'cancelled' ? 'Cancelled' : 'Sent back'}: {b.statusReason}
        </Alert>
      )}
      {b.status === 'pending' && (
        <Alert tone="warning">
          Waiting for approval.{' '}
          {b.approval && (
            <Link
              to="/approvals/$approvalId"
              params={{ approvalId: b.approval.id }}
              className="underline"
            >
              The request
            </Link>
          )}
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">From</dt>
          <dd>
            {b.company.legalName || b.company.name}, GSTIN {b.company.gstin ?? '-'}
          </dd>
          <dt className="text-fg-muted">To</dt>
          <dd>
            {b.client?.name ?? '-'}
            {b.client?.gstin && `, GSTIN ${b.client.gstin}`}
          </dd>
          <dt className="text-fg-muted">Place of supply</dt>
          <dd>
            {b.site.name} (state {b.site.stateCode}): {b.intra ? 'CGST and SGST' : 'IGST'}
          </dd>
          {b.clientRef && (
            <>
              <dt className="text-fg-muted">Client's certificate</dt>
              <dd>
                {b.clientRef}
                {b.certifiedOn && `, ${shortDate(b.certifiedOn)}`}
              </dd>
            </>
          )}
        </dl>
      </Card>
      <Card title="Items">
        <Table minWidth="56rem">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Previous</th>
              <th className="text-right">Billed to date</th>
              <th className="text-right">This bill</th>
              {(b.mayCertify || certified) && <th className="text-right">Certified to date</th>}
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody aria-label="Bill items">
            {b.lines.map((l) => {
              const c = b.mayEdit
                ? n(cum[l.lineKey])
                : certified
                  ? n(l.certQty ?? l.cumQty)
                  : n(l.cumQty);
              const thisQty = c - n(l.prevQty);
              const short = certified && l.certQty !== null && n(l.certQty) !== n(l.cumQty);
              return (
                <tr key={l.lineKey}>
                  <td>
                    <span className="font-mono text-xs text-fg-muted">{l.code}</span>{' '}
                    {l.description} <span className="text-xs text-fg-muted">{l.unit}</span>
                    {n(l.measuredQty) !== n(l.cumQty) && (
                      <div className="text-xs text-fg-muted">
                        Measured to date {q(n(l.measuredQty))}
                      </div>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{rupees(l.rate)}</td>
                  <td className="text-right tabular-nums">{q(n(l.prevQty))}</td>
                  <td className="text-right tabular-nums">
                    {b.mayEdit ? (
                      <Input
                        aria-label={`Cumulative ${l.description}`}
                        className="ml-auto w-24 text-right"
                        value={cum[l.lineKey]}
                        onChange={(e) => setCum({ ...cum, [l.lineKey]: e.target.value })}
                      />
                    ) : (
                      q(n(l.cumQty))
                    )}
                  </td>
                  <td className="text-right tabular-nums">{q(thisQty)}</td>
                  {(b.mayCertify || certified) && (
                    <td
                      className={cx('text-right tabular-nums', short && 'font-medium text-warning')}
                    >
                      {b.mayCertify ? (
                        <Input
                          aria-label={`Certified ${l.description}`}
                          className="ml-auto w-24 text-right"
                          value={cert[l.lineKey]}
                          onChange={(e) => setCert({ ...cert, [l.lineKey]: e.target.value })}
                        />
                      ) : (
                        q(n(l.certQty ?? l.cumQty))
                      )}
                    </td>
                  )}
                  <td className="text-right tabular-nums">
                    {rupees((Math.round(thisQty * n(l.rate) * 100) / 100).toFixed(2))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
      {b.mayEdit && (
        <Card title="On this bill">
          <div className="space-y-4">
            {(b.terms.escalation?.components.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-3">
                {b.terms.escalation!.components.map((c) => (
                  <Field
                    key={c.key}
                    label={`${c.name} index (base ${c.baseIndex})`}
                    hint={
                      b.autoIndices?.[c.key]
                        ? `From the series: ${Number(b.autoIndices[c.key])}`
                        : c.seriesKey
                          ? 'The series lacks a month of this period'
                          : undefined
                    }
                  >
                    <Input
                      className="w-32"
                      value={indices[c.key] ?? ''}
                      placeholder={
                        b.autoIndices?.[c.key] ? String(Number(b.autoIndices[c.key])) : ''
                      }
                      onChange={(e) => setIndices({ ...indices, [c.key]: e.target.value })}
                    />
                  </Field>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <div className="text-sm font-medium">Other deductions by the client</div>
              {deductions.map((d, i) => (
                <fieldset
                  key={i}
                  aria-label={`Deduction ${i + 1}`}
                  className="grid gap-2 sm:grid-cols-[1fr_9rem_16rem_auto]"
                >
                  <Input
                    aria-label="What"
                    placeholder="Labour welfare cess 1%"
                    value={d.description}
                    onChange={(e) =>
                      setDeductions(
                        deductions.map((x, j) =>
                          j === i ? { ...x, description: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label="Amount"
                    className="text-right"
                    value={d.amount}
                    onChange={(e) =>
                      setDeductions(
                        deductions.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                      )
                    }
                  />
                  <Select
                    aria-label="Ledger"
                    value={d.accountId}
                    onChange={(e) =>
                      setDeductions(
                        deductions.map((x, j) =>
                          j === i ? { ...x, accountId: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    <option value="">Posts to which ledger?</option>
                    {ledgerOptions(
                      (chart.data?.accounts ?? []).filter((a) => a.kind !== 'party'),
                    ).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Remove deduction ${i + 1}`}
                    onClick={() => setDeductions(deductions.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  setDeductions([...deductions, { description: '', amount: '', accountId: '' }])
                }
              >
                <Plus className="size-4" aria-hidden /> Add a deduction
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                busy={busy === 'save'}
                disabled={!dirty}
                onClick={() => void save()}
              >
                Save and work out
              </Button>
              <Button
                type="button"
                variant="secondary"
                busy={busy === 'refresh'}
                onClick={async () => {
                  if (
                    await confirm({
                      title: 'Take the measurement book again?',
                      body: 'Quantities typed in here are lost and replaced by the measurement book.',
                      confirmLabel: 'Take the book again',
                      tone: 'danger',
                    })
                  )
                    void run(
                      'refresh',
                      '/refresh',
                      { upto: b.upto },
                      'Quantities taken from the measurement book',
                    );
                }}
              >
                Take the measurement book again
              </Button>
              <Button
                type="button"
                variant="secondary"
                busy={busy === 'submit'}
                disabled={dirty}
                onClick={() =>
                  void run(
                    'submit',
                    '/submit',
                    { rowVersion: b.rowVersion },
                    `RA bill ${b.raNo} submitted to the client`,
                  )
                }
              >
                Submit the bill
              </Button>
            </div>
            {dirty && (
              <p className="text-sm text-fg-muted">
                Save the changes to see the figures and submit.
              </p>
            )}
          </div>
        </Card>
      )}
      {b.mayCertify && (
        <Card title="The client's certificate">
          <form
            aria-label="Certify"
            className="space-y-3"
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (
                !(await confirm({
                  title: `Record the client's certificate for RA bill ${b.raNo}?`,
                  body: 'The bill becomes a tax invoice and is posted to the books. It cannot be edited afterwards.',
                  confirmLabel: 'Record and post',
                  tone: 'primary',
                }))
              )
                return;
              void run(
                'certify',
                '/certify',
                {
                  rowVersion: b.rowVersion,
                  certifiedOn,
                  clientRef,
                  lines: b.lines
                    .filter((l) => cert[l.lineKey] !== l.cumQty)
                    .map((l) => ({ lineKey: l.lineKey, certQty: cert[l.lineKey] })),
                },
                `RA bill ${b.raNo} certified and posted`,
              );
            }}
          >
            <p className="text-sm text-fg-muted">
              Change the certified quantities above where the client certified less. Certifying
              makes the bill a tax invoice and posts it to the books.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Certified on">
                <Input
                  type="date"
                  value={certifiedOn}
                  min={b.upto}
                  onChange={(e) => setCertifiedOn(e.target.value)}
                  required
                  className="w-40"
                />
              </Field>
              <Field label="Certificate no.">
                <Input
                  value={clientRef}
                  onChange={(e) => setClientRef(e.target.value)}
                  maxLength={100}
                />
              </Field>
              <Button type="submit" busy={busy === 'certify'}>
                Record the certificate
              </Button>
            </div>
          </form>
        </Card>
      )}
      <ClientBillGst billId={b.id} certified={certified} />
      {shown && (
        <Abstract
          f={shown}
          title={
            certified
              ? 'Abstract, as certified'
              : b.submitted
                ? 'Abstract, as submitted'
                : 'Abstract'
          }
          others={b.deductions.map((d) => ({ label: d.description, amount: d.amount }))}
          extra={
            certified && b.submitted && b.submitted.net !== b.certified!.net ? (
              <p className="text-sm text-warning">
                Submitted for {rupees(b.submitted.net)} net; certified {rupees(b.certified!.net)}:{' '}
                {rupees((n(b.submitted.net) - n(b.certified!.net)).toFixed(2))} less.
              </p>
            ) : null
          }
          voucherId={b.voucherId}
          receipts={b.receipts}
        />
      )}
    </div>
  );
}

function Abstract({
  f,
  title,
  others,
  extra,
  voucherId,
  receipts = [],
}: {
  f: Figures;
  title: string;
  others: { label: string; amount: string }[];
  extra: ReactNode;
  voucherId: string | null;
  receipts?: { id: string; receivedOn: string; amount: string; voucher: string }[];
}) {
  const row = (label: string, v: string, strong = false, show = n(v) !== 0) =>
    show && (
      <tr className={cx(strong && 'font-semibold')}>
        <td>{label}</td>
        <td className="text-right tabular-nums">{rupees(v)}</td>
      </tr>
    );
  return (
    <Card title={title}>
      <Table minWidth="24rem">
        <tbody aria-label="Abstract">
          {row('Value of work done this bill', f.gross, true, true)}
          {f.escalation.map((e) => row(`Escalation: ${e.name}`, e.amount))}
          {row('Taxable value', f.taxable, true, true)}
          {row('CGST', f.cgst)}
          {row('SGST', f.sgst)}
          {row('IGST', f.igst)}
          {row('Invoice total', f.invoiceTotal, true, true)}
          {row('Less: retention', f.retention)}
          {row('Less: mobilisation advance recovered', f.advanceRecovery)}
          {others.map((o) => row(`Less: ${o.label}`, o.amount))}
          {row('Net payable', f.net, true, true)}
        </tbody>
      </Table>
      <div className="mt-3 space-y-1">
        {extra}
        {n(f.advanceLeftAfter) > 0 && (
          <p className="text-xs text-fg-muted">
            Advance still to recover: {rupees(f.advanceLeftAfter)}
          </p>
        )}
        {receipts.length > 0 && (
          <p className="text-sm" aria-label="Received against the bill">
            Received:{' '}
            {receipts.map((r, i) => (
              <span key={r.id}>
                {i > 0 && '; '}
                <Link
                  to="/accounts/client-receipts/$receiptId"
                  params={{ receiptId: r.id }}
                  className="text-accent hover:underline"
                >
                  {rupees(r.amount)} on {shortDate(r.receivedOn)}
                </Link>
              </span>
            ))}{' '}
            — outstanding{' '}
            {rupees((n(f.net) - receipts.reduce((s, r) => s + n(r.amount), 0)).toFixed(2))}
          </p>
        )}
        {voucherId && (
          <Link
            to="/accounts/vouchers/$voucherId"
            params={{ voucherId }}
            className="text-sm text-accent hover:underline print:hidden"
          >
            The voucher in the books
          </Link>
        )}
      </div>
    </Card>
  );
}
