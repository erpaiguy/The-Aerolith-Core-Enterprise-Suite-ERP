// Real estate sales and RERA (docs/wave6-plan.md step 2): a project's inventory by tower and floor, bookings with
// their demands and receipts, the payment plan and its milestones, and the RERA designated account.
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
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, saveFile } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';
import { printLink } from '../../print/Letterhead';
import { Link } from '@tanstack/react-router';

interface Overview {
  setup: {
    reraNumber: string;
    collectionAccountId: string | null;
    designatedAccountId: string | null;
    sharePct: string;
    interestPct: string;
    payDays: number;
  };
  towers: { id: string; name: string; floors: number }[];
  units: {
    id: string;
    towerId: string;
    floor: number;
    number: string;
    kind: string;
    carpetSqm: string;
    status: string;
    value: string;
    booking: string | null;
    buyer: string | null;
  }[];
  plan: {
    id: string;
    position: number;
    name: string;
    pct: string;
    trigger: string;
    tower: string | null;
    reachedOn: string | null;
  }[];
  planTotal: string;
}
interface Booking {
  id: string;
  number: string;
  status: string;
  value: string;
  unit: string;
  buyer: string;
  bookedOn: string;
  agreementOn: string | null;
  demands: {
    id: string;
    number: string;
    kind: 'stage' | 'interest' | 'charge';
    stage: string | null;
    raisedOn: string;
    dueOn: string;
    total: string;
    paid: string;
    open: string;
    overdue: boolean;
  }[];
  receipts: { number: string; receivedOn: string; amount: string; reraShare: string }[];
  totals: { demanded: string; received: string; outstanding: string; interestDue: string };
  /** After the sale (docs/wave8-plan.md step 8f.1). */
  cancelledOn: string | null;
  cancelReason: string;
  forfeited: string;
  refunded: string;
  refundDue: string;
  creditNotes: { number: string; demand: string; issuedOn: string; base: string; gst: string }[];
  transfers: { on: string; from: string; to: string; fee: string }[];
  stampDuty: string | null;
  registrationNo: string;
  registeredOn: string | null;
  subRegistrar: string;
  possessionOfferedOn: string | null;
  possessionOn: string | null;
  defectPeriodEnds: string | null;
}
interface Rera {
  required: string;
  deposited: string;
  shortfall: string;
  withdrawn: string;
  balance: string;
  entries: { kind: string; on: string; amount: string; completionPct: string | null }[];
}
type Tab = 'inventory' | 'bookings' | 'plan' | 'rera' | 'setup';
const tone = (s: string) =>
  s === 'available'
    ? 'success'
    : s === 'agreement'
      ? 'accent'
      : s === 'booked'
        ? 'warning'
        : 'neutral';

export function SalesScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useState('');
  const [tab, setTab] = useState<Tab>('inventory');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Sales and RERA"
        subtitle="Units, bookings, demands by construction milestone, receipts, and the designated account."
        actions={
          <Select
            aria-label="Project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Choose a project…</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} {p.name}
              </option>
            ))}
          </Select>
        }
      />
      <div role="tablist" className="flex flex-wrap gap-1">
        {(
          [
            ['inventory', 'Inventory'],
            ['bookings', 'Bookings'],
            ['plan', 'Payment plan'],
            ['rera', 'RERA account'],
            ['setup', 'Setup'],
          ] as const
        ).map(([k, label]) => (
          <Button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            variant={tab === k ? 'primary' : 'ghost'}
            onClick={() => setTab(k)}
          >
            {label}
          </Button>
        ))}
      </div>
      {projectId && <ProjectSales key={projectId} projectId={projectId} tab={tab} />}
    </div>
  );
}

function ProjectSales({ projectId, tab }: { projectId: string; tab: Tab }) {
  const qc = useQueryClient();
  const base = `/api/tenant/projects/${projectId}/sales`;
  const o = useQuery({
    queryKey: ['sales', projectId],
    queryFn: () => api.request<Overview>(base),
  });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const call = async <T,>(path: string, body: object, done?: string) => {
    setError(null);
    try {
      const r = await api.request<T>(path, { method: 'POST', body });
      if (done) toast.success(done);
      void qc.invalidateQueries({ queryKey: ['sales', projectId] });
      return r;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  };
  if (o.isPending) return <Spinner />;
  if (o.isError) return <Alert tone="danger">{describeError(o.error)}</Alert>;
  const d = o.data;
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {tab === 'inventory' && (
        <Inventory projectId={projectId} d={d} call={call} onBooked={setOpen} />
      )}
      {tab === 'bookings' && (
        <Bookings projectId={projectId} open={open} onOpen={setOpen} call={call} />
      )}
      {tab === 'plan' && <Plan d={d} base={base} call={call} />}
      {tab === 'rera' && <ReraTab projectId={projectId} call={call} />}
      {tab === 'setup' && <Setup d={d} base={base} call={call} />}
    </>
  );
}

