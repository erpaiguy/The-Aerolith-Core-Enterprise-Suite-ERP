// Debit notes from the stores (docs/wave8-plan.md step 8a.5): what the orders and the stores say suppliers should be
// debited — billed beyond what was accepted (once goods went back or the order closed), or above the order's rate —
// raised in one step.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
  Table,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../../api/client';
import { useCompany } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';
import { CompanyPicker } from './Vouchers';

interface Proposals {
  proposals: {
    key: string;
    kind: 'short' | 'rate';
    bill: { id: string; billNo: string; party: string; outstanding: string };
    order: string;
    description: string;
    unit: string;
    qty: string;
    rate: string;
    taxable: string;
    gstPct: string;
    reason: string;
  }[];
  mayPost: boolean;
}
const right = 'text-right';

export function DebitProposalsScreen() {
  const qc = useQueryClient();
  const { company, choose } = useCompany();
  const key = ['debit-proposals', company?.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Proposals>(`/api/tenant/accounts/debit-note-proposals?entityId=${company!.id}`),
    enabled: !!company,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const raise = async (p: Proposals['proposals'][number]) => {
    const k = p.key;
    if (
      !(await confirm({
        title: `Raise a debit note on ${p.bill.party}'s bill ${p.bill.billNo}?`,
        body: `A debit note for ${formatInr(p.taxable)} plus GST is posted to the books against the bill.`,
        confirmLabel: 'Raise the debit note',
        tone: 'primary',
      }))
    )
      return;
    setBusy(k);
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Proposals>('/api/tenant/accounts/debit-note-proposals', {
          method: 'POST',
          body: { entityId: company!.id, key: k },
        }),
      );
      toast.success(`Debit note raised on bill ${p.bill.billNo}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Debit notes to raise"
        subtitle="Bills for more than the stores accepted, or above the order's rate."
        actions={company ? <CompanyPicker value={company.id} onChange={choose} /> : null}
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <Card>
          {q.data.proposals.length === 0 ? (
            <EmptyState title="Nothing to debit: the bills match the orders.">
              Bills billed beyond what the stores accepted, or above the order&apos;s rate, show
              here.
            </EmptyState>
          ) : (
            <Table minWidth="52rem">
              <thead>
                <tr>
                  <th>Supplier and bill</th>
                  <th>Why</th>
                  <th className={right}>Quantity</th>
                  <th className={right}>At</th>
                  <th className={right}>Taxable</th>
                  <th />
                </tr>
              </thead>
              <tbody aria-label="Debit notes to raise">
                {q.data.proposals.map((p) => (
                  <tr key={p.key}>
                    <td>
                      {p.bill.party}
                      <div className="text-xs">
                        <Link
                          to="/accounts/vendor-bills/$billId"
                          params={{ billId: p.bill.id }}
                          className="hover:underline"
                        >
                          {p.bill.billNo}
                        </Link>{' '}
                        <span className="text-fg-muted">· {p.order}</span>
                      </div>
                    </td>
                    <td>
                      <Badge tone="warning">
                        {p.kind === 'short' ? 'billed beyond accepted' : 'above order rate'}
                      </Badge>
                      <div className="text-xs text-fg-muted">{p.reason}</div>
                    </td>
                    <td className={right}>
                      {Number(p.qty).toLocaleString('en-IN')} {p.unit}
                    </td>
                    <td className={right}>{formatInr(p.rate)}</td>
                    <td className={right}>
                      {formatInr(p.taxable)}
                      <div className="text-xs text-fg-muted">+ GST {Number(p.gstPct)}%</div>
                    </td>
                    <td className={right}>
                      {q.data.mayPost ? (
                        <Button
                          variant="secondary"
                          busy={busy === p.key}
                          onClick={() => void raise(p)}
                        >
                          Raise
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
