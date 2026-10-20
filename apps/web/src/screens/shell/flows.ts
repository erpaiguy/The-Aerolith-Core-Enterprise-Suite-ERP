// Process flows (docs/wave9-plan.md step 9a.7): the stages a document moves through, worked out from what its screen
// already has — a client's RA bill (measured, billed, certified, paid) and a flat's booking (agreement, demands,
// possession). A purchase's stages come from the server (/api/tenant/flows/purchase), which follows the links.

export type StepState = 'done' | 'current' | 'todo' | 'na';

export interface FlowDoc {
  id: string;
  number: string;
  /** Where it opens; none when it has no page of its own. */
  href: string | null;
  /** The document this page is about. */
  here?: boolean;
}

export interface FlowStep {
  key: string;
  label: string;
  state: StepState;
  /** The stage of the document this page is about. */
  here?: boolean;
  docs: FlowDoc[];
  /** Documents at this stage the person may not open. */
  hidden?: number;
  /** How several are counted, e.g. '{n} receipts'. */
  count?: string | undefined;
  /** A short fact, e.g. a date. */
  note?: string;
}

/**
 * Each stage's state from whether it applies and whether it is complete: complete ones are done, the first applicable
 * one not complete is where things stand, the rest are not yet. (The server works purchases out the same way.)
 */
export function stepStates(steps: { applies: boolean; complete: boolean }[]): StepState[] {
  let current = false;
  return steps.map((s) => {
    if (!s.applies) return 'na';
    if (s.complete) return 'done';
    if (current) return 'todo';
    current = true;
    return 'current';
  });
}

/** What the purchase stages are counted in when there are several. */
export const PURCHASE_COUNT: Record<string, string | undefined> = {
  requisition: '{n} requisitions',
  order: '{n} orders',
  receipt: '{n} receipts',
  bill: '{n} bills',
  payment: '{n} payment runs',
};

interface BillLike {
  id: string;
  raNo: number;
  status: 'draft' | 'pending' | 'submitted' | 'certified' | 'cancelled';
  project: { id: string };
  certified: { net: string } | null;
  receipts: { id: string; receivedOn: string; amount: string; voucher: string }[];
}

/** A client's RA bill: measured in the measurement book, billed, certified by the client, the money received. */
export function clientBillSteps(b: BillLike): FlowStep[] {
  const cancelled = b.status === 'cancelled';
  const received = b.receipts.reduce((s, r) => s + Number(r.amount), 0);
  const facts = [
    { applies: true, complete: true },
    { applies: !cancelled, complete: b.status === 'submitted' || b.status === 'certified' },
    { applies: !cancelled, complete: b.status === 'certified' },
    {
      applies: !cancelled,
      complete: !!b.certified && received > 0 && received >= Number(b.certified.net),
    },
  ];
  const [measured, billed, certified, paid] = stepStates(facts);
  return [
    {
      key: 'measurement',
      label: 'Measurement',
      state: measured!,
      docs: [{ id: 'mb', number: 'Measurement book', href: `/projects/${b.project.id}/progress` }],
    },
    {
      key: 'bill',
      label: 'RA bill',
      state: billed!,
      here: true,
      docs: [{ id: b.id, number: `RA bill ${b.raNo}`, href: null, here: true }],
    },
    { key: 'certified', label: 'Certified by the client', state: certified!, docs: [] },
    {
      key: 'received',
      label: 'Money received',
      state: paid!,
      count: '{n} receipts',
      docs: b.receipts.map((r) => ({
        id: r.id,
        number: r.voucher,
        href: `/accounts/client-receipts/${r.id}`,
      })),
    },
  ];
}

interface BookingLike {
  id: string;
  number: string;
  status: string;
  bookedOn: string;
  agreementOn: string | null;
  demands: { id: string; number: string }[];
  totals: { outstanding: string };
  cancelledOn: string | null;
  possessionOfferedOn: string | null;
  possessionOn: string | null;
}

/** A flat's booking: the agreement, the demands raised and paid, possession handed over. */
export function bookingSteps(b: BookingLike): FlowStep[] {
  const live = !b.cancelledOn && b.status !== 'cancelled';
  const facts = [
    { applies: true, complete: true },
    { applies: live, complete: !!b.agreementOn },
    {
      // All of it raised (the last stages at the offer of possession) and paid.
      applies: live,
      complete:
        !!b.possessionOfferedOn && b.demands.length > 0 && Number(b.totals.outstanding) <= 0,
    },
    { applies: live, complete: !!b.possessionOn },
  ];
  const [booked, agreed, demanded, handed] = stepStates(facts);
  return [
    {
      key: 'booking',
      label: 'Booking',
      state: booked!,
      here: true,
      note: b.bookedOn,
      docs: [{ id: b.id, number: b.number, href: null, here: true }],
    },
    {
      key: 'agreement',
      label: 'Agreement',
      state: agreed!,
      ...(b.agreementOn ? { note: b.agreementOn } : {}),
      docs: [],
    },
    {
      key: 'demands',
      label: 'Demands',
      state: demanded!,
      count: '{n} demands',
      docs: b.demands.map((d) => ({
        id: d.id,
        number: d.number,
        href: `/print/demands/${b.id}/${d.id}`,
      })),
    },
    {
      key: 'possession',
      label: 'Possession',
      state: handed!,
      ...(b.possessionOn
        ? { note: b.possessionOn }
        : b.possessionOfferedOn
          ? { note: `offered ${b.possessionOfferedOn}` }
          : {}),
      docs: [],
    },
  ];
}