type Call = <T>(path: string, body: object, done?: string) => Promise<T | null>;

function Inventory({
  projectId,
  d,
  call,
  onBooked,
}: {
  projectId: string;
  d: Overview;
  call: Call;
  onBooked: (id: string) => void;
}) {
  const [tower, setTower] = useState({ name: '', floors: 10 });
  const [unit, setUnit] = useState({
    towerId: '',
    floor: 1,
    number: '',
    carpetSqm: '',
    ratePerSqm: '',
    parking: '0',
    charges: '0',
    gstPct: '5',
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [buyer, setBuyer] = useState({ name: '', phone: '', pan: '', bookedOn: today() });
  const pick = d.units.find((u) => u.id === picked);
  return (
    <>
      {d.towers.map((t) => {
        const units = d.units.filter((u) => u.towerId === t.id);
        const floors = [...new Set(units.map((u) => u.floor))].sort((a, b) => b - a);
        return (
          <Card key={t.id} title={`Tower ${t.name}`}>
            <div className="space-y-1" aria-label={`Tower ${t.name}`}>
              {floors.map((f) => (
                <div key={f} className="flex flex-wrap items-center gap-1 text-sm">
                  <span className="w-8 text-fg-muted">{f}</span>
                  {units
                    .filter((u) => u.floor === f)
                    .map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        aria-label={`Unit ${t.name}-${u.number}`}
                        onClick={() => setPicked(u.id)}
                        className="rounded border border-line px-2 py-1"
                      >
                        {u.number} <Badge tone={tone(u.status)}>{u.status}</Badge>
                      </button>
                    ))}
                </div>
              ))}
              {units.length === 0 && (
                <EmptyState title="No units yet">
                  Add this tower&apos;s units with the New unit form below.
                </EmptyState>
              )}
            </div>
          </Card>
        );
      })}
      {pick && (
        <Card title={`Unit ${pick.number}`}>
          <p className="text-sm" data-testid="unit-detail">
            {pick.kind}, {pick.carpetSqm} m² carpet · {formatInr(pick.value)} ·{' '}
            <Badge tone={tone(pick.status)}>{pick.status}</Badge>
            {pick.buyer && ` · ${pick.buyer} (${pick.booking})`}
          </p>
          {pick.status === 'available' && (
            <form
              aria-label="Book"
              className="mt-3 grid gap-3 sm:grid-cols-5"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await call<{ id: string }>(
                  `/api/tenant/sales/units/${pick.id}/book`,
                  {
                    buyer: { name: buyer.name, phone: buyer.phone, pan: buyer.pan || null },
                    bookedOn: buyer.bookedOn,
                  },
                  `Unit ${pick.number} booked for ${buyer.name}`,
                );
                if (r) onBooked(r.id);
              }}
            >
              <Field label="Buyer">
                <Input
                  value={buyer.name}
                  onChange={(e) => setBuyer({ ...buyer, name: e.target.value })}
                  required
                  minLength={2}
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={buyer.phone}
                  onChange={(e) => setBuyer({ ...buyer, phone: e.target.value })}
                />
              </Field>
              <Field label="PAN">
                <Input
                  value={buyer.pan}
                  onChange={(e) => setBuyer({ ...buyer, pan: e.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="Booked on">
                <Input
                  type="date"
                  value={buyer.bookedOn}
                  max={today()}
                  onChange={(e) => setBuyer({ ...buyer, bookedOn: e.target.value })}
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit">Book</Button>
              </div>
            </form>
          )}
        </Card>
      )}
      <Card title="Add">
        <TowerForm projectId={projectId} tower={tower} setTower={setTower} call={call} />
        <form
          aria-label="New unit"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await call(
                `/api/tenant/sales/towers/${unit.towerId}/units`,
                {
                  units: [
                    {
                      floor: unit.floor,
                      number: unit.number,
                      carpetSqm: unit.carpetSqm,
                      ratePerSqm: unit.ratePerSqm,
                      parking: unit.parking || '0',
                      charges: unit.charges || '0',
                      gstPct: unit.gstPct,
                    },
                  ],
                },
                `Unit ${unit.number} added`,
              )
            )
              setUnit({ ...unit, number: '' });
          }}
        >
          <Field label="Tower">
            <Select
              value={unit.towerId}
              onChange={(e) => setUnit({ ...unit, towerId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {d.towers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Floor">
            <Input
              type="number"
              value={unit.floor}
              onChange={(e) => setUnit({ ...unit, floor: Number(e.target.value) })}
            />
          </Field>
          <Field label="Unit number">
            <Input
              value={unit.number}
              onChange={(e) => setUnit({ ...unit, number: e.target.value })}
              required
            />
          </Field>
          <Field label="Carpet m²">
            <Input
              inputMode="decimal"
              value={unit.carpetSqm}
              onChange={(e) => setUnit({ ...unit, carpetSqm: e.target.value })}
              required
            />
          </Field>
          <Field label="Rate per m² (₹)">
            <Input
              inputMode="decimal"
              value={unit.ratePerSqm}
              onChange={(e) => setUnit({ ...unit, ratePerSqm: e.target.value })}
              required
            />
          </Field>
          <Field label="Parking (₹)">
            <Input
              value={unit.parking}
              onChange={(e) => setUnit({ ...unit, parking: e.target.value })}
            />
          </Field>
          <Field label="GST">
            <Select
              value={unit.gstPct}
              onChange={(e) => setUnit({ ...unit, gstPct: e.target.value })}
            >
              <option value="5">5% residential</option>
              <option value="1">1% affordable</option>
              <option value="12">12% commercial</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit">Add unit</Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function TowerForm({
  projectId,
  tower,
  setTower,
  call,
}: {
  projectId: string;
  tower: { name: string; floors: number };
  setTower: (t: { name: string; floors: number }) => void;
  call: Call;
}) {
  return (
    <form
      aria-label="Add a tower"
      className="grid gap-3 sm:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await call(
            `/api/tenant/projects/${projectId}/sales/towers`,
            tower,
            `Tower ${tower.name} added`,
          )
        )
          setTower({ name: '', floors: tower.floors });
      }}
    >
      <Field label="Tower name">
        <Input
          value={tower.name}
          onChange={(e) => setTower({ ...tower, name: e.target.value })}
          required
        />
      </Field>
      <Field label="Floors">
        <Input
          type="number"
          min={1}
          value={tower.floors}
          onChange={(e) => setTower({ ...tower, floors: Number(e.target.value) })}
        />
      </Field>
      <div className="flex items-end">
        <Button type="submit">Add tower</Button>
      </div>
    </form>
  );
}

function Bookings({
  projectId,
  open,
  onOpen,
  call,
}: {
  projectId: string;
  open: string | null;
  onOpen: (id: string) => void;
  call: Call;
}) {
  const q = useQuery({
    queryKey: ['sales', projectId, 'bookings'],
    queryFn: () =>
      api.request<
        {
          id: string;
          number: string;
          status: string;
          unit: string;
          buyer: string;
          value: string;
          demanded: string;
          received: string;
          overdue: string;
        }[]
      >(`/api/tenant/projects/${projectId}/sales/bookings`),
  });
  return (
    <>
      <Card title="Bookings">
        {(q.data ?? []).length === 0 ? (
          <EmptyState title="None yet">
            Pick a unit on the Inventory tab and book it for a buyer.
          </EmptyState>
        ) : (
          <Table minWidth="52rem">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Buyer</th>
                <th>Status</th>
                <th className="text-right">Value</th>
                <th className="text-right">Demanded</th>
                <th className="text-right">Received</th>
                <th className="text-right">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.map((b) => (
                <tr key={b.id} aria-label={b.number}>
                  <td>
                    <button type="button" className="underline" onClick={() => onOpen(b.id)}>
                      {b.number}
                    </button>{' '}
                    {b.unit}
                  </td>
                  <td>{b.buyer}</td>
                  <td>
                    <Badge tone={tone(b.status)}>{b.status}</Badge>
                  </td>
                  <td className="text-right tabular-nums">{formatInr(b.value)}</td>
                  <td className="text-right tabular-nums">{formatInr(b.demanded)}</td>
                  <td className="text-right tabular-nums">{formatInr(b.received)}</td>
                  <td className="text-right tabular-nums">
                    {Number(b.overdue) > 0 ? (
                      <span className="text-danger">{formatInr(b.overdue)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {open && <BookingCard key={open} id={open} call={call} />}
    </>
  );
}

function BookingCard({ id, call }: { id: string; call: Call }) {
  const q = useQuery({
    queryKey: ['sales', 'booking', id],
    queryFn: () => api.request<Booking>(`/api/tenant/sales/bookings/${id}`),
  });
  const [agreement, setAgreement] = useState({ on: today(), number: '' });
  const [rcpt, setRcpt] = useState({
    on: today(),
    amount: '',
    reference: '',
    tds: '',
    tdsAck: '',
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const b = q.data;
  const act = async (path: string, body: object, done?: string) => {
    if (await call(`/api/tenant/sales/bookings/${id}/${path}`, body, done)) await q.refetch();
  };
  return (
    <Card
      title={`${b.number} · ${b.unit} · ${b.buyer}`}
      actions={
        <Link to="/print/cost-sheets/$bookingId" params={{ bookingId: b.id }} className={printLink}>
          Cost sheet
        </Link>
      }
    >
      <p className="text-sm" data-testid="booking-totals">
        {formatInr(b.value)} · <Badge tone={tone(b.status)}>{b.status}</Badge> · demanded{' '}
        {formatInr(b.totals.demanded)} · received {formatInr(b.totals.received)} · outstanding{' '}
        {formatInr(b.totals.outstanding)}
        {Number(b.totals.interestDue) > 0 && ` · interest due ${formatInr(b.totals.interestDue)}`}
      </p>
      <Table minWidth="44rem">
        <thead>
          <tr>
            <th>Demand</th>
            <th>For</th>
            <th>Due</th>
            <th className="text-right">Amount</th>
            <th className="text-right">Open</th>
            <th />
          </tr>
        </thead>
        <tbody aria-label="Demands">
          {b.demands.map((d) => (
            <tr key={d.id} className={d.overdue ? 'text-danger' : ''}>
              <td>{d.number}</td>
              <td>{d.stage ?? (d.kind === 'charge' ? 'Transfer fee' : 'Interest')}</td>
              <td>{d.dueOn}</td>
              <td className="text-right tabular-nums">{formatInr(d.total)}</td>
              <td className="text-right tabular-nums">{formatInr(d.open)}</td>
              <td className="text-right">
                <Link
                  to="/print/demands/$bookingId/$demandId"
                  params={{ bookingId: b.id, demandId: d.id }}
                  className="text-sm text-accent hover:underline"
                >
                  Letter
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {b.status === 'booked' && (
        <form
          aria-label="Register the agreement"
          className="mt-3 grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act('agreement', agreement, `Agreement for ${b.number} registered`);
          }}
        >
          <Field label="Registered on">
            <Input
              type="date"
              value={agreement.on}
              onChange={(e) => setAgreement({ ...agreement, on: e.target.value })}
            />
          </Field>
          <Field label="Registration number">
            <Input
              value={agreement.number}
              onChange={(e) => setAgreement({ ...agreement, number: e.target.value })}
              required
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="secondary">
              Register the agreement
            </Button>
          </div>
        </form>
      )}
      {b.status !== 'cancelled' && (
        <form
          aria-label="Receipt"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'receipts',
              {
                on: rcpt.on,
                amount: rcpt.amount,
                reference: rcpt.reference,
                mode: 'neft',
                ...(Number(rcpt.tds) > 0 ? { tds: rcpt.tds, tdsAck: rcpt.tdsAck } : {}),
              },
              `Receipt of ${formatInr(rcpt.amount)} recorded`,
            ).then(() => setRcpt({ ...rcpt, amount: '', reference: '', tds: '', tdsAck: '' }));
          }}
        >
          <Field label="Received on">
            <Input
              type="date"
              value={rcpt.on}
              onChange={(e) => setRcpt({ ...rcpt, on: e.target.value })}
            />
          </Field>
          <Field label="Amount (₹)">
            <Input
              inputMode="decimal"
              value={rcpt.amount}
              onChange={(e) => setRcpt({ ...rcpt, amount: e.target.value })}
              required
            />
          </Field>
          <Field label="UTR or cheque">
            <Input
              value={rcpt.reference}
              onChange={(e) => setRcpt({ ...rcpt, reference: e.target.value })}
            />
          </Field>
          <Field label="Buyer's TDS (₹)" hint="1% under 194-IA">
            <Input
              inputMode="decimal"
              value={rcpt.tds}
              onChange={(e) => setRcpt({ ...rcpt, tds: e.target.value })}
            />
          </Field>
          <Field label="26QB acknowledgement">
            <Input
              value={rcpt.tdsAck}
              onChange={(e) => setRcpt({ ...rcpt, tdsAck: e.target.value })}
              maxLength={40}
              required={Number(rcpt.tds) > 0}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Record receipt</Button>
            {Number(b.totals.interestDue) > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  void act('interest', { on: today() }, `Interest raised on ${b.number}`)
                }
              >
                Raise interest
              </Button>
            )}
          </div>
        </form>
      )}
      <AfterSale b={b} act={act} />
    </Card>
  );
}

const HANDOVER = [
  'Keys handed over',
  'Electricity and water meter readings noted',
  'Society share certificate and papers given',
  'Snags inspected with the buyer',
];

/** Cancellation, transfer, registration, possession and handover of a booking (docs/wave8-plan.md step 8f.1). */
function AfterSale({
  b,
  act,
}: {
  b: Booking;
  act: (path: string, body: object, done?: string) => Promise<void>;
}) {
  const confirm = useConfirm();
  const banks = useQuery({
    queryKey: ['sales', 'banks'],
    queryFn: () =>
      api.request<{ accounts: { id: string; code: string; name: string; kind: string }[] }>(
        '/api/tenant/accounts/chart',
      ),
    select: (r) => r.accounts.filter((a) => a.kind === 'bank'),
  });
  const [cancel, setCancel] = useState({ reason: '', forfeit: '', bank: '' });
  const [nominee, setNominee] = useState({ name: '', pan: '', fee: '' });
  const [reg, setReg] = useState({
    stampDuty: '',
    registrationFee: '',
    registrationNo: '',
    registeredOn: today(),
    subRegistrar: '',
  });
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const live = b.status !== 'cancelled';
  return (
    <div className="mt-4 space-y-4 border-t border-line pt-4" aria-label="After the sale">
      {b.status === 'cancelled' && (
        <p className="text-sm">
          Cancelled on {b.cancelledOn}
          {b.cancelReason && ` (${b.cancelReason})`}: forfeited {formatInr(b.forfeited)}, refunded{' '}
          {formatInr(b.refunded)}
          {Number(b.refundDue) > 0 && `, ${formatInr(b.refundDue)} still to refund`}.
          {b.creditNotes.length > 0 &&
            ` Credit notes ${b.creditNotes.map((c) => `${c.number} (${c.demand})`).join(', ')}.`}
        </p>
      )}
      {b.transfers.length > 0 && (
        <p className="text-sm">
          Transferred:{' '}
          {b.transfers
            .map((t) => `${t.on} ${t.from} to ${t.to} (fee ${formatInr(t.fee)})`)
            .join('; ')}
          .
        </p>
      )}
      {b.registrationNo && (
        <p className="text-sm">
          Sale deed {b.registrationNo} registered {b.registeredOn}
          {b.subRegistrar && ` at ${b.subRegistrar}`}, stamp duty {formatInr(b.stampDuty ?? '0')}.
        </p>
      )}
      {b.possessionOn && (
        <p className="text-sm">
          Handed over on {b.possessionOn}; the defect liability period runs to {b.defectPeriodEnds}{' '}
          (RERA s.14(3)).
        </p>
      )}
      {b.status === 'cancelled' && Number(b.refundDue) > 0 && (
        <form
          aria-label="Refund"
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              !(await confirm({
                title: `Refund ${formatInr(b.refundDue)} on ${b.number}?`,
                body: `The refund to ${b.buyer} is paid from the bank chosen and posted to the books.`,
                confirmLabel: 'Refund the buyer',
                tone: 'danger',
              }))
            )
              return;
            void act(
              'refund',
              { on: today(), fromAccountId: cancel.bank },
              `${formatInr(b.refundDue)} refunded on ${b.number}`,
            );
          }}
        >
          <Field label="Refund from">
            <Select
              value={cancel.bank}
              onChange={(e) => setCancel({ ...cancel, bank: e.target.value })}
              required
            >
              <option value="">Choose a bank…</option>
              {(banks.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">Refund {formatInr(b.refundDue)}</Button>
        </form>
      )}
      {live && b.status === 'agreement' && !b.registrationNo && (
        <form
          aria-label="Sale deed registration"
          className="grid gap-3 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            void act('registration', reg, `Sale deed ${reg.registrationNo} recorded`);
          }}
        >
          <Field label="Stamp duty (₹)">
            <Input
              inputMode="decimal"
              value={reg.stampDuty}
              onChange={(e) => setReg({ ...reg, stampDuty: e.target.value })}
              required
            />
          </Field>
          <Field label="Registration fee (₹)">
            <Input
              inputMode="decimal"
              value={reg.registrationFee}
              onChange={(e) => setReg({ ...reg, registrationFee: e.target.value })}
              required
            />
          </Field>
          <Field label="Document no.">
            <Input
              value={reg.registrationNo}
              onChange={(e) => setReg({ ...reg, registrationNo: e.target.value })}
              required
            />
          </Field>
          <Field label="Registered on">
            <Input
              type="date"
              value={reg.registeredOn}
              onChange={(e) => setReg({ ...reg, registeredOn: e.target.value })}
            />
          </Field>
          <Field label="Sub-registrar">
            <Input
              value={reg.subRegistrar}
              onChange={(e) => setReg({ ...reg, subRegistrar: e.target.value })}
            />
          </Field>
          <div>
            <Button type="submit" variant="secondary">
              Record registration
            </Button>
          </div>
        </form>
      )}
      {live && b.status === 'agreement' && !b.possessionOfferedOn && (
        <Button
          variant="secondary"
          onClick={async () => {
            if (
              !(await confirm({
                title: `Offer possession of ${b.unit}?`,
                body: `The remaining stages of the payment plan are raised on ${b.buyer} as demands.`,
                confirmLabel: 'Offer possession',
                tone: 'primary',
              }))
            )
              return;
            void act('offer-possession', { on: today() }, `Possession of ${b.unit} offered`);
          }}
        >
          Offer possession (raise the remaining stages)
        </Button>
      )}
      {live && b.possessionOfferedOn && !b.possessionOn && (
        <form
          aria-label="Hand over"
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              !(await confirm({
                title: `Hand over ${b.unit} to ${b.buyer}?`,
                body: 'Possession is recorded today and the defect liability period starts.',
                confirmLabel: 'Hand over',
                tone: 'primary',
              }))
            )
              return;
            void act(
              'hand-over',
              {
                on: today(),
                checklist: HANDOVER.map((item) => ({ item, ok: !!checks[item], note: '' })),
              },
              `${b.unit} handed over`,
            );
          }}
        >
          <p className="text-sm">
            Possession offered on {b.possessionOfferedOn}. Hand over against:
          </p>
          {HANDOVER.map((item) => (
            <label key={item} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!checks[item]}
                onChange={(e) => setChecks({ ...checks, [item]: e.target.checked })}
              />
              {item}
            </label>
          ))}
          <Button type="submit">Hand over</Button>
        </form>
      )}
      {live && !b.possessionOn && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Transfer or cancel</summary>
          <form
            aria-label="Transfer to a nominee"
            className="mt-3 grid gap-3 sm:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                !(await confirm({
                  title: `Transfer ${b.number} to ${nominee.name}?`,
                  body: `${nominee.name} becomes the buyer in place of ${b.buyer}; the transfer fee is billed with GST.`,
                  confirmLabel: 'Transfer the booking',
                  tone: 'danger',
                }))
              )
                return;
              void act(
                'transfer',
                {
                  on: today(),
                  buyer: { name: nominee.name, pan: nominee.pan || null },
                  fee: nominee.fee || '0',
                },
                `${b.number} transferred to ${nominee.name}`,
              );
            }}
          >
            <Field label="New buyer">
              <Input
                value={nominee.name}
                onChange={(e) => setNominee({ ...nominee, name: e.target.value })}
                required
                minLength={2}
              />
            </Field>
            <Field label="Their PAN">
              <Input
                value={nominee.pan}
                onChange={(e) => setNominee({ ...nominee, pan: e.target.value.toUpperCase() })}
                pattern="[A-Z]{5}[0-9]{4}[A-Z]"
              />
            </Field>
            <Field label="Transfer fee (₹, + 18% GST)">
              <Input
                inputMode="decimal"
                value={nominee.fee}
                onChange={(e) => setNominee({ ...nominee, fee: e.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="secondary">
                Transfer
              </Button>
            </div>
          </form>
          <form
            aria-label="Cancel the booking"
            className="mt-3 grid gap-3 sm:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                !(await confirm({
                  title: `Cancel booking ${b.number}?`,
                  body: 'Its demands are reversed by credit notes, and the forfeit and refund are booked.',
                  confirmLabel: 'Cancel the booking',
                  tone: 'danger',
                }))
              )
                return;
              void act(
                'cancel',
                {
                  on: today(),
                  reason: cancel.reason,
                  forfeit: cancel.forfeit || '0',
                  refundFromAccountId: cancel.bank || null,
                },
                `Booking ${b.number} cancelled`,
              );
            }}
          >
            <Field label="Why cancelled">
              <Input
                value={cancel.reason}
                onChange={(e) => setCancel({ ...cancel, reason: e.target.value })}
                required
                minLength={3}
              />
            </Field>
            <Field label="Forfeit (₹)" hint={`of ${formatInr(b.totals.received)} received`}>
              <Input
                inputMode="decimal"
                value={cancel.forfeit}
                onChange={(e) => setCancel({ ...cancel, forfeit: e.target.value })}
              />
            </Field>
            <Field label="Refund now from">
              <Select
                value={cancel.bank}
                onChange={(e) => setCancel({ ...cancel, bank: e.target.value })}
              >
                <option value="">Refund later</option>
                {(banks.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="ghost">
                Cancel the booking
              </Button>
            </div>
          </form>
        </details>
      )}
    </div>
  );
}

function Plan({ d, base, call }: { d: Overview; base: string; call: Call }) {
  const confirm = useConfirm();
  const [stages, setStages] = useState(
    d.plan.length
      ? d.plan.map((s) => ({
          name: s.name,
          pct: s.pct,
          trigger: s.trigger,
          towerId: null as string | null,
        }))
      : [
          { name: 'On booking', pct: '10', trigger: 'booking', towerId: null },
          { name: 'On agreement', pct: '20', trigger: 'agreement', towerId: null },
          { name: 'Plinth', pct: '30', trigger: 'milestone', towerId: null },
          { name: 'Possession', pct: '40', trigger: 'milestone', towerId: null },
        ],
  );
  const [reachOn, setReachOn] = useState(today());
  return (
    <>
      <Card title={`Payment plan (${d.planTotal}%)`}>
        <ul className="space-y-1 text-sm" aria-label="Plan">
          {d.plan.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              {s.position}. {s.name}: {s.pct}% on {s.trigger}
              {s.tower && ` (tower ${s.tower})`}
              {s.reachedOn ? (
                <Badge tone="success">reached {s.reachedOn}</Badge>
              ) : (
                s.trigger === 'milestone' && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: `Mark ${s.name} reached on ${reachOn}?`,
                          body: `The ${s.pct}% stage is raised as a demand on every booking it applies to.`,
                          confirmLabel: 'Raise the demands',
                          tone: 'primary',
                        }))
                      )
                        return;
                      void call(
                        `/api/tenant/sales/stages/${s.id}/reached`,
                        { on: reachOn },
                        `${s.name} reached; demands raised`,
                      );
                    }}
                  >
                    Reached on {reachOn}
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
        <Field label="Milestone date">
          <Input
            type="date"
            value={reachOn}
            max={today()}
            onChange={(e) => setReachOn(e.target.value)}
          />
        </Field>
      </Card>
      <Card title="Set the plan">
        <form
          aria-label="Plan stages"
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call(`${base}/plan`, { stages }, 'Payment plan saved');
          }}
        >
          {stages.map((s, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-4">
              <Input
                aria-label={`Stage ${i + 1} name`}
                value={s.name}
                onChange={(e) =>
                  setStages(stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
              <Input
                aria-label={`Stage ${i + 1} per cent`}
                value={s.pct}
                onChange={(e) =>
                  setStages(stages.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))
                }
              />
              <Select
                aria-label={`Stage ${i + 1} falls due`}
                value={s.trigger}
                onChange={(e) =>
                  setStages(stages.map((x, j) => (j === i ? { ...x, trigger: e.target.value } : x)))
                }
              >
                <option value="booking">On booking</option>
                <option value="agreement">On agreement</option>
                <option value="milestone">On a milestone</option>
              </Select>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setStages([...stages, { name: '', pct: '0', trigger: 'milestone', towerId: null }])
              }
            >
              Add a stage
            </Button>
            <Button type="submit">Save the plan</Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function ReraTab({ projectId, call }: { projectId: string; call: Call }) {
  const base = `/api/tenant/projects/${projectId}/sales/rera`;
  const q = useQuery({
    queryKey: ['sales', projectId, 'rera'],
    queryFn: () => api.request<Rera>(base),
  });
  const [dep, setDep] = useState({ on: today(), amount: '' });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const r = q.data;
  return (
    <Card title="RERA designated account">
      <dl className="grid gap-2 text-sm sm:grid-cols-5" data-testid="rera-figures">
        {(
          [
            ['Required (70% of receipts)', r.required],
            ['Deposited', r.deposited],
            ['Short', r.shortfall],
            ['Withdrawn', r.withdrawn],
            ['Balance', r.balance],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-fg-muted">{k}</dt>
            <dd className="font-medium">{formatInr(v)}</dd>
          </div>
        ))}
      </dl>
      <form
        aria-label="Deposit"
        className="mt-3 grid gap-3 sm:grid-cols-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call(base, { kind: 'deposit', ...dep }, 'Deposit recorded')) await q.refetch();
        }}
      >
        <Field label="Deposited on">
          <Input
            type="date"
            value={dep.on}
            onChange={(e) => setDep({ ...dep, on: e.target.value })}
          />
        </Field>
        <Field label="Deposit (₹)">
          <Input
            value={dep.amount}
            onChange={(e) => setDep({ ...dep, amount: e.target.value })}
            required
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Deposit</Button>
        </div>
      </form>
      <p className="mt-2 text-xs text-fg-muted">
        Withdrawals need the engineer's, architect's and CA's certificates (Forms 1, 2 and 3) and
        are limited to deposits × certified completion.
      </p>
      <Button
        type="button"
        variant="ghost"
        className="mt-2"
        onClick={async () => {
          const f = await api.download(
            `/api/tenant/projects/${projectId}/sales/quarter?upto=${today()}&format=xlsx`,
          );
          saveFile(f.blob, f.fileName);
        }}
      >
        Quarterly update (Excel)
      </Button>
    </Card>
  );
}

function Setup({ d, base, call }: { d: Overview; base: string; call: Call }) {
  const banks = useQuery({
    queryKey: ['sales', 'banks'],
    queryFn: () =>
      api.request<{ accounts: { id: string; code: string; name: string; kind: string }[] }>(
        '/api/tenant/accounts/chart',
      ),
    select: (r) => r.accounts.filter((a) => a.kind === 'bank'),
  });
  const [s, setS] = useState(d.setup);
  return (
    <Card title="Sales setup">
      <form
        aria-label="Sales setup"
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void call(`${base}/setup`, s, 'Sales setup saved');
        }}
      >
        <Field label="RERA registration">
          <Input
            value={s.reraNumber}
            onChange={(e) => setS({ ...s, reraNumber: e.target.value })}
          />
        </Field>
        <Field label="Collection account">
          <Select
            value={s.collectionAccountId ?? ''}
            onChange={(e) => setS({ ...s, collectionAccountId: e.target.value || null })}
          >
            <option value="">Choose…</option>
            {(banks.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Designated (RERA) account">
          <Select
            value={s.designatedAccountId ?? ''}
            onChange={(e) => setS({ ...s, designatedAccountId: e.target.value || null })}
          >
            <option value="">Choose…</option>
            {(banks.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Share to the designated account %">
          <Input value={s.sharePct} onChange={(e) => setS({ ...s, sharePct: e.target.value })} />
        </Field>
        <Field label="Interest on late payment % a year">
          <Input
            value={s.interestPct}
            onChange={(e) => setS({ ...s, interestPct: e.target.value })}
          />
        </Field>
        <Field label="Days to pay a demand">
          <Input
            type="number"
            value={s.payDays}
            onChange={(e) => setS({ ...s, payDays: Number(e.target.value) })}
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Card>
  );
}
